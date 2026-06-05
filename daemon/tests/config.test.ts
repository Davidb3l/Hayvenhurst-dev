import { describe, expect, it } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { ConfigError, deepMerge, validateConfig } from "../src/config/load.ts";

describe("deepMerge", () => {
  it("merges nested objects without mutating inputs", () => {
    const a = { x: 1, models: { tier1: { provider: "p", model: "m" } } };
    const b = { models: { tier1: { model: "m2" } } };
    const c = deepMerge(a, b);
    expect((c as typeof a).models.tier1.model).toBe("m2");
    expect((c as typeof a).models.tier1.provider).toBe("p");
    expect((a as typeof a).models.tier1.model).toBe("m");
  });

  it("replaces arrays rather than concatenating", () => {
    const merged = deepMerge({ peers: ["a"] }, { peers: ["b"] });
    expect((merged as { peers: string[] }).peers).toEqual(["b"]);
  });
});

describe("validateConfig", () => {
  it("accepts the defaults", () => {
    const v = validateConfig(DEFAULT_CONFIG);
    expect(v.daemon_port).toBe(7777);
  });

  it("rejects bad ports", () => {
    expect(() => validateConfig({ ...DEFAULT_CONFIG, daemon_port: 99999 })).toThrow(ConfigError);
  });

  it("rejects non-string model providers", () => {
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        models: { ...DEFAULT_CONFIG.models, tier1: { provider: 42, model: "x" } },
      }),
    ).toThrow(ConfigError);
  });
});
