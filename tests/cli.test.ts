import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { buildCli } from "../src/index.js";
import { EMBY_API_KEY, EMBY_HOST, server } from "./setup.js";
import { makeIO, runCli } from "./helpers.js";
import "./setup.js";

/** Run the CLI with the given arguments. Always provides credentials. */
async function run(args: string[]) {
  return runCli(args);
}

describe("emby CLI - credential handling", () => {
  it("errors and exits(2) when credentials are missing", async () => {
    const capture = makeIO();
    const program = buildCli({ io: capture.io });
    program.exitOverride();
    // no host/key, and we scrub env so the CLI cannot fall back
    const origHost = process.env.EMBY_HOST;
    const origKey = process.env.EMBY_API_KEY;
    delete process.env.EMBY_HOST;
    delete process.env.EMBY_API_KEY;
    try {
      await program.parseAsync(["system", "info"], { from: "user" });
    } catch {
      // commander throws when exitOverride is set; ignore
    } finally {
      if (origHost !== undefined) process.env.EMBY_HOST = origHost;
      if (origKey !== undefined) process.env.EMBY_API_KEY = origKey;
    }
    expect(capture.exitCode).toBe(2);
    expect(capture.stderr.join("\n")).toMatch(/host and API key required/);
  });
});

describe("emby CLI - system commands", () => {
  it("`system info` prints JSON from getSystemInfo", async () => {
    const capture = await run(["system", "info"]);
    expect(capture.exitCode).toBe(null);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out.ServerName).toBe("Test Emby");
  });

  it("`system public-info` works without auth semantically", async () => {
    const capture = await run(["system", "public-info"]);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out.ServerName).toBe("Test Emby");
  });

  it("`system ping` hits /System/Ping", async () => {
    server.use(http.get(`${EMBY_HOST}/emby/System/Ping`, () => HttpResponse.json({ pong: true })));
    const capture = await run(["system", "ping"]);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out.pong).toBe(true);
  });
});

describe("emby CLI - users commands", () => {
  it("`users list` returns array of users", async () => {
    const capture = await run(["users", "list"]);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toHaveLength(2);
    expect(out[0].Name).toBe("alice");
  });

  it("`users get <id>` substitutes the path param", async () => {
    const capture = await run(["users", "get", "user-xyz"]);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out.Id).toBe("user-xyz");
  });
});

describe("emby CLI - items commands", () => {
  it("`items list` calls /Items with no extra filters", async () => {
    const capture = await run(["items", "list"]);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out.Items.length).toBe(2);
  });

  it("`items list --user-id --limit` forwards query params", async () => {
    const capture = await run(["items", "list", "--user-id", "u1", "--limit", "5"]);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out._query.UserId).toBe("u1");
    expect(out._query.Limit).toBe("5");
  });

  it("`items search <q>` sets SearchTerm", async () => {
    const capture = await run(["items", "search", "matrix"]);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out._query.SearchTerm).toBe("matrix");
  });

  it("`items get <id>` requires --user-id", async () => {
    const capture = await run(["items", "get", "it1", "--user-id", "u1"]);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out.Name).toContain("User u1 scoped item it1");
  });
});

describe("emby CLI - sessions/libraries/plugins", () => {
  it("`sessions list` returns sessions", async () => {
    const capture = await run(["sessions", "list"]);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out[0].Id).toBe("s1");
  });

  it("`libraries list` returns virtual folders", async () => {
    const capture = await run(["libraries", "list"]);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out[0].Name).toBe("Movies");
  });

  it("`plugins list` returns plugins", async () => {
    const capture = await run(["plugins", "list"]);
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out[0].Name).toBe("Test Plugin");
  });
});

describe("emby CLI - error handling", () => {
  it("exits(1) when the server returns an HTTP error", async () => {
    server.use(
      http.get(`${EMBY_HOST}/emby/System/Info`, () => HttpResponse.json({}, { status: 500 }))
    );
    const capture = await run(["system", "info"]);
    expect(capture.exitCode).toBe(1);
    expect(capture.stderr.join("\n")).toMatch(/Error/);
  });
});

describe("emby CLI - login", () => {
  it("prints the access token returned by the server", async () => {
    server.use(
      http.post(`${EMBY_HOST}/emby/Users/AuthenticateByName`, () =>
        HttpResponse.json({ AccessToken: "tok-abc", User: { Id: "u1" } })
      )
    );
    const capture = await run(["login", "--username", "alice", "--password", "x"]);
    if (capture.exitCode !== null) {
      // Surface stderr so the failure is self-explanatory in CI logs.
      throw new Error(`Login CLI failed: ${capture.stderr.join("\n")}`);
    }
    expect(capture.stdout.join("\n").trim()).toBe("tok-abc");
  });

  it("exits(2) when --host is missing", async () => {
    const capture = makeIO();
    const program = buildCli({ io: capture.io });
    program.exitOverride();
    const origHost = process.env.EMBY_HOST;
    delete process.env.EMBY_HOST;
    try {
      await program.parseAsync(["login", "--username", "a", "--password", "b"], {
        from: "user",
      });
    } catch {
      // expected
    } finally {
      if (origHost !== undefined) process.env.EMBY_HOST = origHost;
    }
    expect(capture.exitCode).toBe(2);
  });
});

describe("emby CLI - --format", () => {
  it("--format yaml emits YAML", async () => {
    const capture = await run(["--format", "yaml", "users", "list"]);
    expect(capture.stdout.join("\n")).toContain("Name: alice");
  });

  it("--format table emits an ASCII table", async () => {
    const capture = await run(["--format", "table", "users", "list"]);
    const out = capture.stdout.join("\n");
    expect(out).toContain("alice");
    expect(out).toContain("bob");
    // Table characters
    expect(out).toMatch(/[─│┌┐└┘]/);
  });

  it("--format table --columns restricts projection", async () => {
    const capture = await run(["--format", "table", "--columns", "Id", "users", "list"]);
    const out = capture.stdout.join("\n");
    expect(out).toContain("Id");
    // Name column should be excluded
    expect(out).not.toContain("alice");
  });
});
