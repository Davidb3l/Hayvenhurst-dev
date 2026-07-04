/**
 * Phase 0.0.4.5 pivot — the context-cost packer (`db/context_pack.ts`).
 *
 * Seeds a tiny on-disk repo (real source files so the line-exact slicing is
 * actually exercised) + a graph that mirrors it, then asserts the pack:
 *   - extracts the file's leading import/header block (line 1 → first decl),
 *   - slices the TARGET entity body by its node range (and nothing else in the
 *     file),
 *   - inlines 1-hop CALLEE bodies (cross-file), highest call-weight first,
 *     deduped, with module nodes excluded,
 *   - honours `--no-neighbors` and the neighbor cap,
 *   - accounts lines + an (approximate) token estimate.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildContextPack } from "../src/db/context_pack.ts";
import { Db } from "../src/db/queries.ts";
import type { EdgeKind, NodeKind } from "../src/graph/types.ts";

const COOKIE_TS = `// SPDX-License-Identifier: MIT
import { parse } from "./util";
import { z } from "zod";

export function serialize(name: string, value: string): string {
  const v = parse(value);
  return \`\${name}=\${v}\`;
}

export function unused(): void {
  return;
}
`;

const UTIL_TS = `export function parse(s: string): string {
  return s.trim();
}
`;

const FORMAT_TS = `export function format(x: number): string {
  return x.toFixed(2);
}
`;

/** Write the fixture repo and return its root. */
function writeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-ctxpack-"));
  for (const [rel, content] of [
    ["src/cookie.ts", COOKIE_TS],
    ["src/util.ts", UTIL_TS],
    ["src/format.ts", FORMAT_TS],
  ] as const) {
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
    name: id.split("/").pop() ?? id,
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

function edge(db: Db, src: string, dst: string, kind: EdgeKind, weight = 1) {
  db.upsertEdge({ src, dst, kind, weight, last_seen: 0 });
}

/** Seed the graph for the fixture repo. `serialize` calls `parse` (×3) and
 *  `format` (×1), imports a module, and shares its file with `unused`. */
function seed(db: Db): string {
  db.migrate();
  const root = writeRepo();
  node(db, "src/cookie.ts::serialize", "src/cookie.ts", [5, 8]);
  node(db, "src/cookie.ts::unused", "src/cookie.ts", [10, 12]);
  node(db, "src/util.ts::parse", "src/util.ts", [1, 3]);
  node(db, "src/format.ts::format", "src/format.ts", [1, 3]);
  node(db, "src/util.ts", "src/util.ts", [1, 3], "module");
  edge(db, "src/cookie.ts::serialize", "src/util.ts::parse", "static_call", 3);
  edge(db, "src/cookie.ts::serialize", "src/format.ts::format", "static_call", 1);
  // An import edge + a module CALL edge: neither should produce a neighbor body.
  edge(db, "src/cookie.ts::serialize", "src/util.ts", "import", 1);
  edge(db, "src/cookie.ts::serialize", "src/util.ts", "static_call", 1);
  return root;
}

describe("buildContextPack", () => {
  it("packs header + target body + ranked callee neighbors", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const pack = buildContextPack(db, root, "src/cookie.ts::serialize");
    expect(pack).not.toBeNull();
    if (!pack) return;

    expect(pack.symbol).toBe("src/cookie.ts::serialize");
    expect(pack.resolved).toBeNull(); // exact match

    const roles = pack.slices.map((s) => s.role);
    expect(roles).toEqual(["header", "target", "neighbor", "neighbor"]);

    // Header = lines 1..3 (license + two imports), stopping before the blank
    // line that precedes the decl — that blank is absorbed as `serialize`'s
    // leading decoration so it doesn't dangle in the header.
    const header = pack.slices[0]!;
    expect(header.startLine).toBe(1);
    expect(header.endLine).toBe(3);
    expect(header.text).toContain('import { parse } from "./util";');
    expect(header.text).not.toContain("function serialize");

    // Target = exactly the entity's lines 5..8 — not `unused`.
    const target = pack.slices[1]!;
    expect(target.role).toBe("target");
    expect(target.startLine).toBe(5);
    expect(target.endLine).toBe(8);
    expect(target.text).toContain("export function serialize");
    expect(target.text).not.toContain("function unused");

    // Neighbors: parse (weight 3) ranks above format (weight 1); both inlined
    // as their own line-exact cross-file bodies; module + import edges excluded.
    const neighbors = pack.slices.slice(2);
    expect(neighbors.map((n) => n.id)).toEqual([
      "src/util.ts::parse",
      "src/format.ts::format",
    ]);
    expect(neighbors[0]!.weight).toBe(3);
    expect(neighbors[0]!.via).toBe("call");
    expect(neighbors[0]!.file).toBe("src/util.ts");
    expect(neighbors[0]!.text).toContain("return s.trim();");
    // The module node "src/util.ts" must NOT appear as a slice body.
    expect(pack.slices.some((s) => s.kind === "module")).toBe(false);

    expect(pack.lineCount).toBeGreaterThan(0);
    expect(pack.estTokens).toBeGreaterThan(0);
    db.close();
  });

  it("omits neighbors when neighbors:false", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const pack = buildContextPack(db, root, "src/cookie.ts::serialize", {
      neighbors: false,
    });
    expect(pack?.slices.map((s) => s.role)).toEqual(["header", "target"]);
    db.close();
  });

  it("caps neighbors and notes the omission", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const pack = buildContextPack(db, root, "src/cookie.ts::serialize", {
      maxNeighbors: 1,
    });
    const neighbors = pack?.slices.filter((s) => s.role === "neighbor") ?? [];
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]!.id).toBe("src/util.ts::parse"); // highest weight kept
    expect(pack?.notes.some((n) => n.includes("omitted"))).toBe(true);
    db.close();
  });

  it("fuzzy-resolves an inexact id and reports it", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const pack = buildContextPack(db, root, "serialize");
    expect(pack).not.toBeNull();
    expect(pack?.symbol).toBe("src/cookie.ts::serialize");
    expect(pack?.resolved).toBe("src/cookie.ts::serialize"); // was fuzzy-resolved
    db.close();
  });

  it("returns null for an unresolvable symbol", () => {
    const db = new Db(":memory:");
    seed(db);
    expect(buildContextPack(db, "/nope", "totallyMissingSymbol")).toBeNull();
    db.close();
  });

  // The boundary the §5 measurement found: a target uses a MODULE-LEVEL const
  // (not a call edge, not an import) → the module-skeleton header must carry it,
  // while still excluding a sibling function's body.
  it("includes module-scope declarations the target uses, not sibling bodies", () => {
    const root = mkdtempSync(join(tmpdir(), "hayven-ctxpack-mod-"));
    const SRC = `import { z } from "zod"

const LIMIT = 42
const TABLE = { a: 1, b: 2 }

export function target(): number {
  return LIMIT + TABLE.a
}

export function sibling(): string {
  return "SECRET_SIBLING_BODY"
}
`;
    const abs = join(root, "src/mod.ts");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, SRC);

    const db = new Db(":memory:");
    db.migrate();
    // Only the two functions are entities (the consts are NOT — mirroring real
    // graphs, where plain value consts aren't extracted). target = lines 6-8,
    // sibling = lines 10-12.
    node(db, "mod/target", "src/mod.ts", [6, 8]);
    node(db, "mod/sibling", "src/mod.ts", [10, 12]);

    const pack = buildContextPack(db, root, "mod/target");
    expect(pack).not.toBeNull();
    const header = (pack?.slices ?? [])
      .filter((s) => s.role === "header")
      .map((s) => s.text)
      .join("\n");
    // The module-scope consts the target references are present…
    expect(header).toContain("const LIMIT = 42");
    expect(header).toContain("const TABLE = { a: 1, b: 2 }");
    expect(header).toContain('import { z } from "zod"');
    // …but the sibling function's BODY is not dragged in.
    const allText = (pack?.slices ?? []).map((s) => s.text).join("\n");
    expect(allText).not.toContain("SECRET_SIBLING_BODY");
    db.close();
  });

  // Skeleton-extension: a same-file ENTITY (type/interface) named in the target
  // signature is inlined via:"ref" (it's not a call edge); and a call edge that
  // mis-resolved into a TEST file is excluded as noise.
  it("inlines referenced same-file type entities and excludes test-file callees", () => {
    const root = mkdtempSync(join(tmpdir(), "hayven-ctxpack-ref-"));
    const SRC = `export interface Opts {
  a: number
}

export function run(o: Opts): number {
  return helper(o.a)
}

export function helper(n: number): number {
  return n * 2
}
`;
    const abs = join(root, "src/mod2.ts");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, SRC);

    const db = new Db(":memory:");
    db.migrate();
    node(db, "mod2/Opts", "src/mod2.ts", [1, 3], "class");
    node(db, "mod2/run", "src/mod2.ts", [5, 7]);
    node(db, "mod2/helper", "src/mod2.ts", [9, 11]);
    node(db, "mod2.test/helperTest", "src/mod2.test.ts", [1, 3]);
    edge(db, "mod2/run", "mod2/helper", "static_call", 1);
    edge(db, "mod2/run", "mod2.test/helperTest", "static_call", 1); // mis-resolved → must be filtered

    const pack = buildContextPack(db, root, "mod2/run");
    const neighbors = (pack?.slices ?? []).filter((s) => s.role === "neighbor");
    const byId = new Map(neighbors.map((n) => [n.id, n]));
    // The real callee is present…
    expect(byId.get("mod2/helper")?.via).toBe("call");
    // …the referenced type entity is inlined via "ref"…
    expect(byId.get("mod2/Opts")?.via).toBe("ref");
    // …and the test-file callee is excluded entirely.
    expect(byId.has("mod2.test/helperTest")).toBe(false);
    expect((pack?.slices ?? []).some((s) => s.file.includes(".test."))).toBe(false);
    db.close();
  });

  // A callee whose range is NESTED inside the target body must not be re-added
  // as a neighbor (its text is already in the target slice).
  it("does not duplicate a nested entity already inside the target body", () => {
    const root = mkdtempSync(join(tmpdir(), "hayven-ctxpack-nest-"));
    const SRC = `export function outer(): number {
  const inner = (): number => 7
  return inner()
}
`;
    const abs = join(root, "src/nest.ts");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, SRC);

    const db = new Db(":memory:");
    db.migrate();
    node(db, "nest/outer", "src/nest.ts", [1, 4]);
    node(db, "nest/outer.inner", "src/nest.ts", [2, 2]); // nested inside outer
    edge(db, "nest/outer", "nest/outer.inner", "static_call", 1);

    const pack = buildContextPack(db, root, "nest/outer");
    // `inner` is inside outer's range → it must NOT appear as its own neighbor.
    expect((pack?.slices ?? []).some((s) => s.id === "nest/outer.inner")).toBe(false);
    expect((pack?.slices ?? []).filter((s) => s.role === "neighbor")).toHaveLength(0);
    db.close();
  });

  // Cross-file: a type imported from another module and used in the target
  // signature is inlined (resolved via the file's module-import edges) — but a
  // huge referenced entity (a big class used only as a type) is skipped.
  it("inlines a small cross-file referenced type, skips an oversized one", () => {
    const root = mkdtempSync(join(tmpdir(), "hayven-ctxpack-xfile-"));
    const bigBody = ["export class Big {"]
      .concat(Array.from({ length: 50 }, (_, i) => `  m${i}(): void {}`))
      .concat(["}"])
      .join("\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src/types.ts"),
      `export interface Handler {\n  run(): void\n}\n\n${bigBody}\n`,
    );
    writeFileSync(
      join(root, "src/app.ts"),
      `import { Handler, Big } from "./types"\n\nexport function run(h: Handler, b: Big): void {\n  h.run()\n}\n`,
    );

    const db = new Db(":memory:");
    db.migrate();
    // Module nodes (carry the import edge) + entities.
    node(db, "src/types.ts", "src/types.ts", [1, 55], "module");
    node(db, "src/app.ts", "src/app.ts", [1, 5], "module");
    node(db, "types/Handler", "src/types.ts", [1, 3], "class");
    node(db, "types/Big", "src/types.ts", [5, 56], "class"); // 52 lines > MAX_REF_LINES
    node(db, "app/run", "src/app.ts", [3, 5]);
    edge(db, "src/app.ts", "src/types.ts", "import", 1); // file-level import edge

    const pack = buildContextPack(db, root, "app/run");
    const ids = (pack?.slices ?? []).map((s) => s.id);
    expect(ids).toContain("types/Handler"); // small cross-file type inlined
    expect(ids).not.toContain("types/Big"); // oversized referenced class skipped
    const handler = (pack?.slices ?? []).find((s) => s.id === "types/Handler");
    expect(handler?.via).toBe("ref");
    db.close();
  });

  // Leaner ref slices: a LARGE referenced type (still ≤ MAX_REF_LINES, so it is
  // INCLUDED) is capped to the first N lines as a line-exact via:"ref" slice and
  // a note records the truncation; a SMALL ref stays whole; callee + target
  // slices remain full-body.
  it("truncates a large ref slice to N line-exact lines, keeps small refs + callee/target whole", () => {
    const root = mkdtempSync(join(tmpdir(), "hayven-ctxpack-reftrunc-"));
    // BigType: 20 lines (1..20) — > N(=5) but ≤ MAX_REF_LINES(40), so included
    // and truncated. SmallType: 3 lines (22..24) — ≤ N, included whole.
    const bigFields = Array.from({ length: 18 }, (_, i) => `  f${i}: number`).join(
      "\n",
    );
    const SRC = `export interface BigType {
${bigFields}
}

export interface SmallType {
  s: string
}

export function run(b: BigType, s: SmallType): number {
  return helper(b.f0)
}

export function helper(n: number): number {
  return n + 1
}
`;
    const abs = join(root, "src/reftrunc.ts");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, SRC);

    const db = new Db(":memory:");
    db.migrate();
    // BigType = lines 1..20 (interface + 18 fields + closing brace).
    node(db, "rt/BigType", "src/reftrunc.ts", [1, 20], "class");
    node(db, "rt/SmallType", "src/reftrunc.ts", [22, 24], "class");
    // run = lines 26..28, helper = 30..32.
    node(db, "rt/run", "src/reftrunc.ts", [26, 28]);
    node(db, "rt/helper", "src/reftrunc.ts", [30, 32]);
    edge(db, "rt/run", "rt/helper", "static_call", 1);

    const pack = buildContextPack(db, root, "rt/run", { maxRefSliceLines: 5 });
    expect(pack).not.toBeNull();
    const byId = new Map((pack?.slices ?? []).map((s) => [s.id, s]));

    // The big ref is truncated to exactly the first 5 lines, line-exact.
    const big = byId.get("rt/BigType")!;
    expect(big.via).toBe("ref");
    expect(big.startLine).toBe(1);
    expect(big.endLine).toBe(5); // 1 + 5 - 1
    expect(big.truncatedFromEndLine).toBe(20);
    // Line-exact: text is the real file lines 1..5, no synthetic markers.
    expect(big.text).toBe(SRC.split("\n").slice(0, 5).join("\n"));
    expect(big.text).toContain("export interface BigType");
    expect(big.text).not.toContain("f17: number"); // a deep field is cut

    // The note records the truncation.
    expect(
      pack?.notes.some(
        (n) => n.includes("rt/BigType") && n.includes("truncated to first 5 of 20"),
      ),
    ).toBe(true);

    // The small ref stays whole (≤ N) — no truncation, no marker field.
    const small = byId.get("rt/SmallType")!;
    expect(small.via).toBe("ref");
    expect(small.startLine).toBe(22);
    expect(small.endLine).toBe(24);
    expect(small.truncatedFromEndLine).toBeUndefined();
    expect(small.text).toBe(SRC.split("\n").slice(21, 24).join("\n"));

    // The callee slice is still FULL-body (not capped by the ref cap).
    const helper = byId.get("rt/helper")!;
    expect(helper.via).toBe("call");
    expect(helper.startLine).toBe(30);
    expect(helper.endLine).toBe(32);
    expect(helper.truncatedFromEndLine).toBeUndefined();

    // The target slice is still FULL-body.
    const target = (pack?.slices ?? []).find((s) => s.role === "target")!;
    expect(target.startLine).toBe(26);
    expect(target.endLine).toBe(28);
    expect(target.truncatedFromEndLine).toBeUndefined();
    db.close();
  });

  // Header hygiene: an EXCLUDED entity's leading doc-comment/decorator block
  // belongs to THAT entity (tree-sitter's node range starts at the decl keyword
  // and omits it), so it must be absorbed into the entity's coverage — not
  // leaked into the module-skeleton header as a junk fragment. (Measured on
  // Go/Rust: per-function doc comments dominated the header.)
  it("does not leak an excluded entity's leading doc-comment/decorator into the header", () => {
    const root = mkdtempSync(join(tmpdir(), "hayven-ctxpack-doclead-"));
    // Go-style: each func is preceded by a `// …` doc comment + blank line. The
    // comments at lines 4-5 (sibling) and 12-14 (target) are NOT in any node
    // range. Only the import block (1-2) is real module scope.
    const SRC = `package router

// sibling does an unrelated thing.
// Second line of the sibling comment.
func sibling() int {
	return 1
}

const Mode = "default"

// target is the function under test.
// It returns two.
func target() int {
	return 2
}
`;
    const abs = join(root, "router.go");
    writeFileSync(abs, SRC);

    const db = new Db(":memory:");
    db.migrate();
    // sibling = lines 5-7, target = lines 13-15 (1-based, func keyword → close).
    node(db, "router/sibling", "router.go", [5, 7], "function");
    node(db, "router/target", "router.go", [13, 15], "function");

    const pack = buildContextPack(db, root, "router/target");
    expect(pack).not.toBeNull();
    const header = (pack?.slices ?? [])
      .filter((s) => s.role === "header")
      .map((s) => s.text)
      .join("\n");
    // The sibling's doc comment must NOT appear in the header.
    expect(header).not.toContain("sibling does an unrelated thing");
    expect(header).not.toContain("Second line of the sibling comment");
    // Nor the target's own doc comment (the target slice carries its own body;
    // the comment above it is the target's decoration, absorbed either way).
    expect(header).not.toContain("target is the function under test");
    // Genuine module scope IS still present: the package line + the const.
    expect(header).toContain("package router");
    expect(header).toContain('const Mode = "default"');
    // And no sibling body leaked in.
    const allText = (pack?.slices ?? []).map((s) => s.text).join("\n");
    expect(allText).not.toContain("return 1");
    db.close();
  });

  // Ref pass is TYPE-ONLY: a same-file `method`/`function` that merely SHARES a
  // common name with the target (e.g. a sibling class's `convert` when the
  // target is also `convert`) must NOT be inlined as a via:"ref" neighbor — that
  // was pure noise (measured: 8-10 junk refs per pack on click/anyhow). A
  // type-like (`class`) entity named in the target IS still inlined.
  it("ref pass inlines type-like entities only, not same-named methods/functions", () => {
    const root = mkdtempSync(join(tmpdir(), "hayven-ctxpack-reftype-"));
    const SRC = `export interface Opts {
  a: number
}

export class Sibling {
  convert(v: string): number {
    return Number(v)
  }
}

export class Target {
  convert(o: Opts): number {
    return o.a
  }
}
`;
    const abs = join(root, "src/conv.ts");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, SRC);

    const db = new Db(":memory:");
    db.migrate();
    node(db, "conv/Opts", "src/conv.ts", [1, 3], "class");
    node(db, "conv/Sibling", "src/conv.ts", [5, 9], "class");
    node(db, "conv/Sibling.convert", "src/conv.ts", [6, 8], "method");
    node(db, "conv/Target", "src/conv.ts", [11, 15], "class");
    node(db, "conv/Target.convert", "src/conv.ts", [12, 14], "method");

    const pack = buildContextPack(db, root, "conv/Target.convert");
    expect(pack).not.toBeNull();
    const ids = (pack?.slices ?? []).map((s) => s.id);
    // The referenced type IS inlined…
    expect(ids).toContain("conv/Opts");
    // …but the sibling's same-named `convert` method is NOT pulled in as a ref.
    expect(ids).not.toContain("conv/Sibling.convert");
    const refKinds = (pack?.slices ?? [])
      .filter((s) => s.via === "ref")
      .map((s) => s.kind);
    expect(refKinds.every((k) => k === "class")).toBe(true);
    db.close();
  });

  // The "worthwhile" signal: false (+ a note) when the pack is no smaller than
  // the target's whole file; true for a normal small-target-in-large-file case.
  it("reports worthwhile=false (with a note) for a file-sized pack, true for a lean slice", () => {
    // (a) NOT worthwhile: a tiny one-entity file — the pack (header + target)
    //     covers essentially the whole file, so it can't be smaller than it.
    const rootA = mkdtempSync(join(tmpdir(), "hayven-ctxpack-worth-no-"));
    const SRC_A = `export function only(): number {
  return 1 + 2 + 3
}
`;
    const absA = join(rootA, "src/only.ts");
    mkdirSync(dirname(absA), { recursive: true });
    writeFileSync(absA, SRC_A);
    const dbA = new Db(":memory:");
    dbA.migrate();
    node(dbA, "only/only", "src/only.ts", [1, 3]);
    const packA = buildContextPack(dbA, rootA, "only/only");
    expect(packA).not.toBeNull();
    expect(packA?.targetFileEstTokens).toBeGreaterThan(0);
    expect(packA!.estTokens).toBeGreaterThanOrEqual(packA!.targetFileEstTokens);
    expect(packA?.worthwhile).toBe(false);
    expect(
      packA?.notes.some(
        (n) => n.includes("not smaller than the target file") && n.includes("whole file"),
      ),
    ).toBe(true);
    dbA.close();

    // (b) Worthwhile: a small target inside a large file (many big sibling
    //     bodies the pack does NOT pull in) → pack ≪ whole file.
    const rootB = mkdtempSync(join(tmpdir(), "hayven-ctxpack-worth-yes-"));
    const filler = Array.from(
      { length: 12 },
      (_, i) =>
        `export function sib${i}(): number {\n  return ${i} * ${i} * ${i} + ${i}\n}\n`,
    ).join("\n");
    const SRC_B = `export function tiny(): number {
  return 7
}

${filler}`;
    const absB = join(rootB, "src/big.ts");
    mkdirSync(dirname(absB), { recursive: true });
    writeFileSync(absB, SRC_B);
    const dbB = new Db(":memory:");
    dbB.migrate();
    node(dbB, "big/tiny", "src/big.ts", [1, 3]);
    // Register the siblings as entities so the skeleton header subtracts their
    // bodies (keeping the pack lean), mirroring a real graph.
    let line = 5;
    for (let i = 0; i < 12; i++) {
      node(dbB, `big/sib${i}`, "src/big.ts", [line, line + 2]);
      line += 4; // 3 body lines + 1 blank between blocks
    }
    const packB = buildContextPack(dbB, rootB, "big/tiny");
    expect(packB).not.toBeNull();
    expect(packB!.estTokens).toBeLessThan(packB!.targetFileEstTokens);
    expect(packB?.worthwhile).toBe(true);
    expect(packB?.notes.some((n) => n.includes("not smaller than the target file"))).toBe(
      false,
    );
    dbB.close();
  });

  // ── OPT-IN CALLER HOP (maxCallers) ──────────────────────────────────────────
  // The packer reaches CALLEES (outgoing) + referenced types, but never CALLERS.
  // A higher-order target (`withRetry(fn)`) whose real behavior is the lambda the
  // CALLER supplies has its load-bearing code invisible. `maxCallers > 0` adds the
  // caller body as a via:"caller" slice; default (absent) adds nothing.

  /** Fixture: `app/doWork` (the CALLER, body holds the real lambda) calls
   *  `lib/withRetry` (the higher-order TARGET). Returns the repo root. */
  function seedHof(db: Db): string {
    db.migrate();
    const root = mkdtempSync(join(tmpdir(), "hayven-ctxpack-hof-"));
    const WITHRETRY_TS = `export function withRetry<T>(fn: () => T): T {
  return fn()
}
`;
    const DOWORK_TS = `import { withRetry } from "./withRetry"

export function doWork(): number {
  return withRetry(() => {
    const LOAD_BEARING = 41 + 1
    return LOAD_BEARING
  })
}
`;
    for (const [rel, content] of [
      ["src/withRetry.ts", WITHRETRY_TS],
      ["src/doWork.ts", DOWORK_TS],
    ] as const) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    // withRetry = lines 1..3; doWork = lines 3..9; doWork CALLS withRetry.
    node(db, "lib/withRetry", "src/withRetry.ts", [1, 3]);
    node(db, "app/doWork", "src/doWork.ts", [3, 9]);
    edge(db, "app/doWork", "lib/withRetry", "static_call", 1);
    return root;
  }

  it("includes the caller body as a via:\"caller\" slice with maxCallers:1", () => {
    const db = new Db(":memory:");
    const root = seedHof(db);
    const pack = buildContextPack(db, root, "lib/withRetry", { maxCallers: 1 });
    expect(pack).not.toBeNull();
    const caller = (pack?.slices ?? []).find((s) => s.id === "app/doWork");
    // The caller is inlined, tagged "caller", with the incoming edge weight…
    expect(caller).toBeDefined();
    expect(caller?.via).toBe("caller");
    expect(caller?.role).toBe("neighbor");
    expect(caller?.weight).toBe(1);
    expect(caller?.file).toBe("src/doWork.ts");
    // …and it carries the load-bearing lambda body the target alone never shows.
    expect(caller?.text).toContain("const LOAD_BEARING = 41 + 1");
    db.close();
  });

  it("adds NO caller slice by default (byte-identical to pre-caller-hop)", () => {
    // Build the SAME target with and without maxCallers; the default pack must be
    // byte-identical (same slices/ids/text/weights), i.e. maxCallers absent ⇒
    // zero caller slices. This is the cost-wedge guarantee.
    const db = new Db(":memory:");
    const root = seedHof(db);
    const dflt = buildContextPack(db, root, "lib/withRetry");
    const withCallers = buildContextPack(db, root, "lib/withRetry", {
      maxCallers: 1,
    });
    expect(dflt).not.toBeNull();
    // No slice in the default pack was reached via "caller".
    expect((dflt?.slices ?? []).some((s) => s.via === "caller")).toBe(false);
    expect((dflt?.slices ?? []).some((s) => s.id === "app/doWork")).toBe(false);
    // The caller-hop pack DID add it (proves the fixture wires a real caller).
    expect((withCallers?.slices ?? []).some((s) => s.via === "caller")).toBe(true);
    // Byte-identical default proof: serializing the default pack omitting the new
    // pass yields exactly the caller-hop pack MINUS its caller slices.
    const stripCallers = (p: typeof withCallers) =>
      JSON.stringify((p?.slices ?? []).filter((s) => s.via !== "caller"));
    expect(JSON.stringify(dflt?.slices)).toBe(stripCallers(withCallers));
    db.close();
  });

  it("respects the maxCallers cap and notes the omission", () => {
    const db = new Db(":memory:");
    db.migrate();
    const root = mkdtempSync(join(tmpdir(), "hayven-ctxpack-callercap-"));
    const TARGET_TS = `export function target(): number {
  return 0
}
`;
    const C1_TS = `export function callerOne(): number {
  return target() + 1
}
`;
    const C2_TS = `export function callerTwo(): number {
  return target() + 2
}
`;
    for (const [rel, content] of [
      ["src/target.ts", TARGET_TS],
      ["src/c1.ts", C1_TS],
      ["src/c2.ts", C2_TS],
    ] as const) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    node(db, "x/target", "src/target.ts", [1, 3]);
    node(db, "x/callerOne", "src/c1.ts", [1, 3]);
    node(db, "x/callerTwo", "src/c2.ts", [1, 3]);
    // callerOne has the heavier incoming edge weight → kept; callerTwo omitted.
    edge(db, "x/callerOne", "x/target", "static_call", 5);
    edge(db, "x/callerTwo", "x/target", "static_call", 1);

    const pack = buildContextPack(db, root, "x/target", { maxCallers: 1 });
    const callers = (pack?.slices ?? []).filter((s) => s.via === "caller");
    expect(callers).toHaveLength(1);
    expect(callers[0]!.id).toBe("x/callerOne"); // highest incoming weight kept
    expect(callers[0]!.weight).toBe(5);
    expect(pack?.notes.some((n) => n.includes("caller(s) omitted"))).toBe(true);
    db.close();
  });

  it("excludes a dangling / module / test caller from the caller hop", () => {
    const db = new Db(":memory:");
    db.migrate();
    const root = mkdtempSync(join(tmpdir(), "hayven-ctxpack-callerskip-"));
    const TARGET_TS = `export function target(): number {
  return 0
}
`;
    const REAL_TS = `export function realCaller(): number {
  return target() + 1
}
`;
    for (const [rel, content] of [
      ["src/target.ts", TARGET_TS],
      ["src/real.ts", REAL_TS],
    ] as const) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    node(db, "y/target", "src/target.ts", [1, 3]);
    node(db, "y/realCaller", "src/real.ts", [1, 3]);
    node(db, "src/mod.ts", "src/mod.ts", [1, 3], "module"); // a module CALLER
    // A test-file caller node (no source file written — also exercises read-fail
    // robustness) and a dangling caller (edge from an id with no node row).
    node(db, "y.test/testCaller", "src/y.test.ts", [1, 3]);
    edge(db, "y/realCaller", "y/target", "static_call", 1); // real → kept
    edge(db, "src/mod.ts", "y/target", "static_call", 9); // module → excluded
    edge(db, "y.test/testCaller", "y/target", "static_call", 9); // test → excluded
    edge(db, "y/danglerCaller", "y/target", "static_call", 9); // dangler → excluded

    const pack = buildContextPack(db, root, "y/target", { maxCallers: 10 });
    const callerIds = (pack?.slices ?? [])
      .filter((s) => s.via === "caller")
      .map((s) => s.id);
    // Only the real source caller survives the guards.
    expect(callerIds).toEqual(["y/realCaller"]);
    // None of the excluded kinds leaked in as any slice.
    expect((pack?.slices ?? []).some((s) => s.id === "src/mod.ts")).toBe(false);
    expect((pack?.slices ?? []).some((s) => s.id === "y.test/testCaller")).toBe(
      false,
    );
    expect((pack?.slices ?? []).some((s) => s.id === "y/danglerCaller")).toBe(
      false,
    );
    db.close();
  });
});
