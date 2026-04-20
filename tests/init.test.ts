import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildCli, CliIO } from "../src/index.js";
import {
  InitAuthMismatchError,
  InitLibraryDriftError,
  parseLibraryFlag,
  runInit,
} from "../src/init.js";
import { EmbyClient } from "@emby-utils/client";
import { EMBY_API_KEY, EMBY_HOST, server } from "./setup.js";
import "./setup.js";

// --- parseLibraryFlag ---------------------------------------------------

describe("parseLibraryFlag", () => {
  it("parses Name=/path without collection type", () => {
    expect(parseLibraryFlag("Movies=/data/movies")).toEqual({
      name: "Movies",
      path: "/data/movies",
    });
  });

  it("parses Name=/path:collectionType", () => {
    expect(parseLibraryFlag("TV=/data/tv:tvshows")).toEqual({
      name: "TV",
      path: "/data/tv",
      collectionType: "tvshows",
    });
  });

  it("keeps colons inside the path when the suffix contains a slash", () => {
    expect(parseLibraryFlag("Music=//host/share:/music")).toEqual({
      name: "Music",
      path: "//host/share:/music",
    });
  });

  it("rejects malformed input", () => {
    expect(() => parseLibraryFlag("nope")).toThrow(/Invalid --library value/);
    expect(() => parseLibraryFlag("=nope")).toThrow(/Invalid --library value/);
    expect(() => parseLibraryFlag("x=")).toThrow(/Invalid --library value/);
  });
});

// --- runInit ------------------------------------------------------------

/** Simulate a fresh Emby server for the init happy path. */
function installFreshEmby(
  options: {
    initialSupporterKey?: string;
    /** Initial set of installed plugins visible via GET /Plugins. */
    initialPlugins?: Array<{ Name: string; Version?: string; Id?: string }>;
    /** If true, POST /Packages/Installed/{Name} silently drops the package (simulates a timeout). */
    simulateInstallTimeout?: boolean;
  } = {}
) {
  let completed = false;
  const libraries: Array<{ Name: string; Locations: string[]; CollectionType?: string }> = [];
  const authKeys: Array<{ AppName: string; AccessToken: string }> = [];
  let keyCounter = 0;
  let supporterKey: string | undefined = options.initialSupporterKey;
  const regKeyCalls: string[] = [];
  const installedPlugins: Array<{ Name: string; Version?: string; Id?: string }> = [
    ...(options.initialPlugins ?? []),
  ];
  const packageInstallCalls: Array<{ name: string; version?: string; updateClass?: string }> = [];
  let pluginIdCounter = 0;
  let restartCalls = 0;

  server.use(
    http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
      completed ? HttpResponse.json({}, { status: 401 }) : HttpResponse.json({ UICulture: "en-us" })
    ),
    http.post(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
      completed ? HttpResponse.json({}, { status: 401 }) : new HttpResponse(null, { status: 204 })
    ),
    http.post(`${EMBY_HOST}/emby/Startup/User`, () =>
      completed ? HttpResponse.json({}, { status: 401 }) : HttpResponse.json({ Name: "admin" })
    ),
    http.post(`${EMBY_HOST}/emby/Startup/Complete`, () => {
      if (completed) return HttpResponse.json({}, { status: 401 });
      completed = true;
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
      HttpResponse.json({ AccessToken: "new-token", User: { Id: "u1", Name: "admin" } })
    ),
    http.get(`${EMBY_HOST}/emby/Library/VirtualFolders`, () => HttpResponse.json(libraries)),
    http.post(`${EMBY_HOST}/emby/Library/VirtualFolders`, async ({ request }) => {
      const u = new URL(request.url);
      libraries.push({
        Name: u.searchParams.get("name")!,
        Locations: [],
        CollectionType: u.searchParams.get("collectionType") ?? undefined,
      });
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${EMBY_HOST}/emby/Auth/Keys`, () =>
      HttpResponse.json({ Items: authKeys, TotalRecordCount: authKeys.length })
    ),
    http.post(`${EMBY_HOST}/emby/Auth/Keys`, ({ request }) => {
      const u = new URL(request.url);
      const app = u.searchParams.get("App");
      if (!app) return HttpResponse.json({}, { status: 400 });
      keyCounter += 1;
      authKeys.push({ AppName: app, AccessToken: `generated-token-${keyCounter}` });
      return new HttpResponse(null, { status: 204 });
    }),
    // --- Emby Premiere / supporter key endpoints ---
    http.get(`${EMBY_HOST}/emby/System/Configuration`, () =>
      HttpResponse.json({
        ServerName: "Test Emby",
        SupporterKey: supporterKey ?? "",
      })
    ),
    http.post(`${EMBY_HOST}/emby/Registrations/RegKey`, async ({ request }) => {
      const body = (await request.json()) as { MbKey?: string };
      if (!body?.MbKey) return HttpResponse.json({}, { status: 400 });
      regKeyCalls.push(body.MbKey);
      // Emby's real server persists the key back into ServerConfiguration.
      supporterKey = body.MbKey;
      return new HttpResponse(null, { status: 204 });
    }),
    // --- Plugin / package endpoints ---
    http.get(`${EMBY_HOST}/emby/Plugins`, () => HttpResponse.json(installedPlugins)),
    http.post(`${EMBY_HOST}/emby/Packages/Installed/:name`, ({ request, params }) => {
      const u = new URL(request.url);
      const name = params.name as string;
      packageInstallCalls.push({
        name,
        version: u.searchParams.get("Version") ?? undefined,
        updateClass: u.searchParams.get("UpdateClass") ?? undefined,
      });
      if (!options.simulateInstallTimeout) {
        const version = u.searchParams.get("Version") ?? "1.0.0";
        const existing = installedPlugins.find((p) => p.Name === name);
        if (existing) {
          existing.Version = version;
        } else {
          pluginIdCounter += 1;
          installedPlugins.push({
            Name: name,
            Version: version,
            Id: `plugin-${pluginIdCounter}`,
          });
        }
      }
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${EMBY_HOST}/emby/Plugins/:id`, ({ params }) => {
      const idx = installedPlugins.findIndex((p) => p.Id === params.id);
      if (idx !== -1) installedPlugins.splice(idx, 1);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${EMBY_HOST}/emby/System/Restart`, () => {
      restartCalls += 1;
      return new HttpResponse(null, { status: 204 });
    })
  );
  return {
    getLibraries: () => libraries,
    getAuthKeys: () => authKeys,
    getSupporterKey: () => supporterKey,
    getRegKeyCalls: () => regKeyCalls,
    getInstalledPlugins: () => installedPlugins,
    getPackageInstallCalls: () => packageInstallCalls,
    getRestartCalls: () => restartCalls,
  };
}

describe("runInit", () => {
  it("runs the full wizard then adds new libraries on a fresh server", async () => {
    const { getLibraries } = installFreshEmby();
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      libraries: [
        { name: "Movies", path: "/data/movies", collectionType: "movies" },
        { name: "TV", path: "/data/tv", collectionType: "tvshows" },
      ],
    });
    expect(result.wizardRan).toBe(true);
    expect(result.accessToken).toBe("new-token");
    expect(result.librariesCreated).toEqual(["Movies", "TV"]);
    expect(result.librariesSkipped).toEqual([]);
    expect(getLibraries().map((l) => l.Name)).toEqual(["Movies", "TV"]);
  });

  it("is idempotent: existing libraries are skipped on a re-run", async () => {
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({}, { status: 401 })
      ),
      http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
        HttpResponse.json({ AccessToken: "tok" })
      ),
      http.get(`${EMBY_HOST}/emby/Library/VirtualFolders`, () =>
        HttpResponse.json([{ Name: "Movies", Locations: ["/data/movies"] }])
      ),
      http.post(`${EMBY_HOST}/emby/Library/VirtualFolders`, () =>
        HttpResponse.json({}, { status: 500 })
      )
    );
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      libraries: [{ name: "Movies", path: "/data/movies" }],
    });
    expect(result.wizardRan).toBe(false);
    expect(result.librariesCreated).toEqual([]);
    expect(result.librariesSkipped).toEqual(["Movies"]);
  });

  it("throws when --require-fresh is set and the wizard is already complete", async () => {
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({}, { status: 401 })
      )
    );
    const client = new EmbyClient(EMBY_HOST, "");
    await expect(
      runInit(client, {
        adminUsername: "admin",
        adminPassword: "pw",
        requireFresh: true,
      })
    ).rejects.toThrow(/already been initialized/);
  });

  it("throws InitLibraryDriftError when an existing library has a different path", async () => {
    let postCount = 0;
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({}, { status: 401 })
      ),
      http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
        HttpResponse.json({ AccessToken: "tok" })
      ),
      http.get(`${EMBY_HOST}/emby/Library/VirtualFolders`, () =>
        HttpResponse.json([
          { Name: "Movies", Locations: ["/data/old-movies"], CollectionType: "movies" },
        ])
      ),
      http.post(`${EMBY_HOST}/emby/Library/VirtualFolders`, () => {
        postCount++;
        return new HttpResponse(null, { status: 204 });
      })
    );
    const client = new EmbyClient(EMBY_HOST, "");
    const err = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      libraries: [{ name: "Movies", path: "/data/new-movies", collectionType: "movies" }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InitLibraryDriftError);
    const drift = (err as InitLibraryDriftError).drifts;
    expect(drift).toHaveLength(1);
    expect(drift[0].name).toBe("Movies");
    expect(drift[0].desired.path).toBe("/data/new-movies");
    expect(drift[0].actual.path).toBe("/data/old-movies");
    // No mutation attempted.
    expect(postCount).toBe(0);
  });

  it("throws InitLibraryDriftError when collectionType differs", async () => {
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({}, { status: 401 })
      ),
      http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
        HttpResponse.json({ AccessToken: "tok" })
      ),
      http.get(`${EMBY_HOST}/emby/Library/VirtualFolders`, () =>
        HttpResponse.json([
          { Name: "Movies", Locations: ["/data/movies"], CollectionType: "movies" },
        ])
      )
    );
    const client = new EmbyClient(EMBY_HOST, "");
    await expect(
      runInit(client, {
        adminUsername: "admin",
        adminPassword: "pw",
        libraries: [{ name: "Movies", path: "/data/movies", collectionType: "mixed" }],
      })
    ).rejects.toBeInstanceOf(InitLibraryDriftError);
  });

  it("does not flag drift when the config omits collectionType", async () => {
    // Omitting collectionType in the config means 'don't care'; an existing
    // library with any collection type should still be considered a match.
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({}, { status: 401 })
      ),
      http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
        HttpResponse.json({ AccessToken: "tok" })
      ),
      http.get(`${EMBY_HOST}/emby/Library/VirtualFolders`, () =>
        HttpResponse.json([
          { Name: "Movies", Locations: ["/data/movies"], CollectionType: "movies" },
        ])
      )
    );
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      libraries: [{ name: "Movies", path: "/data/movies" }],
    });
    expect(result.librariesSkipped).toEqual(["Movies"]);
  });

  it("throws InitAuthMismatchError when the wizard was run with a different password", async () => {
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({}, { status: 401 })
      ),
      http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
        HttpResponse.json({}, { status: 401 })
      )
    );
    const client = new EmbyClient(EMBY_HOST, "");
    const err = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "wrong-password",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InitAuthMismatchError);
    expect((err as Error).message).toMatch(/already initialized/);
    expect((err as Error).message).toMatch(/'admin'/);
  });

  it("creates requested API keys and returns their tokens", async () => {
    const { getAuthKeys } = installFreshEmby();
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      apiKeys: ["my-app", "other"],
    });
    expect(result.apiKeysCreated.map((k) => k.app).sort()).toEqual(["my-app", "other"]);
    // Tokens are generated by our mock as `generated-token-N`.
    expect(result.apiKeysCreated.every((k) => /^generated-token-\d+$/.test(k.token))).toBe(true);
    expect(result.apiKeysSkipped).toEqual([]);
    expect(
      getAuthKeys()
        .map((k) => k.AppName)
        .sort()
    ).toEqual(["my-app", "other"]);
  });

  it("is idempotent: existing API keys are reused and not recreated", async () => {
    // Pre-existing server with the wizard done and one key already present.
    let postCount = 0;
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({}, { status: 401 })
      ),
      http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
        HttpResponse.json({ AccessToken: "tok" })
      ),
      http.get(`${EMBY_HOST}/emby/Library/VirtualFolders`, () => HttpResponse.json([])),
      http.get(`${EMBY_HOST}/emby/Auth/Keys`, () =>
        HttpResponse.json({
          Items: [{ AppName: "my-app", AccessToken: "existing-token" }],
          TotalRecordCount: 1,
        })
      ),
      http.post(`${EMBY_HOST}/emby/Auth/Keys`, () => {
        postCount++;
        return new HttpResponse(null, { status: 204 });
      })
    );
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      apiKeys: ["my-app"],
    });
    expect(result.apiKeysCreated).toEqual([]);
    expect(result.apiKeysSkipped).toEqual([{ app: "my-app", token: "existing-token" }]);
    // No mutation attempted.
    expect(postCount).toBe(0);
  });

  it("handles a plain array (non-paged) response from /Auth/Keys", async () => {
    // Some Emby versions return a bare array instead of a `{Items}` envelope.
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({}, { status: 401 })
      ),
      http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
        HttpResponse.json({ AccessToken: "tok" })
      ),
      http.get(`${EMBY_HOST}/emby/Library/VirtualFolders`, () => HttpResponse.json([])),
      http.get(`${EMBY_HOST}/emby/Auth/Keys`, () =>
        HttpResponse.json([{ AppName: "my-app", AccessToken: "existing-token" }])
      )
    );
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      apiKeys: ["my-app"],
    });
    expect(result.apiKeysSkipped).toEqual([{ app: "my-app", token: "existing-token" }]);
  });

  it("mixes created and skipped keys in a single run", async () => {
    const authKeys: Array<{ AppName: string; AccessToken: string }> = [
      { AppName: "existing", AccessToken: "existing-token" },
    ];
    let keyCounter = 0;
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({}, { status: 401 })
      ),
      http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
        HttpResponse.json({ AccessToken: "tok" })
      ),
      http.get(`${EMBY_HOST}/emby/Library/VirtualFolders`, () => HttpResponse.json([])),
      http.get(`${EMBY_HOST}/emby/Auth/Keys`, () =>
        HttpResponse.json({ Items: authKeys, TotalRecordCount: authKeys.length })
      ),
      http.post(`${EMBY_HOST}/emby/Auth/Keys`, ({ request }) => {
        const u = new URL(request.url);
        keyCounter += 1;
        authKeys.push({
          AppName: u.searchParams.get("App")!,
          AccessToken: `new-token-${keyCounter}`,
        });
        return new HttpResponse(null, { status: 204 });
      })
    );
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      apiKeys: ["existing", "fresh"],
    });
    expect(result.apiKeysSkipped).toEqual([{ app: "existing", token: "existing-token" }]);
    expect(result.apiKeysCreated).toEqual([{ app: "fresh", token: "new-token-1" }]);
  });

  it("registers a premiere key when the server has none", async () => {
    const { getSupporterKey, getRegKeyCalls } = installFreshEmby();
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      premiereKey: "MB-TEST-KEY-123",
    });
    expect(result.premiereKey).toEqual({ requested: true, updated: true, skipped: false });
    expect(getSupporterKey()).toBe("MB-TEST-KEY-123");
    expect(getRegKeyCalls()).toEqual(["MB-TEST-KEY-123"]);
  });

  it("is idempotent: the premiere key is skipped when already registered", async () => {
    const { getRegKeyCalls } = installFreshEmby({ initialSupporterKey: "MB-TEST-KEY-123" });
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      premiereKey: "MB-TEST-KEY-123",
    });
    expect(result.premiereKey).toEqual({ requested: true, updated: false, skipped: true });
    // No registration call should have been issued.
    expect(getRegKeyCalls()).toEqual([]);
  });

  it("updates the premiere key when the server has a different one", async () => {
    const { getSupporterKey, getRegKeyCalls } = installFreshEmby({
      initialSupporterKey: "OLD-KEY",
    });
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      premiereKey: "NEW-KEY",
    });
    expect(result.premiereKey).toEqual({ requested: true, updated: true, skipped: false });
    expect(getSupporterKey()).toBe("NEW-KEY");
    expect(getRegKeyCalls()).toEqual(["NEW-KEY"]);
  });

  it("does not touch the premiere key when none is configured", async () => {
    const { getRegKeyCalls } = installFreshEmby({ initialSupporterKey: "EXISTING-KEY" });
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
    });
    expect(result.premiereKey).toEqual({ requested: false });
    // We must not have hit the RegKey endpoint.
    expect(getRegKeyCalls()).toEqual([]);
  });

  it("surfaces a rejected premiere key as the underlying axios error", async () => {
    // Emby returns 4xx when the Premiere license service refuses the key.
    // The error must propagate; we should NOT silently report skipped=true.
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({}, { status: 401 })
      ),
      http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
        HttpResponse.json({ AccessToken: "tok" })
      ),
      http.get(`${EMBY_HOST}/emby/Library/VirtualFolders`, () => HttpResponse.json([])),
      http.get(`${EMBY_HOST}/emby/System/Configuration`, () =>
        HttpResponse.json({ SupporterKey: "" })
      ),
      http.post(`${EMBY_HOST}/emby/Registrations/RegKey`, () =>
        HttpResponse.json({ error: "invalid key" }, { status: 400 })
      )
    );
    const client = new EmbyClient(EMBY_HOST, "");
    await expect(
      runInit(client, {
        adminUsername: "admin",
        adminPassword: "pw",
        premiereKey: "BOGUS",
      })
    ).rejects.toThrow();
  });

  // --- plugins in runInit ---

  it("installs plugins that are not already present", async () => {
    const { getInstalledPlugins, getPackageInstallCalls, getRestartCalls } = installFreshEmby();
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      plugins: [{ name: "Trakt" }, { name: "TVHeadEnd", version: "1.2.3" }],
      // Use tiny timeouts so test runs don't linger even if the mock misbehaves.
      pluginInstallTimeoutMs: 2000,
      pluginInstallPollIntervalMs: 10,
    });
    expect(result.plugins).toHaveLength(2);
    expect(result.plugins.map((p) => ({ name: p.name, status: p.status }))).toEqual([
      { name: "Trakt", status: "installed" },
      { name: "TVHeadEnd", status: "installed" },
    ]);
    expect(result.plugins[1].version).toBe("1.2.3");
    expect(
      getInstalledPlugins()
        .map((p) => p.Name)
        .sort()
    ).toEqual(["TVHeadEnd", "Trakt"]);
    expect(
      getPackageInstallCalls()
        .map((c) => c.name)
        .sort()
    ).toEqual(["TVHeadEnd", "Trakt"]);
    // No restart requested in this test.
    expect(result.serverRestarted).toBe(false);
    expect(getRestartCalls()).toBe(0);
  });

  it("skips plugins already installed at a matching or unspecified version", async () => {
    const { getPackageInstallCalls } = installFreshEmby({
      initialPlugins: [
        { Name: "Trakt", Version: "1.0.0", Id: "p-trakt" },
        { Name: "TVHeadEnd", Version: "1.2.3", Id: "p-tvh" },
      ],
    });
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      plugins: [
        // No version: any installed version matches.
        { name: "Trakt" },
        // Matching version: also a skip.
        { name: "TVHeadEnd", version: "1.2.3" },
      ],
    });
    expect(result.plugins.map((p) => p.status)).toEqual(["skipped", "skipped"]);
    // Crucially, no install POSTs should have been issued.
    expect(getPackageInstallCalls()).toEqual([]);
  });

  it("upgrades a plugin when the installed version differs from the spec", async () => {
    const { getInstalledPlugins, getPackageInstallCalls } = installFreshEmby({
      initialPlugins: [{ Name: "Trakt", Version: "1.0.0", Id: "p-trakt" }],
    });
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      plugins: [{ name: "Trakt", version: "2.0.0" }],
      pluginInstallTimeoutMs: 2000,
      pluginInstallPollIntervalMs: 10,
    });
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({
      name: "Trakt",
      version: "2.0.0",
      status: "upgraded",
    });
    expect(getInstalledPlugins().find((p) => p.Name === "Trakt")?.Version).toBe("2.0.0");
    expect(getPackageInstallCalls()).toEqual([
      { name: "Trakt", version: "2.0.0", updateClass: undefined },
    ]);
  });

  it("forwards version and updateClass as query params", async () => {
    const { getPackageInstallCalls } = installFreshEmby();
    const client = new EmbyClient(EMBY_HOST, "");
    await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      plugins: [{ name: "Trakt", version: "2.0.0", updateClass: "Beta" }],
      pluginInstallTimeoutMs: 2000,
      pluginInstallPollIntervalMs: 10,
    });
    expect(getPackageInstallCalls()).toEqual([
      { name: "Trakt", version: "2.0.0", updateClass: "Beta" },
    ]);
  });

  it("times out (throws PluginInstallTimeoutError) when the plugin never appears", async () => {
    installFreshEmby({ simulateInstallTimeout: true });
    const client = new EmbyClient(EMBY_HOST, "");
    const err = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      plugins: [{ name: "GhostPlugin" }],
      pluginInstallTimeoutMs: 50,
      pluginInstallPollIntervalMs: 10,
    }).catch((e) => e);
    expect(err).toBeDefined();
    expect((err as Error).name).toBe("PluginInstallTimeoutError");
    expect((err as Error).message).toMatch(/GhostPlugin/);
  });

  it("restarts the server when restartAfterPlugins=true AND a plugin was installed", async () => {
    const { getRestartCalls } = installFreshEmby();
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      plugins: [{ name: "Trakt" }],
      restartAfterPlugins: true,
      pluginInstallTimeoutMs: 2000,
      pluginInstallPollIntervalMs: 10,
    });
    expect(result.serverRestarted).toBe(true);
    expect(getRestartCalls()).toBe(1);
  });

  it("does NOT restart when restartAfterPlugins=true but every plugin was skipped", async () => {
    // All specs match already-installed plugins -> no mutation -> no restart.
    const { getRestartCalls } = installFreshEmby({
      initialPlugins: [{ Name: "Trakt", Version: "1.0.0", Id: "p-trakt" }],
    });
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      plugins: [{ name: "Trakt" }],
      restartAfterPlugins: true,
    });
    expect(result.serverRestarted).toBe(false);
    expect(getRestartCalls()).toBe(0);
  });

  it("does NOT restart when restartAfterPlugins is unset/false", async () => {
    const { getRestartCalls } = installFreshEmby();
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
      plugins: [{ name: "Trakt" }],
      pluginInstallTimeoutMs: 2000,
      pluginInstallPollIntervalMs: 10,
    });
    expect(result.serverRestarted).toBe(false);
    expect(getRestartCalls()).toBe(0);
  });

  it("reports empty plugins and serverRestarted=false when no plugins are configured", async () => {
    installFreshEmby();
    const client = new EmbyClient(EMBY_HOST, "");
    const result = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
    });
    expect(result.plugins).toEqual([]);
    expect(result.serverRestarted).toBe(false);
  });

  it("does NOT wrap a 401 during the wizard-creation path (only post-init)", async () => {
    // If the server returns 401 on AuthenticateByName *during* a fresh-init
    // flow, it's a genuine auth bug, not a stale-password mismatch. We must
    // surface the raw error rather than swallow it as InitAuthMismatchError.
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({ UICulture: "en-us" })
      ),
      http.post(
        `${EMBY_HOST}/emby/Startup/Configuration`,
        () => new HttpResponse(null, { status: 204 })
      ),
      http.post(`${EMBY_HOST}/emby/Startup/User`, () => HttpResponse.json({ Name: "admin" })),
      http.post(
        `${EMBY_HOST}/emby/Startup/Complete`,
        () => new HttpResponse(null, { status: 204 })
      ),
      http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
        HttpResponse.json({}, { status: 401 })
      )
    );
    const client = new EmbyClient(EMBY_HOST, "");
    const err = await runInit(client, {
      adminUsername: "admin",
      adminPassword: "pw",
    }).catch((e) => e);
    expect(err).not.toBeInstanceOf(InitAuthMismatchError);
  });
});

// --- `emby init` CLI integration ----------------------------------------

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
    // commander throws on exitOverride; capture.exitCode holds the final code
  }
  return capture;
}

describe("emby init (CLI)", () => {
  it("runs through the full flow end-to-end from a config file", async () => {
    installFreshEmby();
    const configPath = path.join(os.tmpdir(), `emby-init-${Date.now()}.json`);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        adminUsername: "admin",
        adminPassword: "pw",
        libraries: [
          { name: "Movies", path: "/data/movies", collectionType: "movies" },
          { name: "TV", path: "/data/tv", collectionType: "tvshows" },
        ],
        apiKeys: ["my-app"],
        premiereKey: "MB-CLI-KEY",
        plugins: [{ name: "Trakt" }],
        restartAfterPlugins: true,
        pluginInstallTimeoutMs: 2000,
        pluginInstallPollIntervalMs: 10,
      }),
      "utf8"
    );

    try {
      const capture = await runCli(["init", "--config", configPath]);
      if (capture.exitCode !== null) {
        throw new Error(`init CLI failed: ${capture.stderr.join("\n")}`);
      }
      const out = JSON.parse(capture.stdout.join("\n"));
      expect(out.wizardRan).toBe(true);
      expect(out.librariesCreated).toEqual(["Movies", "TV"]);
      expect(out.accessToken).toBe("new-token");
      expect(out.apiKeysCreated).toHaveLength(1);
      expect(out.apiKeysCreated[0].app).toBe("my-app");
      expect(out.apiKeysCreated[0].token).toMatch(/^generated-token-\d+$/);
      expect(out.apiKeysSkipped).toEqual([]);
      expect(out.premiereKey).toEqual({ requested: true, updated: true, skipped: false });
      expect(out.plugins).toHaveLength(1);
      expect(out.plugins[0]).toMatchObject({ name: "Trakt", status: "installed" });
      expect(out.serverRestarted).toBe(true);
    } finally {
      fs.rmSync(configPath, { force: true });
    }
  });

  it("reports an error and exits(1) when requireFresh is set and server is already initialized", async () => {
    server.use(
      http.get(`${EMBY_HOST}/emby/Startup/Configuration`, () =>
        HttpResponse.json({}, { status: 401 })
      )
    );
    const configPath = path.join(os.tmpdir(), `emby-init-${Date.now()}.json`);
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        adminUsername: "admin",
        adminPassword: "pw",
        requireFresh: true,
      }),
      "utf8"
    );
    try {
      const capture = await runCli(["init", "--config", configPath]);
      expect(capture.exitCode).toBe(1);
      expect(capture.stderr.join("\n")).toMatch(/already been initialized/);
    } finally {
      fs.rmSync(configPath, { force: true });
    }
  });
});
