/**
 * Loads and validates an `emby init` configuration file.
 *
 * The file is JSON, optionally with `${ENV_VAR}` / `${ENV_VAR:-default}`
 * placeholders in **string** values. Placeholders are resolved against
 * `process.env` at load time; a missing variable with no default is a
 * hard error rather than a silent empty string — important because the
 * admin password lives here.
 *
 * Example:
 *
 *   {
 *     "adminUsername": "admin",
 *     "adminPassword": "${EMBY_ADMIN_PASSWORD}",
 *     "uiCulture": "en-US",
 *     "libraries": [
 *       { "name": "Movies",  "path": "/data/movies",  "collectionType": "movies" },
 *       { "name": "TV",      "path": "/data/tv",      "collectionType": "tvshows" }
 *     ],
 *     "apiKeys": ["my-app", "another-integration"],
 *     "premiereKey": "${EMBY_PREMIERE_KEY}",
 *     "plugins": [
 *       { "name": "Trakt" },
 *       { "name": "TVHeadEnd", "version": "1.2.3", "updateClass": "Release" }
 *     ],
 *     "restartAfterPlugins": true
 *   }
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { InitOptions } from "./init.js";

/** Zod schema for the public config file shape. */
const LibrarySchema = z
  .object({
    name: z.string().min(1, "library name must not be empty"),
    path: z.string().min(1, "library path must not be empty"),
    collectionType: z.string().optional(),
  })
  .strict();

/** Schema for one entry in `plugins`. */
const PluginSchema = z
  .object({
    name: z.string().min(1, "plugin name must not be empty"),
    /** Optional exact version. Omit to track whatever is latest in the update class. */
    version: z.string().min(1, "plugin version must not be empty").optional(),
    updateClass: z.enum(["Release", "Beta", "Dev"]).optional(),
    /** Optional assembly GUID for disambiguating duplicate package names. */
    assemblyGuid: z.string().min(1, "plugin assemblyGuid must not be empty").optional(),
  })
  .strict();

const InitConfigSchema = z
  .object({
    adminUsername: z.string().min(1),
    adminPassword: z.string().min(1),
    uiCulture: z.string().optional(),
    metadataCountry: z.string().optional(),
    metadataLanguage: z.string().optional(),
    libraries: z.array(LibrarySchema).optional(),
    /**
     * API key "App" labels to create. Idempotent: if a key with the given
     * label already exists it is reused rather than duplicated.
     */
    apiKeys: z.array(z.string().min(1, "apiKeys entries must not be empty")).optional(),
    /**
     * Emby Premiere (supporter) key to register with the server. Idempotent:
     * if the server already has this key set we skip the registration call.
     */
    premiereKey: z.string().min(1, "premiereKey must not be empty").optional(),
    /**
     * Plugins to install. Identity is by `name`; already-installed plugins
     * at the requested (or any, when `version` is omitted) version are
     * left alone.
     */
    plugins: z.array(PluginSchema).optional(),
    /**
     * When true AND at least one plugin was newly installed/upgraded,
     * POST /System/Restart at the end of the run. Default false.
     */
    restartAfterPlugins: z.boolean().optional(),
    /** Max time (ms) to wait for each plugin to appear in /Plugins. */
    pluginInstallTimeoutMs: z
      .number()
      .int()
      .positive("pluginInstallTimeoutMs must be > 0")
      .optional(),
    /** Poll interval (ms) while waiting. */
    pluginInstallPollIntervalMs: z
      .number()
      .int()
      .positive("pluginInstallPollIntervalMs must be > 0")
      .optional(),
    requireFresh: z.boolean().optional(),
    refreshLibraries: z.boolean().optional(),
  })
  .strict();

export type InitConfig = z.infer<typeof InitConfigSchema>;

/** Raised when the file exists but parsing / validation fails. */
export class InitConfigError extends Error {
  constructor(
    message: string,
    /** Original underlying cause, if any. */
    public override cause?: unknown
  ) {
    super(message);
    this.name = "InitConfigError";
  }
}

/**
 * Interpolate `${VAR}` and `${VAR:-default}` placeholders anywhere inside
 * a parsed JSON tree. Mutates the tree in place and returns it.
 */
export function interpolateEnv(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  path: string[] = []
): unknown {
  if (typeof value === "string") return interpolateString(value, env, path.join("."));
  if (Array.isArray(value)) {
    return value.map((v, i) => interpolateEnv(v, env, [...path, String(i)]));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateEnv(v, env, [...path, k]);
    }
    return out;
  }
  return value;
}

/**
 * Resolve placeholders in a single string. Supports:
 *   ${VAR}           - fails if VAR is unset
 *   ${VAR:-default}  - uses `default` if VAR is unset or empty
 *
 * `$$` is the escape for a literal `$`. `${` not followed by a valid name
 * is left untouched.
 */
function interpolateString(input: string, env: NodeJS.ProcessEnv, locationHint: string): string {
  // Handle the escape first so subsequent regex matches ignore it.
  const ESC = "\u0000__EMBY_DOLLAR__\u0000";
  let working = input.replace(/\$\$/g, ESC);
  working = working.replace(
    /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi,
    (match, name: string, defaultValue: string | undefined) => {
      const v = env[name];
      if (v !== undefined && v !== "") return v;
      if (defaultValue !== undefined) return defaultValue;
      throw new InitConfigError(
        `Missing required environment variable '${name}' referenced by config field '${
          locationHint || "(root)"
        }'. Set the env var or provide a default with \${${name}:-...}.`
      );
    }
  );
  return working.replace(new RegExp(ESC, "g"), "$");
}

/** Load, interpolate, and validate an init config file. */
export function loadInitConfig(filePath: string, env: NodeJS.ProcessEnv = process.env): InitConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new InitConfigError(`Unable to read init config '${filePath}'`, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InitConfigError(`Init config '${filePath}' is not valid JSON`, err);
  }

  const interpolated = interpolateEnv(parsed, env);

  const result = InitConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new InitConfigError(
      `Init config '${filePath}' failed validation:\n${issues}`,
      result.error
    );
  }
  return result.data;
}

/** Adapt a validated config to the `runInit(InitOptions)` shape. */
export function toInitOptions(config: InitConfig): InitOptions {
  return {
    adminUsername: config.adminUsername,
    adminPassword: config.adminPassword,
    uiCulture: config.uiCulture,
    metadataCountry: config.metadataCountry,
    metadataLanguage: config.metadataLanguage,
    libraries: config.libraries,
    apiKeys: config.apiKeys,
    premiereKey: config.premiereKey,
    plugins: config.plugins,
    restartAfterPlugins: config.restartAfterPlugins,
    pluginInstallTimeoutMs: config.pluginInstallTimeoutMs,
    pluginInstallPollIntervalMs: config.pluginInstallPollIntervalMs,
    requireFresh: config.requireFresh,
    refreshLibraries: config.refreshLibraries,
  };
}
