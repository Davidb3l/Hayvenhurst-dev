/**
 * Cache-stable pack rendering (`db/context_cache.ts`).
 *
 * The cache-affinity property under test: a `ContextPack` rendered for a
 * cacheable prompt prefix must be BYTE-identical across runs of the same
 * symbol+graph, INDEPENDENT of the order the builder assembled the slices in
 * (the builder ranks neighbors by call-weight — a run-varying order). These
 * tests construct `ContextPack`/`ContextSlice` literals directly (no DB / no
 * disk) and assert:
 *   (1) byte-stability — same pack twice → identical `text` + `contentKey`;
 *   (2) order-insensitivity — `renderStablePacks` with packs/slices reordered
 *       → identical `text`;
 *   (3) dedup — an overlapping slice present in two packs appears once;
 *   (4) `cachePrefixKey` is order-insensitive over symbols but graph-version
 *       sensitive;
 *   (5) fence-language derivation per extension.
 */
import { describe, expect, it } from "bun:test";

import type { ContextPack, ContextSlice } from "../src/db/context_pack.ts";
import {
  cachePrefixKey,
  renderStablePack,
  renderStablePacks,
} from "../src/db/context_cache.ts";

/** Build a `ContextSlice` literal with sane defaults; override per case. */
function slice(p: Partial<ContextSlice> & Pick<ContextSlice, "file" | "startLine" | "endLine">): ContextSlice {
  return {
    role: "neighbor",
    id: `${p.file}#${p.startLine}`,
    kind: "function",
    text: `// ${p.file}:${p.startLine}\nbody`,
    ...p,
  };
}

/** Wrap a slice list in a minimal `ContextPack` (only `slices` is read). */
function pack(slices: ContextSlice[]): ContextPack {
  return {
    symbol: "sym",
    resolved: null,
    slices,
    lineCount: 0,
    estTokens: 0,
    notes: [],
    targetFileEstTokens: 0,
    worthwhile: true,
  };
}

describe("renderStablePack — byte-stability", () => {
  const p = pack([
    slice({ role: "header", id: null, kind: "header", file: "src/a.ts", startLine: 1, endLine: 3, text: "import x" }),
    slice({ role: "target", file: "src/a.ts", startLine: 10, endLine: 20, text: "function a() {}" }),
    slice({ role: "neighbor", file: "src/b.ts", startLine: 5, endLine: 8, via: "call", weight: 3, text: "function b() {}" }),
  ]);

  it("renders identical text + contentKey on repeated calls", () => {
    const r1 = renderStablePack(p);
    const r2 = renderStablePack(p);
    expect(r1.text).toBe(r2.text);
    expect(r1.contentKey).toBe(r2.contentKey);
  });

  it("contentKey is the sha256 of text and estTokens is chars/4", () => {
    const r = renderStablePack(p);
    expect(r.contentKey).toMatch(/^[0-9a-f]{64}$/);
    expect(r.estTokens).toBe(Math.ceil(r.text.length / 4));
  });

  it("does not mutate the caller's pack slices", () => {
    const before = p.slices.map((s) => s.startLine);
    renderStablePack(p);
    expect(p.slices.map((s) => s.startLine)).toEqual(before);
  });

  it("emits a stable header with via/weight provenance", () => {
    const r = renderStablePack(p);
    expect(r.text).toContain("### src/b.ts:5-8 (neighbor via call weight 3)");
    expect(r.text).toContain("### src/a.ts:1-3 (header)");
    expect(r.text).toContain("### src/a.ts:10-20 (target)");
  });
});

describe("renderStablePacks — order-insensitivity", () => {
  const h = slice({ role: "header", id: null, kind: "header", file: "src/a.ts", startLine: 1, endLine: 3, text: "import x" });
  const t = slice({ role: "target", file: "src/a.ts", startLine: 10, endLine: 20, text: "function a() {}" });
  const n = slice({ role: "neighbor", file: "src/b.ts", startLine: 5, endLine: 8, via: "call", weight: 3, text: "function b() {}" });

  it("is invariant to slice order within packs", () => {
    const forward = renderStablePacks([pack([h, t, n])]);
    const reversed = renderStablePacks([pack([n, t, h])]);
    expect(forward.text).toBe(reversed.text);
    expect(forward.contentKey).toBe(reversed.contentKey);
  });

  it("is invariant to pack order", () => {
    const ab = renderStablePacks([pack([h, t]), pack([n])]);
    const ba = renderStablePacks([pack([n]), pack([h, t])]);
    expect(ab.text).toBe(ba.text);
    expect(ab.contentKey).toBe(ba.contentKey);
  });

  it("matches renderStablePack for a single pack", () => {
    const one = pack([n, t, h]);
    expect(renderStablePacks([one]).contentKey).toBe(renderStablePack(one).contentKey);
  });

  it("sorts by (file, startLine, endLine, role)", () => {
    const r = renderStablePacks([pack([n, t, h])]);
    const iA1 = r.text.indexOf("src/a.ts:1-3");
    const iA10 = r.text.indexOf("src/a.ts:10-20");
    const iB5 = r.text.indexOf("src/b.ts:5-8");
    // a.ts before b.ts; within a.ts, line 1 before line 10.
    expect(iA1).toBeGreaterThanOrEqual(0);
    expect(iA1).toBeLessThan(iA10);
    expect(iA10).toBeLessThan(iB5);
  });
});

describe("renderStablePacks — dedup", () => {
  it("collapses an overlapping slice present in two packs to one occurrence", () => {
    const shared = slice({ role: "neighbor", file: "src/util.ts", startLine: 1, endLine: 2, text: "function u() {}" });
    const p1 = pack([
      slice({ role: "target", file: "src/a.ts", startLine: 10, endLine: 12, text: "a" }),
      shared,
    ]);
    const p2 = pack([
      slice({ role: "target", file: "src/c.ts", startLine: 4, endLine: 6, text: "c" }),
      // Same file+range as `shared` — different object/role, must still dedup by key.
      slice({ role: "neighbor", file: "src/util.ts", startLine: 1, endLine: 2, text: "function u() {}" }),
    ]);
    const r = renderStablePacks([p1, p2]);
    const occurrences = r.text.split("### src/util.ts:1-2").length - 1;
    expect(occurrences).toBe(1);
  });

  it("is order-insensitive even when two same-key slices carry DIFFERENT text (cache-TTL stale-text case)", () => {
    // The exact scenario the cache exists for: the same (file,start,end,role)
    // span packed at two different times across the TTL, after the file was
    // edited, so the texts differ. Dedup MUST pick a deterministic winner
    // regardless of input order — otherwise the cached prefix silently diverges
    // (the HIGH bug the reviewer proved: stable sort kept "whichever came first").
    const vA = slice({ role: "neighbor", file: "src/f.ts", startLine: 1, endLine: 2, text: "VERSION_A" });
    const vB = slice({ role: "neighbor", file: "src/f.ts", startLine: 1, endLine: 2, text: "VERSION_B" });
    const ab = renderStablePacks([pack([vA]), pack([vB])]);
    const ba = renderStablePacks([pack([vB]), pack([vA])]);
    expect(ab.text).toBe(ba.text); // byte-identical regardless of input order
    expect(ab.contentKey).toBe(ba.contentKey);
    // exactly one variant survives, and it's the deterministic (lexically
    // smallest) one — not "whichever came first".
    expect(ab.text).toContain("VERSION_A");
    expect(ab.text).not.toContain("VERSION_B");
  });

  it("renderStablePack dedups within a single pack", () => {
    const dup = slice({ file: "src/x.ts", startLine: 3, endLine: 4, text: "x" });
    const r = renderStablePack(pack([dup, dup]));
    expect(r.text.split("### src/x.ts:3-4").length - 1).toBe(1);
  });

  it("is order-insensitive when two same-(span,role,text) slices differ ONLY in via/weight provenance", () => {
    // Regression: the same callee BODY can arrive as a `via:"call"` neighbor from
    // one pack and a `via:"ref"` neighbor from another (or with a different
    // call-weight). They share the dedup key (file:start-end) AND the same role +
    // text, so `compareSlices` reaches its tie-break with identical text — yet the
    // rendered HEADER carries via/weight, so the two render DIFFERENT bytes.
    // Without a provenance tie-break, dedup keeps whichever came first in INPUT
    // order, making `text`/`contentKey` input-order-dependent and defeating the
    // byte-stability the whole module promises.
    const viaCall = slice({ role: "neighbor", file: "src/f.ts", startLine: 1, endLine: 2, text: "body", via: "call", weight: 3 });
    const viaRef = slice({ role: "neighbor", file: "src/f.ts", startLine: 1, endLine: 2, text: "body", via: "ref" });
    const ab = renderStablePacks([pack([viaCall]), pack([viaRef])]);
    const ba = renderStablePacks([pack([viaRef]), pack([viaCall])]);
    expect(ab.text).toBe(ba.text);
    expect(ab.contentKey).toBe(ba.contentKey);
    // Exactly one header survives (dedup by span), and it's the deterministic
    // winner regardless of input order.
    expect(ab.text.split("### src/f.ts:1-2").length - 1).toBe(1);
  });

  it("is order-insensitive when two same-(span,role,text) slices differ ONLY in call-weight", () => {
    // Same span+role+text+via:"call", different `weight` — still a different
    // rendered header. The (via, weight) tie-break must pick a deterministic
    // winner regardless of input order.
    const w1 = slice({ role: "neighbor", file: "src/g.ts", startLine: 1, endLine: 2, text: "body", via: "call", weight: 1 });
    const w9 = slice({ role: "neighbor", file: "src/g.ts", startLine: 1, endLine: 2, text: "body", via: "call", weight: 9 });
    const ab = renderStablePacks([pack([w1]), pack([w9])]);
    const ba = renderStablePacks([pack([w9]), pack([w1])]);
    expect(ab.text).toBe(ba.text);
    expect(ab.contentKey).toBe(ba.contentKey);
    expect(ab.text.split("### src/g.ts:1-2").length - 1).toBe(1);
  });
});

describe("cachePrefixKey", () => {
  it("is identical for symbol order [a,b] vs [b,a] at the same graphVersion", () => {
    expect(cachePrefixKey(["a", "b"], "v1")).toBe(cachePrefixKey(["b", "a"], "v1"));
  });

  it("differs across graph versions", () => {
    expect(cachePrefixKey(["a", "b"], "v1")).not.toBe(cachePrefixKey(["a", "b"], "v2"));
  });

  it("returns a sha256 hex digest", () => {
    expect(cachePrefixKey(["a"], "v1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes different symbol sets", () => {
    expect(cachePrefixKey(["a", "b"], "v1")).not.toBe(cachePrefixKey(["a", "c"], "v1"));
  });
});

describe("fence-language derivation", () => {
  const cases: Array<[string, string]> = [
    ["src/a.ts", "typescript"],
    ["src/c.tsx", "tsx"],
    ["src/d.py", "python"],
    ["src/e.rs", "rust"],
    ["src/f.go", "go"],
    ["src/g.md", ""],
    ["Makefile", ""],
  ];
  for (const [file, lang] of cases) {
    it(`derives \`${lang}\` for ${file}`, () => {
      const r = renderStablePack(pack([slice({ file, startLine: 1, endLine: 1, text: "code" })]));
      // Fence opens with the derived language token immediately after the ```.
      expect(r.text).toContain(`\`\`\`${lang}\ncode\n\`\`\``);
    });
  }

  it("honours an explicit fenceLangFor override", () => {
    const r = renderStablePack(
      pack([slice({ file: "src/a.ts", startLine: 1, endLine: 1, text: "code" })]),
      () => "custom",
    );
    expect(r.text).toContain("```custom\ncode\n```");
  });
});
