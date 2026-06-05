// Tests for the viewport-culling math (PRD §12.3 LOD technique #2).

import { describe, expect, test } from "bun:test";
import { contains, cullIndices, visibleRect } from "../src/graph/viewport";
import { defaultViewport } from "../src/graph/interact";

describe("visibleRect", () => {
  test("default viewport covers (0,0) to (w,h) plus margin", () => {
    const r = visibleRect(defaultViewport(), 800, 600, 200);
    // At s=1, margin in graph space == 200px.
    expect(r.x0).toBe(-200);
    expect(r.y0).toBe(-200);
    expect(r.x1).toBe(1000);
    expect(r.y1).toBe(800);
  });

  test("zooming in shrinks the visible graph-space window", () => {
    const r = visibleRect({ tx: 0, ty: 0, s: 2 }, 800, 600, 200);
    // margin in graph-space halves: 200 / 2 = 100.
    expect(r.x0).toBe(-100);
    expect(r.x1).toBe(800 / 2 + 100);
  });

  test("panning shifts the visible window in graph space", () => {
    const r = visibleRect({ tx: -400, ty: -300, s: 1 }, 800, 600, 0);
    expect(r.x0).toBe(400);
    expect(r.x1).toBe(1200);
    expect(r.y0).toBe(300);
    expect(r.y1).toBe(900);
  });

  test("margin defaults to 200px when omitted", () => {
    const r = visibleRect(defaultViewport(), 100, 100);
    expect(r.x0).toBe(-200);
    expect(r.x1).toBe(300);
  });
});

describe("contains", () => {
  const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
  test("includes interior points", () => {
    expect(contains(r, 5, 5)).toBe(true);
  });
  test("includes edge points", () => {
    expect(contains(r, 0, 0)).toBe(true);
    expect(contains(r, 10, 10)).toBe(true);
  });
  test("excludes exterior", () => {
    expect(contains(r, -1, 5)).toBe(false);
    expect(contains(r, 11, 5)).toBe(false);
    expect(contains(r, 5, -1)).toBe(false);
    expect(contains(r, 5, 11)).toBe(false);
  });
});

describe("cullIndices", () => {
  test("returns indices of in-rect nodes only", () => {
    const nodes = [
      { x: 50, y: 50 },
      { x: -100, y: 50 },
      { x: 500, y: 50 },
      { x: 60, y: 60 },
    ];
    const rect = { x0: 0, y0: 0, x1: 100, y1: 100 };
    expect(cullIndices(nodes, rect)).toEqual([0, 3]);
  });

  test("empty when nothing is visible", () => {
    const nodes = [{ x: 9999, y: 9999 }];
    const rect = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(cullIndices(nodes, rect)).toEqual([]);
  });

  test("everything when rect spans positions", () => {
    const nodes = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
    const rect = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
    expect(cullIndices(nodes, rect)).toEqual([0, 1, 2]);
  });
});
