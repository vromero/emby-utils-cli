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
 *
 * Idempotency guarantees:
 *   - Wizard: skipped on re-runs.
 *   - Libraries: those with a matching name AND matching path/collectionType
 *     are left untouched. Drift (same name, different path or different
 *     collection type) raises `InitLibraryDriftError` before any mutation
 *     so the operator can reconcile by hand.
 */
import { EmbyClient, isAxiosError, StartupAlreadyCompletedError } from "@emby-utils/client";

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
  /** If true, fail when the wizard has already been completed. */
  requireFresh?: boolean;
  /** Trigger a library scan after adding a library. Default: false. */
  refreshLibraries?: boolean;
}

export interface InitResult {
  /** Whether the wizard was run (false = already initialized). */
  wizardRan: boolean;
  /** The access token minted for the admin user. */
  accessToken: string;
  /** Libraries that were newly created. */
  librariesCreated: string[];
  /** Libraries that already existed and were left untouched. */
  librariesSkipped: string[];
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

  return {
    wizardRan,
    accessToken: AccessToken,
    librariesCreated: created,
    librariesSkipped: skipped,
  };
}
