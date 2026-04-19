import { Command } from "commander";
import { EmbyClient } from "@emby-utils/client";
import { formatOutput, OutputFormat } from "./format.js";
import { runInit } from "./init.js";
import { loadInitConfig, toInitOptions } from "./init-config.js";

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
    .version("0.1.0")
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

  return program;
}
