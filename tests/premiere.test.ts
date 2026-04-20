import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { EMBY_HOST, server } from "./setup.js";
import { runCli } from "./helpers.js";
import "./setup.js";

/**
 * Install MSW handlers that track the server-side supporter key. Returns
 * helpers for reading back the state.
 */
function installPremiereEndpoints(initial?: string) {
  let supporterKey: string | undefined = initial;
  const regKeyCalls: string[] = [];
  server.use(
    http.get(`${EMBY_HOST}/emby/System/Configuration`, () =>
      HttpResponse.json({ SupporterKey: supporterKey ?? "" })
    ),
    http.post(`${EMBY_HOST}/emby/Registrations/RegKey`, async ({ request }) => {
      const body = (await request.json()) as { MbKey?: string };
      if (!body?.MbKey) return HttpResponse.json({}, { status: 400 });
      regKeyCalls.push(body.MbKey);
      supporterKey = body.MbKey;
      return new HttpResponse(null, { status: 204 });
    })
  );
  return {
    getSupporterKey: () => supporterKey,
    getRegKeyCalls: () => regKeyCalls,
  };
}

describe("emby premiere status", () => {
  it("reports the registered key when one is set", async () => {
    installPremiereEndpoints("MB-ACTIVE");
    const capture = await runCli(["premiere", "status"]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toEqual({ supporterKey: "MB-ACTIVE", registered: true });
  });

  it("reports no key when the server has none", async () => {
    installPremiereEndpoints();
    const capture = await runCli(["premiere", "status"]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toEqual({ supporterKey: null, registered: false });
  });
});

describe("emby premiere set", () => {
  it("registers a new key when the server has none", async () => {
    const { getSupporterKey, getRegKeyCalls } = installPremiereEndpoints();
    const capture = await runCli(["premiere", "set", "MB-NEW"]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toEqual({ supporterKey: "MB-NEW", updated: true, skipped: false });
    expect(getSupporterKey()).toBe("MB-NEW");
    expect(getRegKeyCalls()).toEqual(["MB-NEW"]);
  });

  it("is idempotent when the same key is already registered", async () => {
    const { getRegKeyCalls } = installPremiereEndpoints("MB-SAME");
    const capture = await runCli(["premiere", "set", "MB-SAME"]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toEqual({ supporterKey: "MB-SAME", updated: false, skipped: true });
    expect(getRegKeyCalls()).toEqual([]);
  });

  it("rotates the key when the server has a different one", async () => {
    const { getSupporterKey, getRegKeyCalls } = installPremiereEndpoints("MB-OLD");
    const capture = await runCli(["premiere", "set", "MB-NEW"]);
    expect(capture.exitCode).toBeNull();
    const out = JSON.parse(capture.stdout.join("\n"));
    expect(out).toEqual({ supporterKey: "MB-NEW", updated: true, skipped: false });
    expect(getSupporterKey()).toBe("MB-NEW");
    expect(getRegKeyCalls()).toEqual(["MB-NEW"]);
  });

  it("exits(1) with a descriptive error when Emby rejects the key", async () => {
    server.use(
      http.get(`${EMBY_HOST}/emby/System/Configuration`, () =>
        HttpResponse.json({ SupporterKey: "" })
      ),
      http.post(`${EMBY_HOST}/emby/Registrations/RegKey`, () =>
        HttpResponse.json({ error: "invalid key" }, { status: 400 })
      )
    );
    const capture = await runCli(["premiere", "set", "BOGUS"]);
    expect(capture.exitCode).toBe(1);
    expect(capture.stderr.join("\n")).toMatch(/Error:/);
  });
});
