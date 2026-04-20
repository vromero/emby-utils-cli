import { Command } from "commander";
import { createRequire } from "node:module";
import { EmbyClient } from "@emby-utils/client";
import { formatOutput, OutputFormat } from "./format.js";
import { readSupporterKey, registerPremiereKey, runInit } from "./init.js";
import { loadInitConfig, toInitOptions } from "./init-config.js";
import {
  DEFAULT_INSTALL_POLL_INTERVAL_MS,
  DEFAULT_INSTALL_TIMEOUT_MS,
  reconcilePlugins,
  resolvePluginId,
  uninstallPlugin,
  PluginNotFoundError,
} from "./plugins.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** How results are emitted. Overridable so tests can capture output. */
export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Called by commands that would terminate the process on error. */
  exit: (code: number) => void;
}

const defaultIO: CliIO = {
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
  exit: (code) => process.exit(code),
};

export interface CliConfig {
  /** Override the EmbyClient used by commands. Primarily for tests. */
  clientFactory?: (host: string, apiKey: string) => EmbyClient;
  io?: Partial<CliIO>;
}

function resolveClient(
  cmd: Command,
  factory: (host: string, apiKey: string) => EmbyClient,
  io: CliIO
): EmbyClient | null {
  const opts = cmd.optsWithGlobals();
  const host = opts.host || process.env.EMBY_HOST;
  const apiKey = opts.apiKey || process.env.EMBY_API_KEY;
  if (!host || !apiKey) {
    io.stderr(
      "Error: Emby host and API key required. Provide --host / --api-key or set EMBY_HOST / EMBY_API_KEY."
    );
    io.exit(2);
    return null;
  }
  return factory(host, apiKey);
}

/** Wrap a command action so unhandled errors become a CLI error exit. */
function wrap<TArgs extends unknown[]>(io: CliIO, fn: (...args: TArgs) => Promise<void>) {
  return async (...args: TArgs) => {
    try {
      await fn(...args);
    } catch (err: any) {
      const msg = err?.response?.data
        ? `${err.message}\n${JSON.stringify(err.response.data, null, 2)}`
        : (err?.message ?? String(err));
      io.stderr(`Error: ${msg}`);
      io.exit(1);
    }
  };
}

function emit(io: CliIO, program: Command, data: unknown): void {
  const opts = program.opts();
  const format = ((opts.format as string | undefined) ?? "json").toLowerCase() as OutputFormat;
  const columns =
    typeof opts.columns === "string" && opts.columns.length > 0
      ? opts.columns.split(",").map((s: string) => s.trim())
      : undefined;
  io.stdout(formatOutput(data, format, { columns }));
}

/**
 * Build the `emby` CLI program. Exported as a function so tests can
 * instantiate an instance with mocked IO and a fake client.
 */
export function buildCli(config: CliConfig = {}): Command {
  const io: CliIO = { ...defaultIO, ...(config.io ?? {}) };
  const factory = config.clientFactory ?? ((host, apiKey) => new EmbyClient(host, apiKey));

  const program = new Command();
  program
    .name("emby")
    .description("Semantic CLI for the Emby REST API.")
    .version(pkg.version)
    .option("--host <url>", "Emby server URL (fallback: EMBY_HOST env)")
    .option("--api-key <key>", "Emby API key (fallback: EMBY_API_KEY env)")
    .option("--format <format>", "Output format: json (default), yaml, table", "json")
    .option("--columns <list>", "Comma-separated column list (table format only)");

  // --- `emby init` ---
  //
  // Config is supplied via a JSON file. `${VAR}` placeholders are expanded
  // from the environment at load time so secrets (admin password, API keys)
  // can live outside the file.
  program
    .command("init")
    .description(
      "Initialize a fresh Emby server from a JSON config file: run the first-run wizard (creating the admin user) and add libraries. Idempotent: on an already-initialized server, only missing libraries are added."
    )
    .requiredOption(
      "--config <path>",
      "Path to a JSON config file describing the admin user and libraries"
    )
    .action(
      wrap(io, async (opts: { config: string }) => {
        const globals = program.opts();
        const host = (globals.host as string | undefined) ?? process.env.EMBY_HOST;
        if (!host) {
          io.stderr("Error: --host or EMBY_HOST env required for init.");
          io.exit(2);
          return;
        }
        const config = loadInitConfig(opts.config);
        const client = factory(host, "");
        const result = await runInit(client, toInitOptions(config));
        emit(io, program, {
          wizardRan: result.wizardRan,
          accessToken: result.accessToken,
          librariesCreated: result.librariesCreated,
          librariesSkipped: result.librariesSkipped,
          apiKeysCreated: result.apiKeysCreated,
          apiKeysSkipped: result.apiKeysSkipped,
          premiereKey: result.premiereKey,
          plugins: result.plugins,
          serverRestarted: result.serverRestarted,
        });
      })
    );

  // --- `emby login` ---
  program
    .command("login")
    .description(
      "Authenticate with username/password and print the returned access token. Usage: `export EMBY_API_KEY=$(emby login ...)`"
    )
    .requiredOption("--username <name>", "Emby username")
    .requiredOption("--password <pass>", "Emby password")
    .action(
      wrap(io, async (opts: { username: string; password: string }) => {
        const optsWithGlobals = program.opts();
        const host = (optsWithGlobals.host as string | undefined) ?? process.env.EMBY_HOST;
        if (!host) {
          io.stderr("Error: --host or EMBY_HOST env required for login.");
          io.exit(2);
          return;
        }
        const client = factory(host, "");
        const result = await client.loginWithPassword({
          username: opts.username,
          password: opts.password,
        });
        io.stdout(result.AccessToken);
      })
    );

  // --- `emby system` ---
  const system = program.command("system").description("Server/system operations.");
  system
    .command("info")
    .description("Get authenticated system information.")
    .action(
      wrap(io, async () => {
        const client = resolveClient(system, factory, io);
        if (!client) return;
        const data = await client.callOperation("getSystemInfo");
        emit(io, program, data);
      })
    );
  system
    .command("public-info")
    .description("Get public system information (no auth required).")
    .action(
      wrap(io, async () => {
        const client = resolveClient(system, factory, io);
        if (!client) return;
        const data = await client.callOperation("getSystemInfoPublic");
        emit(io, program, data);
      })
    );
  system
    .command("ping")
    .description("Check connectivity to the server.")
    .action(
      wrap(io, async () => {
        const client = resolveClient(system, factory, io);
        if (!client) return;
        const data = await client.callOperation("getSystemPing");
        emit(io, program, data);
      })
    );

  // --- `emby users` ---
  const users = program.command("users").description("User operations.");
  users
    .command("list")
    .description("List all users.")
    .action(
      wrap(io, async () => {
        const client = resolveClient(users, factory, io);
        if (!client) return;
        const data = await client.callOperation("getUsers");
        emit(io, program, data);
      })
    );
  users
    .command("get <userId>")
    .description("Get a single user's details.")
    .action(
      wrap(io, async (userId: string) => {
        const client = resolveClient(users, factory, io);
        if (!client) return;
        const data = await client.callOperation("getUsersById", {
          pathParams: { Id: userId },
        });
        emit(io, program, data);
      })
    );

  // --- `emby items` ---
  const items = program.command("items").description("Media item operations.");
  items
    .command("list")
    .description("List media items.")
    .option("--user-id <id>", "Scope to a user")
    .option("--limit <n>", "Max items to return", (v) => parseInt(v, 10))
    .action(
      wrap(io, async (opts: { userId?: string; limit?: number }) => {
        const client = resolveClient(items, factory, io);
        if (!client) return;
        const queryParams: Record<string, any> = {};
        if (opts.userId) queryParams.UserId = opts.userId;
        if (opts.limit) queryParams.Limit = opts.limit;
        const data = await client.callOperation("getItems", { queryParams });
        emit(io, program, data);
      })
    );
  items
    .command("search <query>")
    .description("Search media items by text.")
    .option("--user-id <id>", "Scope to a user")
    .option("--limit <n>", "Max items to return", (v) => parseInt(v, 10))
    .action(
      wrap(io, async (query: string, opts: { userId?: string; limit?: number }) => {
        const client = resolveClient(items, factory, io);
        if (!client) return;
        const queryParams: Record<string, any> = { SearchTerm: query };
        if (opts.userId) queryParams.UserId = opts.userId;
        if (opts.limit) queryParams.Limit = opts.limit;
        const data = await client.callOperation("getItems", { queryParams });
        emit(io, program, data);
      })
    );
  items
    .command("get <itemId>")
    .description(
      "Get a media item's details. Requires --user-id (Emby exposes item details only in the user-scoped route)."
    )
    .requiredOption("--user-id <id>", "User ID context")
    .action(
      wrap(io, async (itemId: string, opts: { userId: string }) => {
        const client = resolveClient(items, factory, io);
        if (!client) return;
        const data = await client.callOperation("getUsersByUseridItemsById", {
          pathParams: { UserId: opts.userId, Id: itemId },
        });
        emit(io, program, data);
      })
    );

  // --- `emby sessions` ---
  const sessions = program.command("sessions").description("Client session operations.");
  sessions
    .command("list")
    .description("List active client sessions.")
    .action(
      wrap(io, async () => {
        const client = resolveClient(sessions, factory, io);
        if (!client) return;
        const data = await client.callOperation("getSessions");
        emit(io, program, data);
      })
    );

  // --- `emby libraries` ---
  const libraries = program.command("libraries").description("Library operations.");
  libraries
    .command("list")
    .description("List virtual folders (libraries).")
    .action(
      wrap(io, async () => {
        const client = resolveClient(libraries, factory, io);
        if (!client) return;
        const data = await client.callOperation("getLibraryVirtualfolders");
        emit(io, program, data);
      })
    );

  // --- `emby premiere` ---
  //
  // Emby Premiere (supporter) key management. Both subcommands require the
  // usual --host / --api-key (admin token) because the underlying
  // /System/Configuration and /Registrations/RegKey endpoints are admin-only.
  const premiere = program
    .command("premiere")
    .description("Emby Premiere (supporter) key operations.");
  premiere
    .command("status")
    .description("Print the currently-registered Emby Premiere key (if any).")
    .action(
      wrap(io, async () => {
        const client = resolveClient(premiere, factory, io);
        if (!client) return;
        const key = await readSupporterKey(client);
        emit(io, program, { supporterKey: key ?? null, registered: key !== undefined });
      })
    );
  premiere
    .command("set <key>")
    .description(
      "Register an Emby Premiere (supporter) key. Idempotent: no request is sent when the server already reports the same key."
    )
    .action(
      wrap(io, async (key: string) => {
        const client = resolveClient(premiere, factory, io);
        if (!client) return;
        const current = await readSupporterKey(client);
        if (current === key) {
          emit(io, program, { supporterKey: key, updated: false, skipped: true });
          return;
        }
        await registerPremiereKey(client, key);
        emit(io, program, { supporterKey: key, updated: true, skipped: false });
      })
    );

  // --- `emby plugins` ---
  const plugins = program.command("plugins").description("Plugin operations.");
  plugins
    .command("list")
    .description("List installed plugins.")
    .action(
      wrap(io, async () => {
        const client = resolveClient(plugins, factory, io);
        if (!client) return;
        const data = await client.callOperation("getPlugins");
        emit(io, program, data);
      })
    );
  plugins
    .command("install <name>")
    .description(
      "Install a plugin by name. Idempotent: returns status=skipped when the plugin is already installed at a matching version, status=upgraded on a version mismatch, status=installed on a fresh install. Waits for the plugin to appear in /Plugins before returning."
    )
    .option(
      "--plugin-version <version>",
      "Exact plugin version. Default: latest in the update class. (The option is not called --version because that collides with the program's --version flag.)"
    )
    .option("--update-class <class>", "Release channel: Release (default), Beta, or Dev.")
    .option(
      "--assembly-guid <guid>",
      "Assembly GUID, used to disambiguate packages that share a name."
    )
    .option("--no-wait", "Fire-and-forget: skip polling /Plugins after POST.")
    .option(
      "--timeout-ms <ms>",
      `Max time (ms) to wait for /Plugins to report the install. Default ${DEFAULT_INSTALL_TIMEOUT_MS}.`,
      (v) => parseInt(v, 10)
    )
    .option(
      "--poll-interval-ms <ms>",
      `Poll interval (ms) while waiting. Default ${DEFAULT_INSTALL_POLL_INTERVAL_MS}.`,
      (v) => parseInt(v, 10)
    )
    .action(
      wrap(
        io,
        async (
          name: string,
          opts: {
            pluginVersion?: string;
            updateClass?: string;
            assemblyGuid?: string;
            wait: boolean;
            timeoutMs?: number;
            pollIntervalMs?: number;
          }
        ) => {
          const client = resolveClient(plugins, factory, io);
          if (!client) return;
          if (
            opts.updateClass !== undefined &&
            opts.updateClass !== "Release" &&
            opts.updateClass !== "Beta" &&
            opts.updateClass !== "Dev"
          ) {
            io.stderr(`Error: --update-class must be one of Release, Beta, Dev.`);
            io.exit(2);
            return;
          }
          if (opts.wait === false) {
            // Fire-and-forget path: bypass reconcilePlugins and just POST.
            const queryParams: Record<string, string> = {};
            if (opts.pluginVersion !== undefined) queryParams.Version = opts.pluginVersion;
            if (opts.updateClass !== undefined) queryParams.UpdateClass = opts.updateClass;
            if (opts.assemblyGuid !== undefined) queryParams.AssemblyGuid = opts.assemblyGuid;
            await client.callOperation("postPackagesInstalledByName", {
              pathParams: { Name: name },
              queryParams,
            });
            emit(io, program, {
              name,
              status: "installQueued",
              waited: false,
            });
            return;
          }
          const { outcomes } = await reconcilePlugins(
            client,
            [
              {
                name,
                version: opts.pluginVersion,
                updateClass: opts.updateClass as "Release" | "Beta" | "Dev" | undefined,
                assemblyGuid: opts.assemblyGuid,
              },
            ],
            {
              installTimeoutMs: opts.timeoutMs,
              installPollIntervalMs: opts.pollIntervalMs,
            }
          );
          emit(io, program, { ...outcomes[0], waited: true });
        }
      )
    );
  plugins
    .command("uninstall <idOrName>")
    .description(
      "Uninstall a plugin by Id or Name. If an installed plugin matches by Id, that is used; otherwise we look up the Id by Name. Exits non-zero when no installed plugin matches, unless --if-present is passed."
    )
    .option("--if-present", "Treat 'not installed' as a no-op rather than an error.")
    .action(
      wrap(io, async (idOrName: string, opts: { ifPresent?: boolean }) => {
        const client = resolveClient(plugins, factory, io);
        if (!client) return;
        let pluginId: string;
        try {
          pluginId = await resolvePluginId(client, idOrName);
        } catch (err) {
          if (err instanceof PluginNotFoundError && opts.ifPresent) {
            emit(io, program, { query: idOrName, status: "notInstalled" });
            return;
          }
          throw err;
        }
        await uninstallPlugin(client, pluginId);
        emit(io, program, { query: idOrName, id: pluginId, status: "uninstalled" });
      })
    );
  return program;
}
