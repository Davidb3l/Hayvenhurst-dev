import { describe, expect, it } from "bun:test";

import { compareSemver } from "../src/cli/doctor.ts";

describe("compareSemver", () => {
  it("compares major/minor/patch", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
  });

  it("strips pre-release suffixes", () => {
    expect(compareSemver("1.3.0-alpha", "1.3.0")).toBe(0);
  });

  it("handles different segment counts", () => {
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
    expect(compareSemver("1", "1.0.1")).toBe(-1);
  });
});
