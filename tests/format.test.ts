import { describe, it, expect } from "vitest";
import { formatOutput } from "../src/format.js";

describe("formatOutput", () => {
  const users = [
    { Id: "u1", Name: "alice", Role: "admin" },
    { Id: "u2", Name: "bob", Role: "user" },
  ];

  it("json formats an array as pretty-printed JSON", () => {
    const out = formatOutput(users, "json");
    expect(JSON.parse(out)).toEqual(users);
    expect(out).toContain("\n");
  });

  it("yaml formats an array as YAML", () => {
    const out = formatOutput(users, "yaml");
    expect(out).toContain("- Id: u1");
    expect(out).toContain("Name: alice");
  });

  it("table formats an array as an ASCII table", () => {
    const out = formatOutput(users, "table");
    expect(out).toContain("Id");
    expect(out).toContain("Name");
    expect(out).toContain("alice");
    expect(out).toContain("bob");
  });

  it("table with explicit columns projects only those", () => {
    const out = formatOutput(users, "table", { columns: ["Id"] });
    expect(out).toContain("Id");
    expect(out).not.toContain("admin");
  });

  it("table unwraps Emby Items envelope", () => {
    const out = formatOutput({ Items: users, TotalRecordCount: 2 }, "table");
    expect(out).toContain("alice");
  });

  it("table falls back to JSON for non-array scalars", () => {
    const out = formatOutput({ hello: "world" }, "table");
    expect(JSON.parse(out)).toEqual({ hello: "world" });
  });

  it("table returns a placeholder for empty arrays", () => {
    expect(formatOutput([], "table")).toBe("(no results)");
  });
});
