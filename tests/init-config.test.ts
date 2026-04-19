import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  InitConfigError,
  interpolateEnv,
  loadInitConfig,
  toInitOptions,
} from "../src/init-config.js";

const tempFiles: string[] = [];
function writeTempJson(obj: unknown): string {
  const p = path.join(
    os.tmpdir(),
    `emby-init-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
  tempFiles.push(p);
  return p;
}
function writeTempRaw(raw: string): string {
  const p = path.join(
    os.tmpdir(),
    `emby-init-raw-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(p, raw, "utf8");
  tempFiles.push(p);
  return p;
}

afterEach(() => {
  while (tempFiles.length) {
    const p = tempFiles.pop();
    if (p) fs.rmSync(p, { force: true });
  }
});

describe("interpolateEnv", () => {
  it("leaves strings without placeholders untouched", () => {
    expect(interpolateEnv("plain string", {})).toBe("plain string");
  });

  it("expands ${VAR} when the env var is set", () => {
    expect(interpolateEnv("${FOO}", { FOO: "bar" })).toBe("bar");
    expect(interpolateEnv("prefix-${FOO}-suffix", { FOO: "X" })).toBe("prefix-X-suffix");
  });

  it("uses the ${VAR:-default} fallback when unset or empty", () => {
    expect(interpolateEnv("${MISSING:-fallback}", {})).toBe("fallback");
    expect(interpolateEnv("${EMPTY:-fallback}", { EMPTY: "" })).toBe("fallback");
    expect(interpolateEnv("${SET:-ignored}", { SET: "yes" })).toBe("yes");
  });

  it("throws on missing variables with no default", () => {
    expect(() => interpolateEnv("${NOPE}", {})).toThrow(InitConfigError);
    expect(() => interpolateEnv("${NOPE}", {})).toThrow(
      /Missing required environment variable 'NOPE'/
    );
  });

  it("the error identifies the config field path", () => {
    expect(() => interpolateEnv({ libraries: [{ path: "${NOPE}" }] }, {}, [])).toThrow(
      /'libraries\.0\.path'/
    );
  });

  it("recurses into arrays and objects", () => {
    const out = interpolateEnv(
      {
        adminPassword: "${PW}",
        libraries: [{ name: "Movies", path: "${MOVIES:-/srv/movies}" }],
      },
      { PW: "s3cr3t" }
    );
    expect(out).toEqual({
      adminPassword: "s3cr3t",
      libraries: [{ name: "Movies", path: "/srv/movies" }],
    });
  });

  it("treats $$ as an escape for a literal $", () => {
    expect(interpolateEnv("$$NOT_A_VAR", {})).toBe("$NOT_A_VAR");
    expect(interpolateEnv("mix-$${FOO}-${FOO}", { FOO: "v" })).toBe("mix-${FOO}-v");
  });

  it("leaves unknown placeholder syntax alone", () => {
    // Not a valid identifier -> left as-is rather than throwing.
    expect(interpolateEnv("${lowercase-name}", {})).toBe("${lowercase-name}");
  });
});

describe("loadInitConfig", () => {
  it("loads a minimal valid config", () => {
    const p = writeTempJson({ adminUsername: "a", adminPassword: "b" });
    const cfg = loadInitConfig(p);
    expect(cfg.adminUsername).toBe("a");
    expect(cfg.adminPassword).toBe("b");
  });

  it("expands ${VAR} placeholders via the supplied env", () => {
    const p = writeTempJson({
      adminUsername: "admin",
      adminPassword: "${EMBY_ADMIN_PW}",
      libraries: [{ name: "Movies", path: "${MOVIES_PATH:-/srv/movies}" }],
    });
    const cfg = loadInitConfig(p, { EMBY_ADMIN_PW: "pw123" });
    expect(cfg.adminPassword).toBe("pw123");
    expect(cfg.libraries?.[0].path).toBe("/srv/movies");
  });

  it("fails when a required field is missing", () => {
    const p = writeTempJson({ adminUsername: "a" });
    expect(() => loadInitConfig(p, {})).toThrow(/adminPassword/);
  });

  it("rejects unknown top-level fields (strict schema)", () => {
    const p = writeTempJson({ adminUsername: "a", adminPassword: "b", unknownField: true });
    expect(() => loadInitConfig(p, {})).toThrow(/unknownField/);
  });

  it("rejects malformed library entries", () => {
    const p = writeTempJson({
      adminUsername: "a",
      adminPassword: "b",
      libraries: [{ name: "Movies" }], // missing `path`
    });
    expect(() => loadInitConfig(p, {})).toThrow(/libraries\.0\.path/);
  });

  it("reports a useful error for malformed JSON", () => {
    const p = writeTempRaw("{ not json");
    expect(() => loadInitConfig(p, {})).toThrow(/not valid JSON/);
  });

  it("reports a useful error when the file does not exist", () => {
    expect(() => loadInitConfig("/nonexistent/path/to/config.json", {})).toThrow(/Unable to read/);
  });

  it("includes the field path in env-var interpolation failures", () => {
    const p = writeTempJson({
      adminUsername: "admin",
      adminPassword: "${MISSING_PW}",
    });
    expect(() => loadInitConfig(p, {})).toThrow(/'adminPassword'/);
  });
});

describe("toInitOptions", () => {
  it("passes every field through to InitOptions", () => {
    const opts = toInitOptions({
      adminUsername: "u",
      adminPassword: "p",
      uiCulture: "en-GB",
      metadataCountry: "GB",
      metadataLanguage: "en",
      libraries: [{ name: "M", path: "/m" }],
      requireFresh: true,
      refreshLibraries: true,
    });
    expect(opts).toEqual({
      adminUsername: "u",
      adminPassword: "p",
      uiCulture: "en-GB",
      metadataCountry: "GB",
      metadataLanguage: "en",
      libraries: [{ name: "M", path: "/m" }],
      requireFresh: true,
      refreshLibraries: true,
    });
  });
});
