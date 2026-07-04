/**
 * Surface #1 — the public context contract (`db/context_helper.ts`).
 *
 * The property under test is the one the plain cache-stable renderer does NOT
 * give: **append-only, never-rewrite**. As the input grows across calls (more
 * regions, more symbols, an escalation hop), the prior render must stay a strict
 * byte PREFIX of the new one — new slices append at the end, the preserved prefix
 * is never rewritten — so a token-constrained builder keeps its cached prompt
 * prefix warm. These tests seed a tiny on-disk repo + a graph that mirrors it and
 * assert:
 *   (1) no-prior parity — a fresh render is byte-identical to `renderStablePacks`;
 *   (2) pure append — growing the symbol set with `prior` keeps prior.text as a
 *       strict prefix even when the new slice would sort BEFORE an existing one
 *       (where the total order WOULD rewrite the prefix);
 *   (3) honest break on edit — a prior slice whose source changed across the TTL
 *       ends the preserved prefix (correctness over cache affinity);
 *   (4) honest break on shrink — removing a span the prior render led with breaks
 *       the prefix too;
 *   (5) contextForChange append-only across growing change regions;
 *   (6) interchangeable continuations — a `prior` from one entry point extends a
 *       render from the other.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { renderStablePacks } from "../src/db/context_cache.ts";
import { contextForChange, contextForSymbols } from "../src/db/context_helper.ts";
import { buildContextPackForSymbols } from "../src/db/context_pack.ts";
import { Db } from "../src/db/queries.ts";
import type { NodeKind } from "../src/graph/types.ts";

// Three single-function files whose names sort a < b < m. `m.ts` packs FIRST in
// time but LAST in the canonical (file,line) order, so adding `a.ts` later is the
// case that distinguishes append-only from the total order.
const A_TS = `import { x } from "./x";

export function fa(): number {
  return 1;
}
`;
const B_TS = `import { x } from "./x";

export function fb(): number {
  return 2;
}
`;
const M_TS = `import { x } from "./x";

export function fm(): number {
  return 9;
}
`;
// A two-entity file for the change-region tests.
const MULTI_TS = `import { z } from "./z";

export function one(): number {
  return 1;
}

export function two(): number {
  return 2;
}
`;

function writeRepo(files: ReadonlyArray<readonly [string, string]>): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-ctxhelper-"));
  for (const [rel, content] of files) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function node(
  db: Db,
  id: string,
  file: string,
  range: [number, number],
  kind: NodeKind = "function",
) {
  db.upsertNode({
    id,
    name: id.split("::").pop() ?? id,
    qualified_name: id,
    kind,
    language: "typescript",
    file,
    range,
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

/** Seed the three single-function files + the two-entity file. No edges → each
 *  symbol's pack is just header + target, which keeps the ordering assertions
 *  about the contract, not about neighbor ranking. */
function seed(db: Db): string {
  db.migrate();
  const root = writeRepo([
    ["a.ts", A_TS],
    ["b.ts", B_TS],
    ["m.ts", M_TS],
    ["multi.ts", MULTI_TS],
  ]);
  node(db, "a.ts::fa", "a.ts", [3, 5]);
  node(db, "b.ts::fb", "b.ts", [3, 5]);
  node(db, "m.ts::fm", "m.ts", [3, 5]);
  node(db, "multi.ts::one", "multi.ts", [3, 5]);
  node(db, "multi.ts::two", "multi.ts", [7, 9]);
  return root;
}

describe("contextForSymbols — no-prior parity", () => {
  it("renders byte-identically to renderStablePacks of the same pack", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const r = contextForSymbols(db, root, ["a.ts::fa"]);
    expect(r).not.toBeNull();
    if (!r) return;

    const pack = buildContextPackForSymbols(db, root, ["a.ts::fa"]);
    expect(pack).not.toBeNull();
    if (!pack) return;
    const stable = renderStablePacks([pack]);

    expect(r.text).toBe(stable.text);
    expect(r.contentKey).toBe(stable.contentKey);
    // No prior → the whole render is "new"; nothing was preserved from a prior.
    expect(r.stablePrefixBytes).toBe(0);
    expect(r.priorFullyPreserved).toBe(true);
  });
});

describe("contextForSymbols — append-only growth", () => {
  it("keeps prior.text as a strict prefix even when the new slice sorts first", () => {
    const db = new Db(":memory:");
    const root = seed(db);

    // First pack m.ts (sorts LAST), then add a.ts (sorts FIRST). The total order
    // would put a.ts ahead of m.ts and rewrite the whole prefix; append-only must
    // keep m.ts in place and append a.ts.
    const r1 = contextForSymbols(db, root, ["m.ts::fm"]);
    expect(r1).not.toBeNull();
    if (!r1) return;

    const r2 = contextForSymbols(db, root, ["m.ts::fm", "a.ts::fa"], { prior: r1 });
    expect(r2).not.toBeNull();
    if (!r2) return;

    // Pure append: prior is preserved in full as a strict prefix.
    expect(r2.text.startsWith(r1.text)).toBe(true);
    expect(r2.priorFullyPreserved).toBe(true);
    expect(r2.stablePrefixBytes).toBe(Buffer.byteLength(r1.text, "utf8"));
    expect(r2.text.length).toBeGreaterThan(r1.text.length);
    // a.ts content arrived in the appended tail.
    expect(r2.text).toContain("function fa");

    // And this genuinely differs from the total order — proving append-only did
    // real work (the total render leads with a.ts, so r1.text is NOT its prefix).
    const total = renderStablePacks([
      buildContextPackForSymbols(db, root, ["m.ts::fm", "a.ts::fa"])!,
    ]);
    expect(total.text.startsWith(r1.text)).toBe(false);
    expect(total.text).not.toBe(r2.text);
  });

  it("a no-op re-render with the same set is byte-identical (full cache hit)", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const r1 = contextForSymbols(db, root, ["m.ts::fm", "a.ts::fa"]);
    const r2 = contextForSymbols(db, root, ["m.ts::fm", "a.ts::fa"], { prior: r1! });
    expect(r2!.text).toBe(r1!.text);
    expect(r2!.priorFullyPreserved).toBe(true);
    expect(r2!.stablePrefixBytes).toBe(Buffer.byteLength(r1!.text, "utf8"));
  });
});

describe("contextForSymbols — honest prefix breaks (correctness over cache)", () => {
  it("breaks the preserved prefix when a prior slice's source changed", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const r1 = contextForSymbols(db, root, ["m.ts::fm"]);
    expect(r1).not.toBeNull();
    if (!r1) return;

    // Edit m.ts on disk across the "TTL" — the body the prior slice rendered is
    // now stale, so the contract must NOT keep it as a cache prefix.
    writeFileSync(
      join(root, "m.ts"),
      `import { x } from "./x";

export function fm(): number {
  return 1000;
}
`,
    );
    const r2 = contextForSymbols(db, root, ["m.ts::fm", "a.ts::fa"], { prior: r1 });
    expect(r2).not.toBeNull();
    if (!r2) return;

    expect(r2.priorFullyPreserved).toBe(false);
    expect(r2.stablePrefixBytes).toBeLessThan(Buffer.byteLength(r1.text, "utf8"));
    expect(r2.text).toContain("return 1000"); // current source, never the stale body
    expect(r2.text).not.toContain("return 9");
  });

  it("breaks the prefix when the set SHRINKS past the leading slice", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    // Lead with a.ts (sorts first), then drop it.
    const r1 = contextForSymbols(db, root, ["a.ts::fa", "m.ts::fm"]);
    expect(r1).not.toBeNull();
    if (!r1) return;
    expect(r1.text.indexOf("function fa")).toBeLessThan(r1.text.indexOf("function fm"));

    const r2 = contextForSymbols(db, root, ["m.ts::fm"], { prior: r1 });
    expect(r2).not.toBeNull();
    if (!r2) return;
    expect(r2.priorFullyPreserved).toBe(false);
    expect(r2.stablePrefixBytes).toBe(0); // the very first prior slice (a.ts) is gone
    expect(r2.text).toContain("function fm");
    expect(r2.text).not.toContain("function fa");
  });
});

describe("contextForChange — append-only across growing regions", () => {
  it("appends a second changed entity without rewriting the first", () => {
    const db = new Db(":memory:");
    const root = seed(db);

    const r1 = contextForChange(db, root, "multi.ts", [{ startLine: 4, endLine: 4 }]);
    expect(r1).not.toBeNull();
    if (!r1) return;
    expect(r1.text).toContain("function one");
    expect(r1.text).not.toContain("function two");

    const r2 = contextForChange(
      db,
      root,
      "multi.ts",
      [
        { startLine: 4, endLine: 4 },
        { startLine: 8, endLine: 8 },
      ],
      { prior: r1 },
    );
    expect(r2).not.toBeNull();
    if (!r2) return;
    expect(r2.text.startsWith(r1.text)).toBe(true);
    expect(r2.priorFullyPreserved).toBe(true);
    expect(r2.text).toContain("function two");
  });
});

describe("interchangeable continuations", () => {
  it("a contextForChange prior extends a contextForSymbols render", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    // Prior: the change pack for `one` (header + target one).
    const prior = contextForChange(db, root, "multi.ts", [{ startLine: 4, endLine: 4 }]);
    expect(prior).not.toBeNull();
    if (!prior) return;

    // Extend with the SYMBOL `two` from the same file — its target appends, and
    // the shared header + `one` target (identical bytes) stay the preserved prefix.
    const next = contextForSymbols(db, root, ["multi.ts::one", "multi.ts::two"], {
      prior,
    });
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.text.startsWith(prior.text)).toBe(true);
    expect(next.priorFullyPreserved).toBe(true);
    expect(next.text).toContain("function two");
  });
});
