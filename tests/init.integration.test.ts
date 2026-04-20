/**
 * Integration tests: drive a real `emby/embyserver` container via
 * testcontainers. Opt in with `EMBY_DOCKER_TESTS=1`; otherwise the
 * suites below are skipped so local `npm test` stays fast.
 *
 * We exercise two distinct paths:
 *   - the programmatic `runInit` API
 *   - the `emby init --config` CLI with a JSON config file that relies
 *     on `${EMBY_ADMIN_PW}` env-var interpolation
 *
 * Both suites share a single Emby container spun up once per test file so
 * we pay the ~20 s cold-start cost only once.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { EmbyClient } from "@emby-utils/client";
import { runInit } from "../src/init.js";
import { buildCli, type CliIO } from "../src/index.js";

const RUN = process.env.EMBY_DOCKER_TESTS === "1";
const describeIfDocker = RUN ? describe : describe.skip;

describeIfDocker("Emby init integration (emby/embyserver:latest)", () => {
  let container: StartedTestContainer;
  let host: string;

  beforeAll(async () => {
    container = await new GenericContainer("emby/embyserver:latest")
      .withExposedPorts(8096)
      .withWaitStrategy(Wait.forHttp("/emby/System/Info/Public", 8096).forStatusCode(200))
      .withStartupTimeout(120_000)
      .start();
    await container.exec(["sh", "-c", "mkdir -p /data/movies /data/tv /data/music /data/books"]);
    host = `http://${container.getHost()}:${container.getMappedPort(8096)}`;
  }, 180_000);

  afterAll(async () => {
    if (container) await container.stop();
  }, 60_000);

  describe("programmatic runInit", () => {
    it("initializes a fresh Emby end-to-end", async () => {
      const client = new EmbyClient(host, "");
      const result = await runInit(client, {
        adminUsername: "admin",
        adminPassword: "ChangeMe!123",
        libraries: [
          { name: "Movies", path: "/data/movies", collectionType: "movies" },
          { name: "TV Shows", path: "/data/tv", collectionType: "tvshows" },
        ],
        apiKeys: ["integration-test-app"],
      });

      expect(result.wizardRan).toBe(true);
      expect(result.accessToken).toMatch(/^[0-9a-f]{20,}$/i);
      expect(result.librariesCreated.sort()).toEqual(["Movies", "TV Shows"]);
      expect(result.librariesSkipped).toEqual([]);
      expect(result.apiKeysCreated).toHaveLength(1);
      expect(result.apiKeysCreated[0].app).toBe("integration-test-app");
      expect(result.apiKeysCreated[0].token).toMatch(/^[0-9a-f]{20,}$/i);
      expect(result.apiKeysSkipped).toEqual([]);
      // No premiereKey was requested; the call must report that explicitly.
      expect(result.premiereKey).toEqual({ requested: false });
      // No plugins were requested; result must carry an empty list and no restart.
      expect(result.plugins).toEqual([]);
      expect(result.serverRestarted).toBe(false);

      const authed = new EmbyClient(host, result.accessToken);
      expect(await authed.isStartupComplete()).toBe(true);

      const users = await authed.callOperation("getUsers");
      expect(users.some((u) => u.Name === "admin")).toBe(true);

      const libraries = await authed.callOperation("getLibraryVirtualfolders");
      const names = libraries.map((l) => l.Name).sort();
      expect(names).toEqual(["Movies", "TV Shows"]);

      // The minted API key should itself be usable against the server.
      const keyClient = new EmbyClient(host, result.apiKeysCreated[0].token);
      const keyUsers = await keyClient.callOperation("getUsers");
      expect(keyUsers.some((u) => u.Name === "admin")).toBe(true);
    }, 180_000);

    it("is idempotent on a second run", async () => {
      const client = new EmbyClient(host, "");
      const result = await runInit(client, {
        adminUsername: "admin",
        adminPassword: "ChangeMe!123",
        libraries: [
          { name: "Movies", path: "/data/movies", collectionType: "movies" },
          { name: "Music", path: "/data/music", collectionType: "music" },
        ],
        apiKeys: ["integration-test-app", "second-app"],
      });
      expect(result.wizardRan).toBe(false);
      expect(result.librariesCreated).toEqual(["Music"]);
      expect(result.librariesSkipped).toEqual(["Movies"]);
      // The first key was minted in the previous test; the second is new.
      expect(result.apiKeysSkipped.map((k) => k.app)).toEqual(["integration-test-app"]);
      expect(result.apiKeysCreated.map((k) => k.app)).toEqual(["second-app"]);
      expect(result.premiereKey).toEqual({ requested: false });
      expect(result.plugins).toEqual([]);
      expect(result.serverRestarted).toBe(false);
    }, 120_000);

    it("premiere-key idempotency short-circuits when no key is set", async () => {
      // We can't test a real Emby Premiere key end-to-end (it would require
      // a valid license and network access to Emby's license service). This
      // only asserts the pre-flight read path: a fresh server with no
      // SupporterKey set plus an empty config leaves premiereKey untouched.
      const client = new EmbyClient(host, "");
      const result = await runInit(client, {
        adminUsername: "admin",
        adminPassword: "ChangeMe!123",
      });
      expect(result.wizardRan).toBe(false);
      expect(result.premiereKey).toEqual({ requested: false });
    }, 60_000);
  });

  describe("`emby init --config` CLI", () => {
    it("adds a library listed in a JSON config, expanding ${VAR} placeholders", async () => {
      // Server is already initialized by the earlier describe block, so the
      // CLI path exercises the idempotent branch: skip the wizard, add the
      // one new library referenced by the config file.
      const stdout: string[] = [];
      const stderr: string[] = [];
      let exitCode: number | null = null;
      const io: CliIO = {
        stdout: (l) => stdout.push(l),
        stderr: (l) => stderr.push(l),
        exit: (c) => {
          exitCode = c;
        },
      };

      const configPath = path.join(os.tmpdir(), `emby-init-docker-${Date.now()}.json`);
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          adminUsername: "admin",
          adminPassword: "${EMBY_ADMIN_PW}",
          libraries: [{ name: "Books", path: "/data/books", collectionType: "books" }],
        }),
        "utf8"
      );

      const origPw = process.env.EMBY_ADMIN_PW;
      process.env.EMBY_ADMIN_PW = "ChangeMe!123";
      try {
        const program = buildCli({ io });
        program.exitOverride();
        try {
          await program.parseAsync(["--host", host, "init", "--config", configPath], {
            from: "user",
          });
        } catch {
          // commander throws on exitOverride
        }
      } finally {
        if (origPw === undefined) delete process.env.EMBY_ADMIN_PW;
        else process.env.EMBY_ADMIN_PW = origPw;
        fs.rmSync(configPath, { force: true });
      }

      if (exitCode !== null) {
        throw new Error(`init --config failed: ${stderr.join("\n")}`);
      }
      const out = JSON.parse(stdout.join("\n"));
      expect(out.wizardRan).toBe(false);
      expect(out.librariesCreated).toEqual(["Books"]);
      expect(out.accessToken).toMatch(/^[0-9a-f]{20,}$/i);

      // Confirm the library actually lives on the server.
      const authed = new EmbyClient(host, out.accessToken);
      const libraries = await authed.callOperation("getLibraryVirtualfolders");
      expect(libraries.map((l) => l.Name)).toContain("Books");
    }, 120_000);
  });
});
