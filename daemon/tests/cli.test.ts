import { describe, expect, it } from "bun:test";

import { parseArgs } from "../src/cli.ts";

describe("parseArgs", () => {
  it("collects positionals", () => {
    const p = parseArgs(["query", "loginHandler", "auth"]);
    expect(p.positionals).toEqual(["query", "loginHandler", "auth"]);
  });

  it("parses long flags with values", () => {
    const p = parseArgs(["neighbors", "x", "--depth", "3"]);
    expect(p.flags["depth"]).toBe("3");
    expect(p.positionals).toEqual(["neighbors", "x"]);
  });

  it("supports --flag=value", () => {
    const p = parseArgs(["query", "--json=true"]);
    expect(p.flags["json"]).toBe("true");
  });

  it("treats trailing long flags as booleans", () => {
    const p = parseArgs(["query", "foo", "--json"]);
    expect(p.flags["json"]).toBe(true);
  });

  it("parses short flags as booleans", () => {
    const p = parseArgs(["-v"]);
    expect(p.flags["v"]).toBe(true);
  });
});
