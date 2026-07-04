/**
 * The ORCHESTRATOR CONTEXT PROVIDER (`orchestrator/context_provider.ts`).
 *
 * Contract under test: `assembleSubAgentContext` composes the escalation ladder
 * (rung selection) with cache-stable rendering into ONE block a builder drops
 * into a sub-agent prompt. The behaviors to pin:
 *   (1) byte-stability — the same symbols + graph yield identical `contextBlock`
 *       and `contentKey` across calls (the cache-affinity property);
 *   (2) budget selection — a tiny budget picks the cheapest rung (flagging
 *       `overBudget` when even that exceeds it); a generous budget picks the
 *       richest-that-fits;
 *   (3) no budget → each symbol's `recommended` rung;
 *   (4) an unresolvable symbol is skipped with a note, others still included;
 *   (5) `prefixKey` is order-insensitive over symbols and graph-version-sensitive.
 *
 * Fixtures mirror `context_escalation.test.ts`: synthetic in-memory graph + small
 * temp source files (the packer reads real file text off each node's range).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Db } from "../src/db/queries.ts";
import type { NodeKind } from "../src/graph/types.ts";
import { assembleSubAgentContext, nextRungLevel, RUNG_LEVELS } from "../src/orchestrator/context_provider.ts";

function freshDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  return db;
}

function seedNode(
  db: Db,
  id: string,
  name: string,
  file: string,
  start: number,
  end: number,
  kind: NodeKind = "function",
): void {
  db.upsertNode({
    id,
    name,
    qualified_name: name,
    kind,
    language: "typescript",
    file,
    range: [start, end],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

function callEdge(db: Db, src: string, dst: string, weight = 1): void {
  db.upsertEdge({ src, dst, kind: "static_call", weight, last_seen: 0 });
}

function writeSource(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

let repoRoot: string;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "hayven-provider-"));
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/** A small graph: entry() → mid() → deep(), each in its own file with a multi-
 *  line body, so the ladder has distinct pack / 2-hop / whole-file rungs. */
function buildGraph(): Db {
  const db = freshDb();
  const entrySrc = [
    "import { mid } from './mid';",
    "",
    "export function entry(x: number): number {",
    "  // do a bit of work then delegate",
    "  const y = x * 2;",
    "  return mid(y);",
    "}",
  ].join("\n");
  const midSrc = [
    "import { deep } from './deep';",
    "",
    "export function mid(n: number): number {",
    "  const scaled = n + 1;",
    "  return deep(scaled);",
    "}",
  ].join("\n");
  const deepSrc = [
    "export function deep(v: number): number {",
    "  let acc = 0;",
    "  for (let i = 0; i < v; i++) acc += i;",
    "  return acc;",
    "}",
  ].join("\n");
  writeSource(repoRoot, "src/entry.ts", entrySrc);
  writeSource(repoRoot, "src/mid.ts", midSrc);
  writeSource(repoRoot, "src/deep.ts", deepSrc);
  seedNode(db, "entry", "entry", "src/entry.ts", 3, 7);
  seedNode(db, "mid", "mid", "src/mid.ts", 3, 6);
  seedNode(db, "deep", "deep", "src/deep.ts", 1, 5);
  callEdge(db, "entry", "mid");
  callEdge(db, "mid", "deep");

  // A `multi` symbol calling three distinct callees in their own files, so the
  // `maxNeighbors` packer option actually changes how many neighbor bodies the
  // pack rung contains (used by the prefixKey-vs-packer-option regression).
  const multiSrc = [
    "export function multi(): number {",
    "  return c1() + c2() + c3();",
    "}",
  ].join("\n");
  writeSource(repoRoot, "src/multi.ts", multiSrc);
  for (const c of ["c1", "c2", "c3"]) {
    writeSource(repoRoot, `src/${c}.ts`, `export function ${c}(): number {\n  return 1;\n}`);
    seedNode(db, c, c, `src/${c}.ts`, 1, 3);
  }
  seedNode(db, "multi", "multi", "src/multi.ts", 1, 3);
  callEdge(db, "multi", "c1", 3);
  callEdge(db, "multi", "c2", 2);
  callEdge(db, "multi", "c3", 1);
  return db;
}

describe("assembleSubAgentContext — cache stability", () => {
  it("produces a byte-identical block + contentKey across calls (cache-affinity)", () => {
    const db = buildGraph();
    const a = assembleSubAgentContext(db, repoRoot, { symbols: ["entry"] });
    const b = assembleSubAgentContext(db, repoRoot, { symbols: ["entry"] });
    expect(a.contextBlock.length).toBeGreaterThan(0);
    expect(a.contextBlock).toBe(b.contextBlock);
    expect(a.contentKey).toBe(b.contentKey);
    expect(a.symbols).toHaveLength(1);
    expect(a.symbols[0]!.symbol).toBe("entry");
  });
});

describe("assembleSubAgentContext — budget selection", () => {
  it("a tiny budget picks the cheapest rung and flags overBudget when nothing fits", () => {
    const db = buildGraph();
    const tiny = assembleSubAgentContext(db, repoRoot, { symbols: ["entry"] }, { budgetTokens: 1 });
    expect(tiny.symbols[0]!.overBudget).toBe(true);
    // overBudget chooses the cheapest rung — the plain "pack".
    expect(tiny.symbols[0]!.rung).toBe("pack");
    expect(tiny.notes.some((n) => n.includes("exceeds the budget"))).toBe(true);
  });

  it("a generous budget picks the richest rung that fits (whole-file)", () => {
    const db = buildGraph();
    // First learn the rung costs with no budget.
    const free = assembleSubAgentContext(db, repoRoot, { symbols: ["entry"] });
    const big = assembleSubAgentContext(db, repoRoot, { symbols: ["entry"] }, { budgetTokens: 100_000 });
    expect(big.symbols[0]!.overBudget).toBe(false);
    // PIN the claimed behavior: a huge budget must select the RICHEST rung, not
    // merely something ≥ recommended (which a stuck-on-pack-2hop bug would also
    // satisfy). entry's ladder tops out at whole-file.
    expect(big.symbols[0]!.rung).toBe("whole-file");
    // And it costs ≥ the no-budget recommended rung.
    expect(big.symbols[0]!.estTokens).toBeGreaterThanOrEqual(free.symbols[0]!.estTokens);
  });

  it("prefixKey differs across budgets that select different rungs (no false cache hit)", () => {
    const db = buildGraph();
    const tiny = assembleSubAgentContext(db, repoRoot, { symbols: ["entry"] }, { budgetTokens: 1, graphVersion: "v1" });
    const big = assembleSubAgentContext(db, repoRoot, { symbols: ["entry"] }, { budgetTokens: 100_000, graphVersion: "v1" });
    // Different budgets → different chosen rung → different block → the up-front
    // prefixKey MUST differ, or a builder reuses the wrong rung's cached bytes.
    expect(tiny.symbols[0]!.rung).not.toBe(big.symbols[0]!.rung);
    expect(tiny.contentKey).not.toBe(big.contentKey);
    expect(tiny.prefixKey).not.toBe(big.prefixKey);
  });

  it("prefixKey differs when a packer option (maxNeighbors) changes the block (no false cache hit)", () => {
    // Regression: budget + maxRung were folded into the prefixKey's version, but
    // the PACKER options (maxNeighbors/maxHeaderLines/maxRefSliceLines/neighbors)
    // equally change which slices a rung contains — so the SAME symbols + graph +
    // budget + maxRung under DIFFERENT packer options produce a DIFFERENT block.
    // A prefixKey that omitted them collides and hands a builder a false cache
    // hit for the wrong block's bytes.
    const db = buildGraph();
    const few = assembleSubAgentContext(
      db,
      repoRoot,
      { symbols: ["multi"] },
      { graphVersion: "v1", maxRung: "pack", maxNeighbors: 1 },
    );
    const many = assembleSubAgentContext(
      db,
      repoRoot,
      { symbols: ["multi"] },
      { graphVersion: "v1", maxRung: "pack", maxNeighbors: 3 },
    );
    // The blocks genuinely differ (more neighbor bodies under the higher cap)…
    expect(few.contextBlock).not.toBe(many.contextBlock);
    expect(few.contentKey).not.toBe(many.contentKey);
    // …so the up-front prefixKey MUST differ too.
    expect(few.prefixKey).not.toBe(many.prefixKey);
  });
});

describe("assembleSubAgentContext — multi-symbol + resolution", () => {
  it("skips an unresolvable symbol with a note, keeps the resolvable one", () => {
    const db = buildGraph();
    const out = assembleSubAgentContext(db, repoRoot, { symbols: ["entry", "nope_no_such_symbol_xyz"] });
    const syms = out.symbols.map((s) => s.symbol);
    expect(syms).toContain("entry");
    expect(out.symbols.some((s) => s.symbol === "nope_no_such_symbol_xyz")).toBe(false);
    expect(out.notes.some((n) => n.includes("did not resolve"))).toBe(true);
  });

  it("prefixKey is order-insensitive over symbols and graph-version sensitive", () => {
    const db = buildGraph();
    const ab = assembleSubAgentContext(db, repoRoot, { symbols: ["entry", "mid"] }, { graphVersion: "v1" });
    const ba = assembleSubAgentContext(db, repoRoot, { symbols: ["mid", "entry"] }, { graphVersion: "v1" });
    const v2 = assembleSubAgentContext(db, repoRoot, { symbols: ["entry", "mid"] }, { graphVersion: "v2" });
    expect(ab.prefixKey).toBe(ba.prefixKey);
    expect(ab.prefixKey).not.toBe(v2.prefixKey);
  });

  it("with no resolvable symbols the block is empty and symbols is []", () => {
    const db = buildGraph();
    const out = assembleSubAgentContext(db, repoRoot, { symbols: ["ghost1", "ghost2"] });
    expect(out.contextBlock).toBe("");
    expect(out.symbols).toHaveLength(0);
  });

  it("two raw inputs resolving to the SAME id share the prefixKey of the single (no false cache miss)", () => {
    // Regression: an EXACT id and a fuzzy NAME can both land on the same node
    // (the fuzzy one via the top FTS hit). The rendered block dedups by slice, so
    // `contextBlock`/`contentKey` are byte-identical to packing the symbol once.
    // The up-front `prefixKey` must track the resolved-symbol SET, not the input
    // multiplicity — otherwise the duplicate yields a DIFFERENT prefixKey for an
    // identical block, a false cache MISS for a builder doing an up-front lookup.
    const db = buildGraph();
    // "entry" is the exact id; it also fuzzy-resolves to itself as the top hit.
    const dup = assembleSubAgentContext(db, repoRoot, { symbols: ["entry", "entry"] }, { graphVersion: "v1" });
    const single = assembleSubAgentContext(db, repoRoot, { symbols: ["entry"] }, { graphVersion: "v1" });
    // Both resolved inputs map to the same node, so the deduped block matches…
    expect(dup.contextBlock).toBe(single.contextBlock);
    expect(dup.contentKey).toBe(single.contentKey);
    // …and the up-front prefixKey must match too (the cache-decision parity).
    expect(dup.prefixKey).toBe(single.prefixKey);
  });
});

describe("assembleSubAgentContext — escalate-on-failure (level override)", () => {
  it("level pins the rung, overriding budget and recommended", () => {
    const db = buildGraph();
    // level wins even when a tiny budget would otherwise force the cheapest rung.
    const atWhole = assembleSubAgentContext(db, repoRoot, { symbols: ["entry"] }, { level: "whole-file", budgetTokens: 1 });
    expect(atWhole.symbols[0]!.rung).toBe("whole-file");
    expect(atWhole.symbols[0]!.overBudget).toBe(false); // budget ignored under level
    const atPack = assembleSubAgentContext(db, repoRoot, { symbols: ["entry"] }, { level: "pack", budgetTokens: 100_000 });
    expect(atPack.symbols[0]!.rung).toBe("pack");
  });

  it("climbing the ladder yields progressively richer (≥ cost) blocks with distinct prefixKeys", () => {
    const db = buildGraph();
    let level: ReturnType<typeof nextRungLevel> = "pack";
    const seen: { level: string; tokens: number; prefixKey: string }[] = [];
    while (level) {
      const ctx = assembleSubAgentContext(db, repoRoot, { symbols: ["entry"] }, { level, graphVersion: "v1" });
      seen.push({ level, tokens: ctx.estTokens, prefixKey: ctx.prefixKey });
      level = nextRungLevel(level);
    }
    // The loop visited every rung level in order.
    expect(seen.map((s) => s.level)).toEqual([...RUNG_LEVELS]);
    // Each level keys a DISTINCT cacheable prefix (no false reuse across rungs).
    expect(new Set(seen.map((s) => s.prefixKey)).size).toBe(seen.length);
    // Richer rungs are not cheaper than the pack rung (whole-file ≥ pack).
    expect(seen[seen.length - 1]!.tokens).toBeGreaterThanOrEqual(seen[0]!.tokens);
  });

  it("nextRungLevel walks pack → pack-2hop → whole-file → null", () => {
    expect(nextRungLevel("pack")).toBe("pack-2hop");
    expect(nextRungLevel("pack-2hop")).toBe("whole-file");
    expect(nextRungLevel("whole-file")).toBeNull();
  });
});
