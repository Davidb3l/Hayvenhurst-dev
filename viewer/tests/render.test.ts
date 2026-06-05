// Tests for renderer helpers that don't need a live DOM.
//
// Covers the focus-stranding guard: when a focused tier-1+ node downgrades to
// tier 0 it loses its role/tabindex, so the renderer must blur() it first. The
// decision of *whether* to blur is `nodeOwnsFocus`, tested here without a DOM.

import { describe, expect, test } from "bun:test";
import { nodeOwnsFocus } from "../src/graph/render";

const fakeGroup = (children: object[] = []) => ({
  contains(n: Node | null) {
    return n === (this as unknown as object) || children.includes(n as unknown as object);
  },
});

describe("nodeOwnsFocus", () => {
  test("false when nothing is focused", () => {
    expect(nodeOwnsFocus(fakeGroup(), null)).toBe(false);
    expect(nodeOwnsFocus(fakeGroup(), undefined)).toBe(false);
  });

  test("true when the group itself is the active element", () => {
    const g = fakeGroup();
    expect(nodeOwnsFocus(g, g as unknown as Element)).toBe(true);
  });

  test("true when a descendant of the group is focused", () => {
    const child = {};
    const g = fakeGroup([child]);
    expect(nodeOwnsFocus(g, child as unknown as Element)).toBe(true);
  });

  test("false when focus is on an unrelated element", () => {
    const g = fakeGroup([{}]);
    expect(nodeOwnsFocus(g, {} as unknown as Element)).toBe(false);
  });
});
