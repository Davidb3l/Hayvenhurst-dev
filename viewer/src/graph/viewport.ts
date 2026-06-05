// Viewport-culling math for the SVG graph renderer.
//
// PRD §12.3 LOD technique #2: only nodes within the visible viewport (plus a
// margin buffer) exist in the DOM at all. Out-of-view nodes are not mounted;
// they are not `display:none`, they don't have ARIA stubs, they are simply
// absent from the tree until pan/zoom brings them into range.
//
// We work in *graph space* (the coordinate system the force layout writes
// node positions into). The current pan/zoom viewport (`Viewport` from
// `./interact`) describes a screen-to-graph transform `tx, ty, s`:
//
//     screen.x = graph.x * s + tx
//     screen.y = graph.y * s + ty
//
// Given the on-screen container dimensions, the visible graph-space rectangle
// is therefore:
//
//     gx0 = (0 - tx) / s,       gy0 = (0 - ty) / s
//     gx1 = (width  - tx) / s,  gy1 = (height - ty) / s
//
// We expand by `marginPx` (a *screen* pixel margin) divided by `s` so the
// buffer stays constant in screen pixels regardless of zoom — this is what
// keeps fast pans from flashing empty tiles.

import type { Viewport } from "./interact";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Compute the visible graph-space rectangle from a viewport + container size.
 * `marginPx` is a *screen-pixel* buffer; it is divided by the zoom scale so
 * the buffer stays roughly 200px on screen regardless of zoom level.
 */
export function visibleRect(v: Viewport, width: number, height: number, marginPx = 200): Rect {
  const s = v.s || 1;
  const m = marginPx / s;
  return {
    x0: -v.tx / s - m,
    y0: -v.ty / s - m,
    x1: (width - v.tx) / s + m,
    y1: (height - v.ty) / s + m,
  };
}

/** Cheap point-in-rect test. */
export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/**
 * Filter node indices to those inside the visible rect. We return *indices*
 * so callers can keep parallel arrays for positions / metadata without an
 * extra Map lookup per node.
 */
export function cullIndices(
  nodes: ReadonlyArray<{ x: number; y: number }>,
  rect: Rect,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (contains(rect, n.x, n.y)) out.push(i);
  }
  return out;
}
