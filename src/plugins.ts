/**
 * Helpers for installing and uninstalling Emby plugins.
 *
 * Emby plugin installs are asynchronous: `POST /Packages/Installed/{Name}`
 * only *queues* the install. The plugin only becomes visible in
 * `GET /Plugins` after Emby completes the download + extraction. We
 * therefore poll `/Plugins` until the plugin appears (or the configured
 * timeout elapses). For version upgrades we re-POST and then wait until
 * the Version field reflects the requested value.
 *
 * Identity is by `Name` (Emby's human-readable package / plugin name).
 * When multiple packages share a name, pass an `assemblyGuid` to
 * disambiguate; Emby uses it as the authoritative install key.
 */
import type { EmbyClient } from "@emby-utils/client";

/** Spec for one plugin to install. */
export interface PluginSpec {
  /** Emby package name (matches `/Packages/Installed/{Name}` and `PluginInfo.Name`). */
  name: string;
  /** Optional exact version. If unset, Emby installs the latest of the update class. */
  version?: string;
  /** Optional release channel. Default: `Release`. */
  updateClass?: "Release" | "Beta" | "Dev";
  /** Optional assembly GUID, used to disambiguate packages with duplicate names. */
  assemblyGuid?: string;
}

/** Outcome of a single plugin reconciliation. */
export interface PluginOutcome {
  name: string;
  /** Installed version after the operation (undefined if Emby didn't return one). */
  version?: string;
  /** Emby plugin `Id` (the authoritative identifier post-install). */
  id?: string;
  /** What happened for this plugin. */
  status: "installed" | "upgraded" | "skipped";
}

/** Options accepted by `reconcilePlugins`. */
export interface ReconcilePluginsOptions {
  /** Max time (ms) to wait for each plugin to appear in `/Plugins`. Default 120_000. */
  installTimeoutMs?: number;
  /** Poll interval (ms). Default 2000. */
  installPollIntervalMs?: number;
}

export const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
export const DEFAULT_INSTALL_POLL_INTERVAL_MS = 2000;

/** Raised when a plugin does not become visible in /Plugins within the timeout. */
export class PluginInstallTimeoutError extends Error {
  constructor(
    public readonly pluginName: string,
    public readonly timeoutMs: number,
    /** Most recent list of plugins observed during polling. */
    public readonly lastSeenPlugins: MinimalPluginInfo[]
  ) {
    super(
      `Timed out after ${timeoutMs}ms waiting for Emby plugin '${pluginName}' to finish installing. ` +
        `It may still install eventually; re-run when the server has settled to verify.`
    );
    this.name = "PluginInstallTimeoutError";
  }
}

/** Raised when `emby plugins uninstall` is asked to remove an unknown plugin by Name. */
export class PluginNotFoundError extends Error {
  constructor(public readonly pluginName: string) {
    super(
      `No installed plugin matches Name='${pluginName}'. ` +
        `Pass the plugin's Id instead, or check 'emby plugins list'.`
    );
    this.name = "PluginNotFoundError";
  }
}

/** Narrow interface over `PluginInfo` with the fields we rely on. */
export interface MinimalPluginInfo {
  Name?: string;
  Version?: string;
  Id?: string;
  [key: string]: unknown;
}

/**
 * Reconcile a desired list of plugins against the server. For each spec:
 *
 *   - If not installed: POST install, then wait until it appears in /Plugins.
 *     Status: `installed`.
 *   - If installed with the same (or unspecified) version: no-op. Status: `skipped`.
 *   - If installed with a different version than requested: POST install again
 *     (Emby treats this as an upgrade/downgrade), then wait until Version
 *     reflects the requested value. Status: `upgraded`.
 *
 * Returns one `PluginOutcome` per spec, preserving input order. The boolean
 * `anyInstalled` is convenient for deciding whether to POST a server restart.
 */
export async function reconcilePlugins(
  client: EmbyClient,
  specs: PluginSpec[],
  options: ReconcilePluginsOptions = {}
): Promise<{ outcomes: PluginOutcome[]; anyInstalled: boolean }> {
  const timeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const pollMs = options.installPollIntervalMs ?? DEFAULT_INSTALL_POLL_INTERVAL_MS;
  const outcomes: PluginOutcome[] = [];
  let anyInstalled = false;

  // Snapshot once; refresh after each mutation so concurrent CLI runs
  // against the same server still converge.
  let installed = await listPlugins(client);

  for (const spec of specs) {
    const existing = installed.find((p) => p.Name === spec.name);
    if (!existing) {
      await postInstall(client, spec);
      const appeared = await waitForPlugin(
        client,
        (ps) => ps.find((p) => p.Name === spec.name),
        timeoutMs,
        pollMs,
        spec.name
      );
      installed = await listPlugins(client);
      anyInstalled = true;
      outcomes.push({
        name: spec.name,
        version: appeared.Version,
        id: appeared.Id,
        status: "installed",
      });
      continue;
    }

    if (spec.version !== undefined && existing.Version !== spec.version) {
      // Re-install to upgrade/downgrade to the requested version.
      await postInstall(client, spec);
      const upgraded = await waitForPlugin(
        client,
        (ps) => ps.find((p) => p.Name === spec.name && p.Version === spec.version),
        timeoutMs,
        pollMs,
        spec.name
      );
      installed = await listPlugins(client);
      anyInstalled = true;
      outcomes.push({
        name: spec.name,
        version: upgraded.Version,
        id: upgraded.Id,
        status: "upgraded",
      });
      continue;
    }

    // Already installed at an acceptable version.
    outcomes.push({
      name: spec.name,
      version: existing.Version,
      id: existing.Id,
      status: "skipped",
    });
  }

  return { outcomes, anyInstalled };
}

/** POST /Packages/Installed/{Name} with the appropriate query params. */
async function postInstall(client: EmbyClient, spec: PluginSpec): Promise<void> {
  const queryParams: Record<string, string> = {};
  if (spec.version !== undefined) queryParams.Version = spec.version;
  if (spec.updateClass !== undefined) queryParams.UpdateClass = spec.updateClass;
  if (spec.assemblyGuid !== undefined) queryParams.AssemblyGuid = spec.assemblyGuid;
  await client.callOperation("postPackagesInstalledByName", {
    pathParams: { Name: spec.name },
    queryParams,
  });
}

/** GET /Plugins as a narrow array. */
export async function listPlugins(client: EmbyClient): Promise<MinimalPluginInfo[]> {
  const raw = await client.callOperation<"getPlugins">("getPlugins");
  return Array.isArray(raw) ? (raw as MinimalPluginInfo[]) : [];
}

/**
 * Poll `/Plugins` until `predicate` returns a plugin, or throw
 * `PluginInstallTimeoutError` after `timeoutMs`. Returns the matched
 * plugin's info.
 */
async function waitForPlugin(
  client: EmbyClient,
  predicate: (ps: MinimalPluginInfo[]) => MinimalPluginInfo | undefined,
  timeoutMs: number,
  pollMs: number,
  pluginName: string
): Promise<MinimalPluginInfo> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: MinimalPluginInfo[] = [];
  // First check immediately (tests and fast servers both benefit).
  lastSeen = await listPlugins(client);
  const first = predicate(lastSeen);
  if (first) return first;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    lastSeen = await listPlugins(client);
    const match = predicate(lastSeen);
    if (match) return match;
  }
  throw new PluginInstallTimeoutError(pluginName, timeoutMs, lastSeen);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve a plugin identifier that may be either an Emby `Id` (GUID-ish)
 * or a plugin `Name`. Returns the `Id` to pass to `deletePluginsById`, or
 * throws `PluginNotFoundError` when no installed plugin matches by Name
 * and the input does not look like an existing Id either.
 */
export async function resolvePluginId(client: EmbyClient, idOrName: string): Promise<string> {
  const installed = await listPlugins(client);
  const byId = installed.find((p) => p.Id === idOrName);
  if (byId?.Id) return byId.Id;
  const byName = installed.find((p) => p.Name === idOrName);
  if (byName?.Id) return byName.Id;
  throw new PluginNotFoundError(idOrName);
}

/** Uninstall by Emby plugin Id. No-op semantics belong to the caller. */
export async function uninstallPlugin(client: EmbyClient, pluginId: string): Promise<void> {
  await client.callOperation("deletePluginsById", { pathParams: { Id: pluginId } });
}
