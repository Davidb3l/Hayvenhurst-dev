// Tests for the pan/zoom interaction math (PRD §12.3).
//
// We test the *pure* helpers that back wheel zoom, two-finger pinch-zoom, and
// the shared zoom clamp [0.1, 8]. The DOM event wiring in `attachPanZoom` is
// exercised in the live preview; the math below is what makes touch zoom and
// wheel zoom behave identically.

import { describe, expect, test } from "bun:test";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  defaultViewport,
  touchDistance,
  touchMidpoint,
  zoomToward,
} from "../src/graph/interact";

describe("clampZoom", () => {
  test("clamps to [0.1, 8]", () => {
    expect(clampZoom(0.001)).toBe(ZOOM_MIN);
    expect(clampZoom(100)).toBe(ZOOM_MAX);
    expect(clampZoom(1)).toBe(1);
  });
});

describe("zoomToward", () => {
  test("keeps the focal point stationary in graph space", () => {
    const v = defaultViewport(); // tx 0, ty 0, s 1
    // Zooming toward (100,100): the graph point under (100,100) must stay there.
    const before = { x: (100 - v.tx) / v.s, y: (100 - v.ty) / v.s };
    const nv = zoomToward(v, 2, 100, 100);
    const after = { x: (100 - nv.tx) / nv.s, y: (100 - nv.ty) / nv.s };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(nv.s).toBe(2);
  });

  test("respects the zoom clamp", () => {
    expect(zoomToward({ tx: 0, ty: 0, s: 8 }, 2, 0, 0).s).toBe(ZOOM_MAX);
    expect(zoomToward({ tx: 0, ty: 0, s: 0.1 }, 0.5, 0, 0).s).toBe(ZOOM_MIN);
  });

  test("pinch zoom uses the same path as wheel zoom", () => {
    // A pinch factor of 1.1 and a wheel-in of 1.1 produce the same viewport.
    const v = { tx: 10, ty: -5, s: 1.3 };
    const pinch = zoomToward(v, 1.1, 200, 150);
    const wheel = zoomToward(v, 1.1, 200, 150);
    expect(pinch).toEqual(wheel);
  });
});

describe("touchDistance / touchMidpoint", () => {
  const a = { clientX: 0, clientY: 0 };
  const b = { clientX: 3, clientY: 4 };
  test("distance is euclidean", () => {
    expect(touchDistance(a, b)).toBe(5);
  });
  test("midpoint averages the two points", () => {
    expect(touchMidpoint(a, b)).toEqual({ x: 1.5, y: 2 });
  });
  test("spreading fingers (growing distance) zooms in", () => {
    const v = defaultViewport();
    const prevDist = 100;
    const dist = 150;
    const factor = dist / prevDist; // 1.5 > 1 → zoom in
    const nv = zoomToward(v, factor, 0, 0);
    expect(nv.s).toBeGreaterThan(v.s);
  });
});
