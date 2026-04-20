/**
 * Orchestrates a complete first-run setup of an Emby server.
 *
 * The flow is:
 *   1. If the wizard is already complete, skip it unless `requireFresh` is set.
 *   2. POST /Startup/Configuration with locale + metadata prefs.
 *   3. POST /Startup/User with the admin credentials.
 *   4. POST /Startup/Complete.
 *   5. Log in as the new admin to obtain an access token.
 *   6. Add every requested library, skipping ones that already exist.
 *   7. Create every requested API key (by `App` label), skipping names that
 *      already exist (the existing key's token is returned instead).
 *   8. Register the Emby Premiere (supporter) key, if supplied, skipping
 *      when the server already reports the same `SupporterKey`.
 *   9. Install every requested plugin, upgrading/downgrading when the
 *      installed version differs from the one in the spec. Optionally
 *      restart the server at the end when at least one plugin was
 *      queued (`restartAfterPlugins`).
 *
 * Idempotency guarantees:
 *   - Wizard: skipped on re-runs.
 *   - Libraries: those with a matching name AND matching path/collectionType
 *     are left untouched. Drift (same name, different path or different
 *     collection type) raises `InitLibraryDriftError` before any mutation
 *     so the operator can reconcile by hand.
 *   - API keys: keys are identified by their `App` label. If a key with
 *     that label already exists, its token is reused; otherwise a new key
 *     is created. Emby itself permits duplicate labels; we don't.
 *   - Premiere key: read current `ServerConfiguration.SupporterKey`; if it
 *     already matches the desired value we report `skipped`, otherwise we
 *     POST to `/Registrations/RegKey` and record `updated`.
 *   - Plugins: identified by Name. Already-installed plugins are reused
 *     (`skipped`); a mismatched Version triggers a re-install (`upgraded`).
 *     We wait for each install to appear in /Plugins before moving on.
 */
import { EmbyClient, isAxiosError, StartupAlreadyCompletedError } from "@emby-utils/client";
import {
  DEFAULT_INSTALL_POLL_INTERVAL_MS,
  DEFAULT_INSTALL_TIMEOUT_MS,
  reconcilePlugins,
  type PluginOutcome,
  type PluginSpec,
} from "./plugins.js";

export interface LibrarySpec {
  name: string;
  path: string;
  collectionType?: string;
}

export interface InitOptions {
  /** Admin username to create (or confirm exists, when wizard is skipped). */
  adminUsername: string;
  /** Admin password. */
  adminPassword: string;
  /** UI culture tag, e.g. `en-US`. */
  uiCulture?: string;
  /** Metadata country code, e.g. `US`. */
  metadataCountry?: string;
  /** Preferred metadata language, e.g. `en`. */
  metadataLanguage?: string;
  /** Libraries to add. Existing libraries (by name) are left alone. */
  libraries?: LibrarySpec[];
  /**
   * API key "App" labels to create. If a key already exists for a given
   * label, its existing token is reused instead of creating a duplicate.
   */
  apiKeys?: string[];
  /**
   * Emby Premiere (supporter) key to register with the server. Idempotent:
   * when the server already reports this value as its `SupporterKey`, no
   * registration request is sent.
   */
  premiereKey?: string;
  /**
   * Plugins to install. Identified by Name; already-installed plugins at a
   * matching (or unspecified) version are skipped.
   */
  plugins?: PluginSpec[];
  /**
   * When true AND at least one plugin was newly installed or upgraded,
   * POST /System/Restart at the end of the run. Defaults to false.
   */
  restartAfterPlugins?: boolean;
  /** Max time (ms) to wait for each plugin to appear in /Plugins. Default 120 000. */
  pluginInstallTimeoutMs?: number;
  /** Poll interval (ms) when waiting for a plugin to install. Default 2000. */
  pluginInstallPollIntervalMs?: number;
  /** If true, fail when the wizard has already been completed. */
  requireFresh?: boolean;
  /** Trigger a library scan after adding a library. Default: false. */
  refreshLibraries?: boolean;
}

/** An API key entry as surfaced to callers of `runInit`. */
export interface ApiKeyRecord {
  /** The `App` label identifying the key. */
  app: string;
  /** The opaque token value. */
  token: string;
}

/** Outcome of the premiere-key reconciliation step. */
export type PremiereKeyStatus =
  /** No premiere key was requested. */
  | { requested: false }
  /** Server already had this key set; no request made. */
  | { requested: true; updated: false; skipped: true }
  /** Server had no key or a different one; registration request sent. */
  | { requested: true; updated: true; skipped: false };

export interface InitResult {
  /** Whether the wizard was run (false = already initialized). */
  wizardRan: boolean;
  /** The access token minted for the admin user. */
  accessToken: string;
  /** Libraries that were newly created. */
  librariesCreated: string[];
  /** Libraries that already existed and were left untouched. */
  librariesSkipped: string[];
  /** API keys that were newly minted during this run. */
  apiKeysCreated: ApiKeyRecord[];
  /** API keys that already existed and were reused as-is. */
  apiKeysSkipped: ApiKeyRecord[];
  /** Premiere-key reconciliation outcome. */
  premiereKey: PremiereKeyStatus;
  /** One outcome per requested plugin, in input order. */
  plugins: PluginOutcome[];
  /** Whether we issued POST /System/Restart at the end of the run. */
  serverRestarted: boolean;
}

/** Raised when a library name exists but its path or collectionType differs. */
export class InitLibraryDriftError extends Error {
  constructor(
    message: string,
    /** Per-library mismatches, one entry per drifted library. */
    public readonly drifts: Array<{
      name: string;
      desired: { path: string; collectionType?: string };
      actual: { path: string | undefined; collectionType: string | undefined };
    }>
  ) {
    super(message);
    this.name = "InitLibraryDriftError";
  }
}

/** Raised when the wizard was already completed under a different admin password. */
export class InitAuthMismatchError extends Error {
  constructor(username: string) {
    super(
      `Emby server is already initialized, but the configured admin credentials ` +
        `for '${username}' were rejected (HTTP 401). Either rerun with the correct ` +
        `password or reset the Emby server (delete its config volume) to re-run the wizard.`
    );
    this.name = "InitAuthMismatchError";
  }
}

/**
 * Parse one `--library` flag value of the form:
 *   Name=/abs/path
 *   Name=/abs/path:collectionType
 *
 * A `:` inside the path is supported: the collectionType is always the
 * rightmost segment and must match a short identifier (no slashes).
 */
export function parseLibraryFlag(raw: string): LibrarySpec {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(`Invalid --library value '${raw}'. Expected: Name=/abs/path[:collectionType]`);
  }
  const name = raw.slice(0, eq).trim();
  const rest = raw.slice(eq + 1).trim();
  if (!name || !rest) {
    throw new Error(`Invalid --library value '${raw}'. Expected: Name=/abs/path[:collectionType]`);
  }
  // Split off a trailing `:<collectionType>` that does not contain `/`.
  const colon = rest.lastIndexOf(":");
  if (colon > 0 && !rest.slice(colon + 1).includes("/")) {
    const ct = rest.slice(colon + 1).trim();
    const path = rest.slice(0, colon).trim();
    if (ct && path) return { name, path, collectionType: ct };
  }
  return { name, path: rest };
}

export async function runInit(client: EmbyClient, opts: InitOptions): Promise<InitResult> {
  const alreadyInitialized = await client.isStartupComplete();

  if (alreadyInitialized && opts.requireFresh) {
    throw new Error(
      "Emby server has already been initialized. Pass --no-require-fresh (or omit --require-fresh) to add libraries against an existing server."
    );
  }

  let wizardRan = false;
  if (!alreadyInitialized) {
    try {
      await client.postStartupConfiguration({
        UICulture: opts.uiCulture ?? "en-US",
        MetadataCountryCode: opts.metadataCountry ?? "US",
        PreferredMetadataLanguage: opts.metadataLanguage ?? "en",
      });
      await client.postStartupUser({
        Name: opts.adminUsername,
        Password: opts.adminPassword,
      });
      await client.postStartupComplete();
      wizardRan = true;
    } catch (err) {
      if (err instanceof StartupAlreadyCompletedError) {
        // Race: someone else finished the wizard between our check and our POST.
        // Treat as a skipped wizard.
      } else {
        throw err;
      }
    }
  }

  // Log in as the admin so we have a token for authenticated calls.
  // When the wizard was already complete, a 401 here means the caller's
  // password does not match the admin that was created earlier.
  let AccessToken: string;
  try {
    const loginRes = await client.loginWithPassword({
      username: opts.adminUsername,
      password: opts.adminPassword,
    });
    AccessToken = loginRes.AccessToken;
  } catch (err) {
    if (alreadyInitialized && isAxiosError(err) && err.response?.status === 401) {
      throw new InitAuthMismatchError(opts.adminUsername);
    }
    throw err;
  }

  // Desired-state check: verify every requested library either does not
  // exist yet OR already exists with the exact same path / collectionType.
  // Any drift aborts the run before we mutate anything.
  const libs = opts.libraries ?? [];
  if (libs.length > 0) {
    const existing = await client.callOperation<"getLibraryVirtualfolders">(
      "getLibraryVirtualfolders"
    );
    const drifts: InitLibraryDriftError["drifts"] = [];
    for (const lib of libs) {
      const match = existing.find((e) => e.Name === lib.name);
      if (!match) continue;
      const actualPath = match.Locations?.[0];
      const actualCollectionType = match.CollectionType;
      const pathDiffers = actualPath !== lib.path;
      const collectionTypeDiffers =
        lib.collectionType !== undefined && actualCollectionType !== lib.collectionType;
      if (pathDiffers || collectionTypeDiffers) {
        drifts.push({
          name: lib.name,
          desired: { path: lib.path, collectionType: lib.collectionType },
          actual: { path: actualPath, collectionType: actualCollectionType },
        });
      }
    }
    if (drifts.length > 0) {
      const detail = drifts
        .map((d) => {
          const parts = [`  - '${d.name}':`];
          if (d.desired.path !== d.actual.path) {
            parts.push(`path desired='${d.desired.path}' actual='${d.actual.path ?? "(none)"}'`);
          }
          if (
            d.desired.collectionType !== undefined &&
            d.desired.collectionType !== d.actual.collectionType
          ) {
            parts.push(
              `collectionType desired='${d.desired.collectionType}' actual='${
                d.actual.collectionType ?? "(none)"
              }'`
            );
          }
          return parts.join(" ");
        })
        .join("\n");
      throw new InitLibraryDriftError(
        `Refusing to reconcile library drift automatically. The following libraries ` +
          `already exist with a different path or collection type:\n${detail}\n` +
          `Rename them in the config, or delete the drifted libraries in Emby first.`,
        drifts
      );
    }
  }

  const created: string[] = [];
  const skipped: string[] = [];
  for (const lib of libs) {
    const res = await client.addLibrary({
      name: lib.name,
      path: lib.path,
      collectionType: lib.collectionType,
      refreshLibrary: opts.refreshLibraries,
    });
    if (res.created) created.push(lib.name);
    else skipped.push(lib.name);
  }

  // API key reconciliation. Identified by the `App` label: matching label =>
  // reuse the existing token; otherwise mint a fresh one. Emby permits
  // duplicate labels; we always return the first match (Emby's own ordering)
  // and never create a second.
  const apiKeysCreated: ApiKeyRecord[] = [];
  const apiKeysSkipped: ApiKeyRecord[] = [];
  const apiKeyLabels = opts.apiKeys ?? [];
  if (apiKeyLabels.length > 0) {
    const existingByApp = await listExistingApiKeys(client);
    for (const app of apiKeyLabels) {
      const existing = existingByApp.get(app);
      if (existing) {
        apiKeysSkipped.push({ app, token: existing });
        continue;
      }
      // `postAuthKeys` returns 204 No Content: the new key is not in the
      // response, so we re-list and find the one with this App label.
      await client.callOperation("postAuthKeys", { queryParams: { App: app } });
      const refreshed = await listExistingApiKeys(client);
      const token = refreshed.get(app);
      if (!token) {
        throw new Error(
          `Emby accepted postAuthKeys for App='${app}' but the new key is not visible in /Auth/Keys.`
        );
      }
      apiKeysCreated.push({ app, token });
      // Keep our local view consistent for any subsequent labels in the loop.
      existingByApp.set(app, token);
    }
  }

  // Emby Premiere (supporter) key reconciliation. If the caller supplied a
  // `premiereKey`, read the current SupporterKey from /System/Configuration
  // and only POST /Registrations/RegKey when it differs. Emby's registration
  // endpoint both validates the key online AND writes it back into
  // ServerConfiguration.SupporterKey, so the read-after-write loop is
  // consistent on a second run.
  let premiereKey: PremiereKeyStatus = { requested: false };
  if (opts.premiereKey !== undefined && opts.premiereKey.length > 0) {
    const current = await readSupporterKey(client);
    if (current === opts.premiereKey) {
      premiereKey = { requested: true, updated: false, skipped: true };
    } else {
      await registerPremiereKey(client, opts.premiereKey);
      premiereKey = { requested: true, updated: true, skipped: false };
    }
  }

  // Plugin reconciliation. Identity by Name; Version mismatch forces a
  // re-install (Emby treats that as an upgrade/downgrade). Each install
  // is confirmed by polling /Plugins until the plugin (or the requested
  // Version) appears, so the caller's result reflects real server state.
  const pluginSpecs = opts.plugins ?? [];
  let pluginOutcomes: PluginOutcome[] = [];
  let serverRestarted = false;
  if (pluginSpecs.length > 0) {
    const reconcile = await reconcilePlugins(client, pluginSpecs, {
      installTimeoutMs: opts.pluginInstallTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
      installPollIntervalMs: opts.pluginInstallPollIntervalMs ?? DEFAULT_INSTALL_POLL_INTERVAL_MS,
    });
    pluginOutcomes = reconcile.outcomes;
    if (opts.restartAfterPlugins && reconcile.anyInstalled) {
      // Emby's restart endpoint is fire-and-forget: the server drops the
      // connection as it shuts down. We don't wait for it to come back
      // up — callers can re-run this function or poll /System/Ping.
      await client.callOperation("postSystemRestart");
      serverRestarted = true;
    }
  }

  return {
    wizardRan,
    accessToken: AccessToken,
    librariesCreated: created,
    librariesSkipped: skipped,
    apiKeysCreated,
    apiKeysSkipped,
    premiereKey,
    plugins: pluginOutcomes,
    serverRestarted,
  };
}

/**
 * Fetch existing API keys and return a Map keyed by the `AppName` label.
 * Emby returns either an array or a `{Items: [...]}` paged envelope
 * depending on version; we handle both.
 */
async function listExistingApiKeys(client: EmbyClient): Promise<Map<string, string>> {
  const raw = await client.callOperation<"getAuthKeys", unknown>("getAuthKeys");
  const items = extractApiKeyItems(raw);
  const out = new Map<string, string>();
  for (const item of items) {
    if (typeof item.AppName === "string" && typeof item.AccessToken === "string") {
      // First wins; don't clobber earlier keys with later duplicates.
      if (!out.has(item.AppName)) out.set(item.AppName, item.AccessToken);
    }
  }
  return out;
}

interface AuthKeyDto {
  AccessToken?: string;
  AppName?: string;
}

function extractApiKeyItems(raw: unknown): AuthKeyDto[] {
  if (Array.isArray(raw)) return raw as AuthKeyDto[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { Items?: unknown }).Items)) {
    return (raw as { Items: AuthKeyDto[] }).Items;
  }
  return [];
}

/**
 * Read the current Emby Premiere (supporter) key from the server's
 * configuration. Returns the string if present, or `undefined` when the
 * server has no key set or when the field is missing on older Emby
 * versions.
 */
export async function readSupporterKey(client: EmbyClient): Promise<string | undefined> {
  const cfg = await client.callOperation<"getSystemConfiguration", unknown>(
    "getSystemConfiguration"
  );
  if (cfg && typeof cfg === "object") {
    const raw = (cfg as { SupporterKey?: unknown }).SupporterKey;
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return undefined;
}

/**
 * Register an Emby Premiere (supporter) key with the server. Emby's
 * `/Registrations/RegKey` endpoint validates the key against their license
 * service and, on success, persists it into `ServerConfiguration.SupporterKey`.
 * A 4xx response means the key was rejected — we let the raw error propagate
 * so callers can distinguish "bad key" from "network blip".
 */
export async function registerPremiereKey(client: EmbyClient, key: string): Promise<void> {
  // Emby accepts the key as a JSON body (`{ MbKey: "<key>" }`) on modern
  // versions; older versions also accept form-urlencoded. We send JSON and
  // let the server negotiate. If a specific deployment rejects JSON, the
  // raw post() escape hatch can be used directly.
  await client.post("/Registrations/RegKey", { MbKey: key });
}
