// Tests for the graceful-degradation trigger rule (PRD §12.3).

import { describe, expect, test } from "bun:test";
import { DEGRADATION_THRESHOLD, shouldDegrade } from "../src/graph/degradation";
import type { NeighborsResponse } from "../src/api/types";

function make(level: NeighborsResponse["cluster_level"], n: number): NeighborsResponse {
  return { center: "*", cluster_level: level, nodes: [], edges: [], total_raw_nodes: n };
}

describe("shouldDegrade", () => {
  test("false when data is missing", () => {
    expect(shouldDegrade(undefined)).toBe(false);
    expect(shouldDegrade(null)).toBe(false);
  });

  test("false when clustering is on (module level)", () => {
    // Clustering succeeded — even a huge raw set is fine to render at module
    // granularity. The degradation rule only fires when clustering is *off*.
    expect(shouldDegrade(make("module", 50_000))).toBe(false);
  });

  test("false when raw count is at or below the 2000 threshold", () => {
    expect(shouldDegrade(make("function", DEGRADATION_THRESHOLD))).toBe(false);
    expect(shouldDegrade(make("function", DEGRADATION_THRESHOLD - 1))).toBe(false);
  });

  test("true only when cluster is off AND raw count exceeds 2000", () => {
    expect(shouldDegrade(make("function", DEGRADATION_THRESHOLD + 1))).toBe(true);
    expect(shouldDegrade(make("function", 100_000))).toBe(true);
  });

  test("zero total_raw_nodes never degrades", () => {
    // Edge case worth pinning down: an empty graph is not a degradation case,
    // it's just an empty graph. UI elsewhere shows "no nodes" copy.
    expect(shouldDegrade(make("function", 0))).toBe(false);
  });

  test("threshold constant matches the PRD value", () => {
    expect(DEGRADATION_THRESHOLD).toBe(2000);
  });
});
