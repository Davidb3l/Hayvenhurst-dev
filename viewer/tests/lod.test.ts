// Tests for the progressive-rendering tier rules (PRD §12.3 LOD #3).

import { describe, expect, test } from "bun:test";
import {
  ZOOM_TIER1_THRESHOLD,
  tierClass,
  tierFor,
  tierIsInteractive,
} from "../src/graph/lod";

const noIx = { hoveredId: null, focusedId: null, selectedId: null };

describe("tierFor", () => {
  test("Tier 0 when zoomed out and not interacting", () => {
    expect(tierFor("a", 1.0, noIx)).toBe(0);
    expect(tierFor("a", ZOOM_TIER1_THRESHOLD - 0.01, noIx)).toBe(0);
  });

  test("Tier 1 once zoom crosses the threshold", () => {
    expect(tierFor("a", ZOOM_TIER1_THRESHOLD, noIx)).toBe(1);
    expect(tierFor("a", 3.0, noIx)).toBe(1);
  });

  test("Tier 2 on hover regardless of zoom", () => {
    expect(tierFor("a", 0.5, { ...noIx, hoveredId: "a" })).toBe(2);
    expect(tierFor("a", 5.0, { ...noIx, hoveredId: "a" })).toBe(2);
  });

  test("Tier 2 on focus or selection", () => {
    expect(tierFor("a", 1.0, { ...noIx, focusedId: "a" })).toBe(2);
    expect(tierFor("a", 1.0, { ...noIx, selectedId: "a" })).toBe(2);
  });

  test("hovering id 'b' does not promote node 'a'", () => {
    expect(tierFor("a", 1.0, { ...noIx, hoveredId: "b" })).toBe(0);
  });

  test("custom threshold respected", () => {
    expect(tierFor("a", 1.0, noIx, 0.5)).toBe(1);
    expect(tierFor("a", 0.4, noIx, 0.5)).toBe(0);
  });
});

describe("tierClass", () => {
  test("returns stable CSS class per tier", () => {
    expect(tierClass(0)).toBe("hv-n0");
    expect(tierClass(1)).toBe("hv-n1");
    expect(tierClass(2)).toBe("hv-n2");
  });
});

describe("tierIsInteractive", () => {
  test("Tier 0 is non-interactive (no ARIA, no tab stop)", () => {
    expect(tierIsInteractive(0)).toBe(false);
  });
  test("Tier 1 and 2 are interactive", () => {
    expect(tierIsInteractive(1)).toBe(true);
    expect(tierIsInteractive(2)).toBe(true);
  });
});
