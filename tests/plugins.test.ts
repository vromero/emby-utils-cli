import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { buildCli, CliIO } from "../src/index.js";
import { EMBY_API_KEY, EMBY_HOST, server } from "./setup.js";
import "./setup.js";

interface CapturedIO {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  io: CliIO;
}

function makeIO(): CapturedIO {
  const state: CapturedIO = {
    stdout: [],
    stderr: [],
    exitCode: null,
    io: {
      stdout: (l) => state.stdout.push(l),
      stderr: (l) => state.stderr.push(l),
      exit: (code) => {
        state.exitCode = code;
      },
    },
  };
  return state;
}

async function runCli(args: string[]) {
  const capture = makeIO();
  const program = buildCli({ io: capture.io });
  program.exitOverride();
  try {
    await program.parseAsync(["--host", EMBY_HOST, "--api-key", EMBY_API_KEY, ...args], {
      from: "user",
    });
  } catch {
    // commander throws on exitOverride
  }
  return capture;
}

/**
 * Install a minimal plugin-service mock backed by in-memory state.
 *
 *  - GET /Plugins returns the current list (honors `delayInstallVisibility`).
 *  - POST /Packages/Installed/{Name} appends to the list (or delays its
 *    visibility so tests can observe the poll loop).
 *  - DELETE /Plugins/{Id} removes by Id.
 */
function installPluginMocks(
  init: Array<{ Name: string; Version?: string; Id?: string }> = [],
  options: { simulateTimeout?: boolean } = {}
) {
  const plugins = [...init];
  const installCalls: Array<{ name: string; version?: string; updateClass?: string }> = [];
  let idCounter = 0;
  server.use(
    http.get(`${EMBY_HOST}/emby/Plugins`, () => HttpResponse.json(plugins)),
    http.post(`${EMBY_HOST}/emby/Packages/Installed/:name`, ({ params, request }) => {
      const u = new URL(request.url);
      const name = params.name as string;
      installCalls.push({
        name,
        version: u.searchParams.get("Version") ?? undefined,
        updateClass: u.searchParams.get("UpdateClass") ?? undefined,
      });
      if (!options.simulateTimeout) {
        const version = u.searchParams.get("Version") ?? "1.0.0";
        const existing = plugins.find((p) => p.Name === name);
        if (existing) existing.Version = version;
        else {
          idCounter += 1;
          plugins.push({ Name: name, Version: version, Id: `plugin-${idCounter}` });
        }
      }
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${EMBY_HOST}/emby/Plugins/:id`, ({ params }) => {
      const idx = plugins.findIndex((p) => p.Id === params.id);
      if (idx !== -1) plugins.splice(idx, 1);
      return new HttpResponse(null, { status: 204 });
    })
  );
  return {
    getPlugins: () => plugins,
    getInstallCalls: () => installCalls,
  };
}

describe("emby plugins install", () => {
  it("installs a plugin and waits for it to appear in /Plugins", async () => {
    const { getPlugins, getInstallCalls } = installPluginMocks();
    const capture = await runCli([
      "plugins",
      "install",
      "Trakt",
      "--timeout-ms",
      "2000",
      "--poll-interval-ms",
      "10",
    ]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toMatchObject({ name: "Trakt", status: "installed", waited: true });
    expect(out.id).toMatch(/^plugin-\d+$/);
    expect(getPlugins().map((p) => p.Name)).toContain("Trakt");
    expect(getInstallCalls()).toEqual([
      { name: "Trakt", version: undefined, updateClass: undefined },
    ]);
  });

  it("reports status=skipped when the plugin is already installed", async () => {
    const { getInstallCalls } = installPluginMocks([
      { Name: "Trakt", Version: "1.0.0", Id: "plugin-existing" },
    ]);
    const capture = await runCli(["plugins", "install", "Trakt"]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toMatchObject({
      name: "Trakt",
      version: "1.0.0",
      id: "plugin-existing",
      status: "skipped",
      waited: true,
    });
    // No install POST should have occurred.
    expect(getInstallCalls()).toEqual([]);
  });

  it("reports status=upgraded on a version mismatch", async () => {
    const { getPlugins } = installPluginMocks([
      { Name: "Trakt", Version: "1.0.0", Id: "plugin-existing" },
    ]);
    const capture = await runCli([
      "plugins",
      "install",
      "Trakt",
      "--plugin-version",
      "2.0.0",
      "--timeout-ms",
      "2000",
      "--poll-interval-ms",
      "10",
    ]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toMatchObject({ name: "Trakt", version: "2.0.0", status: "upgraded" });
    expect(getPlugins().find((p) => p.Name === "Trakt")?.Version).toBe("2.0.0");
  });

  it("forwards --update-class and --assembly-guid to Emby", async () => {
    const { getInstallCalls } = installPluginMocks();
    // Use --no-wait to skip polling overhead; the install call is still recorded.
    const capture = await runCli([
      "plugins",
      "install",
      "Trakt",
      "--plugin-version",
      "2.0.0",
      "--update-class",
      "Beta",
      "--assembly-guid",
      "00000000-0000-0000-0000-000000000001",
      "--no-wait",
    ]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toEqual({ name: "Trakt", status: "installQueued", waited: false });
    expect(getInstallCalls()).toEqual([{ name: "Trakt", version: "2.0.0", updateClass: "Beta" }]);
  });

  it("rejects an invalid --update-class value", async () => {
    installPluginMocks();
    const capture = await runCli(["plugins", "install", "Trakt", "--update-class", "Nightly"]);
    expect(capture.exitCode).toBe(2);
    expect(capture.stderr.join("\n")).toMatch(/update-class/);
  });

  it("exits(1) with PluginInstallTimeoutError when the plugin never appears", async () => {
    installPluginMocks([], { simulateTimeout: true });
    const capture = await runCli([
      "plugins",
      "install",
      "GhostPlugin",
      "--timeout-ms",
      "50",
      "--poll-interval-ms",
      "10",
    ]);
    expect(capture.exitCode).toBe(1);
    expect(capture.stderr.join("\n")).toMatch(/GhostPlugin/);
  });
});

describe("emby plugins uninstall", () => {
  it("uninstalls by Name", async () => {
    const { getPlugins } = installPluginMocks([
      { Name: "Trakt", Version: "1.0.0", Id: "plugin-trakt" },
    ]);
    const capture = await runCli(["plugins", "uninstall", "Trakt"]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toEqual({ query: "Trakt", id: "plugin-trakt", status: "uninstalled" });
    expect(getPlugins().map((p) => p.Name)).not.toContain("Trakt");
  });

  it("uninstalls by Id", async () => {
    const { getPlugins } = installPluginMocks([
      { Name: "Trakt", Version: "1.0.0", Id: "plugin-trakt" },
    ]);
    const capture = await runCli(["plugins", "uninstall", "plugin-trakt"]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toEqual({
      query: "plugin-trakt",
      id: "plugin-trakt",
      status: "uninstalled",
    });
    expect(getPlugins()).toEqual([]);
  });

  it("exits(1) when no installed plugin matches, by default", async () => {
    installPluginMocks([]);
    const capture = await runCli(["plugins", "uninstall", "GhostPlugin"]);
    expect(capture.exitCode).toBe(1);
    expect(capture.stderr.join("\n")).toMatch(/GhostPlugin/);
  });

  it("with --if-present, a missing plugin is reported as notInstalled", async () => {
    installPluginMocks([]);
    const capture = await runCli(["plugins", "uninstall", "GhostPlugin", "--if-present"]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toEqual({ query: "GhostPlugin", status: "notInstalled" });
  });
});
