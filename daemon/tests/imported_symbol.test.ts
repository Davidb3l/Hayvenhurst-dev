/**
 * PACKER reachability helper — cross-file IMPORTED-SYMBOL inclusion
 * (`db/imported_symbol.ts`).
 *
 * The packer's referenced-entity pass only inlines type-like NODES
 * (`kind:"class"`). A target function that NAMES a cross-file `export const
 * HANDLERS = {…}` dispatch table, a `CONFIG` object, or a bare `export type`
 * alias — none of which the extractor emits as a graph node — is invisible to
 * every rung. `collectImportedSymbols` recovers them by:
 *   - deriving the set of files imported by the target file from the GRAPH
 *     (import-kind edges out of the file's module node),
 *   - tokenizing the target body for candidate identifiers,
 *   - locating a MODULE-LEVEL declaration of the name in an imported file and
 *     extracting it (brace-balanced, bounded).
 *
 * These tests seed a tiny on-disk repo + the matching graph (nodes + an import
 * edge a.ts → b.ts via the module node) and assert: HANDLERS comes back from
 * b.ts; an INDEXED node name is skipped (callee/ref passes own it); a
 * non-imported name is skipped; caps are respected; nothing matched → [].
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { collectImportedSymbols } from "../src/db/imported_symbol.ts";
import { Db } from "../src/db/queries.ts";
import type { NodeRow } from "../src/db/queries.ts";
import type { EdgeKind, NodeKind } from "../src/graph/types.ts";

// b.ts exports a dispatch table (NOT a graph node), a CONFIG object, and a type
// alias — exactly the non-node, module-level imported symbols the ref pass
// misses. `helper` is a real function (and IS seeded as a node) to prove the
// indexed-node skip.
const B_TS = `export const HANDLERS = {
  a() {
    return 1;
  },
  b() {
    return 2;
  },
};

export const CONFIG = { retries: 3, timeout: 1000 };

export type Mode = "fast" | "slow";

export function helper(): number {
  return 42;
}
`;

// a.ts imports HANDLERS/CONFIG/Mode/helper from ./b. `run` references HANDLERS,
// CONFIG, Mode, and helper — and ALSO a name (`NOPE`) that is NOT declared in
// any imported file (should not be recovered).
const A_TS = `import { HANDLERS, CONFIG, helper } from "./b";
import type { Mode } from "./b";

export function run(mode: Mode): number {
  const cfg = CONFIG;
  const fn = HANDLERS.a;
  const NOPE = fn() + helper();
  return cfg.retries + NOPE;
}
`;

const A_BODY = [
  'export function run(mode: Mode): number {',
  "  const cfg = CONFIG;",
  "  const fn = HANDLERS.a;",
  "  const NOPE = fn() + helper();",
  "  return cfg.retries + NOPE;",
  "}",
].join("\n");

function writeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-impsym-"));
  for (const [rel, content] of [
    ["src/a.ts", A_TS],
    ["src/b.ts", B_TS],
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
): void {
  db.upsertNode({
    id,
    name: id.split("::").pop()?.split("/").pop() ?? id,
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

function edge(db: Db, src: string, dst: string, kind: EdgeKind, weight = 1): void {
  db.upsertEdge({ src, dst, kind, weight, last_seen: 0 });
}

/**
 * Seed the graph mirroring the repo:
 *   - a.ts::run (the target function) and a.ts module node
 *   - b.ts::helper (a REAL indexed node — must be skipped by the helper)
 *   - b.ts module node
 *   - an IMPORT edge a.ts(module) → b.ts(module), so importedFilesOf derives b.ts
 * Deliberately NO nodes for HANDLERS / CONFIG / Mode — that's the whole point:
 * they aren't indexed, so the ref pass misses them.
 */
function seed(db: Db): { root: string; target: NodeRow } {
  db.migrate();
  const root = writeRepo();
  node(db, "src/a.ts::run", "src/a.ts", [4, 9]);
  node(db, "src/b.ts::helper", "src/b.ts", [15, 17]);
  node(db, "src/a.ts", "src/a.ts", [1, 9], "module");
  node(db, "src/b.ts", "src/b.ts", [1, 17], "module");
  // Import edge is module → module (the schema's file-level import shape).
  edge(db, "src/a.ts", "src/b.ts", "import", 1);
  const target = db.getNode("src/a.ts::run");
  if (!target) throw new Error("seed: target not found");
  return { root, target };
}

describe("collectImportedSymbols", () => {
  it("recovers a non-node imported dispatch table from the imported file", () => {
    const db = new Db(":memory:");
    const { root, target } = seed(db);

    const slices = collectImportedSymbols(db, root, target, A_BODY, new Set());

    const handlers = slices.find((s) => s.text.includes("export const HANDLERS"));
    expect(handlers).toBeDefined();
    if (!handlers) return;
    expect(handlers.role).toBe("neighbor");
    expect(handlers.via).toBe("ref");
    expect(handlers.kind).toBe("other");
    expect(handlers.id).toBeNull();
    expect(handlers.file).toBe("src/b.ts");
    // HANDLERS declaration is lines 1..8 of b.ts (brace-balanced object).
    expect(handlers.startLine).toBe(1);
    expect(handlers.endLine).toBe(8);
    expect(handlers.text).toContain("a() {");
    expect(handlers.text).toContain("b() {");
    expect(handlers.text.trimEnd().endsWith("};")).toBe(true);
  });

  it("also recovers a const object and a type alias", () => {
    const db = new Db(":memory:");
    const { root, target } = seed(db);

    const slices = collectImportedSymbols(db, root, target, A_BODY, new Set());

    const cfg = slices.find((s) => s.text.includes("export const CONFIG"));
    expect(cfg).toBeDefined();
    expect(cfg?.text).toContain("retries: 3");

    const mode = slices.find((s) => s.text.includes("export type Mode"));
    expect(mode).toBeDefined();
    expect(mode?.startLine).toBe(mode?.endLine); // single-line `;`-terminated
    expect(mode?.text.trimEnd().endsWith(";")).toBe(true);
  });

  it("SKIPS a name that is an indexed node (callee/ref passes own it)", () => {
    const db = new Db(":memory:");
    const { root, target } = seed(db);

    const slices = collectImportedSymbols(db, root, target, A_BODY, new Set());

    // `helper` IS a seeded node — must not be re-included here.
    const helper = slices.find((s) => s.text.includes("export function helper"));
    expect(helper).toBeUndefined();
  });

  it("SKIPS a name not declared in any imported file (e.g. a local)", () => {
    const db = new Db(":memory:");
    const { root, target } = seed(db);

    const slices = collectImportedSymbols(db, root, target, A_BODY, new Set());

    // `NOPE` is a local in `run`, not declared at module scope in b.ts.
    const nope = slices.find((s) => s.text.includes("NOPE ="));
    expect(nope).toBeUndefined();
  });

  it("respects maxSymbols cap", () => {
    const db = new Db(":memory:");
    const { root, target } = seed(db);

    const slices = collectImportedSymbols(db, root, target, A_BODY, new Set(), {
      maxSymbols: 1,
    });
    expect(slices.length).toBe(1);
  });

  it("respects maxLines (caps a large declaration's span)", () => {
    const db = new Db(":memory:");
    const { root, target } = seed(db);

    // HANDLERS spans 8 lines; cap to 3 → endLine = startLine + 2.
    const slices = collectImportedSymbols(db, root, target, A_BODY, new Set(), {
      maxLines: 3,
    });
    const handlers = slices.find((s) => s.startLine === 1 && s.file === "src/b.ts");
    expect(handlers).toBeDefined();
    if (!handlers) return;
    expect(handlers.endLine).toBe(3);
    expect(handlers.text.split("\n").length).toBe(3);
  });

  it("honours alreadyAddedIds (synthetic <file>::<name> id)", () => {
    const db = new Db(":memory:");
    const { root, target } = seed(db);

    const already = new Set<string>(["src/b.ts::HANDLERS"]);
    const slices = collectImportedSymbols(db, root, target, A_BODY, already);

    const handlers = slices.find((s) => s.text.includes("export const HANDLERS"));
    expect(handlers).toBeUndefined();
    // CONFIG is still recovered (proves the skip is per-id, not global).
    expect(slices.find((s) => s.text.includes("export const CONFIG"))).toBeDefined();
  });

  it("returns [] when the file imports nothing (no import edges)", () => {
    const db = new Db(":memory:");
    db.migrate();
    const root = writeRepo();
    node(db, "src/a.ts::run", "src/a.ts", [4, 9]);
    node(db, "src/a.ts", "src/a.ts", [1, 9], "module");
    // No b.ts module node, no import edge.
    const target = db.getNode("src/a.ts::run");
    if (!target) throw new Error("target not found");

    const slices = collectImportedSymbols(db, root, target, A_BODY, new Set());
    expect(slices).toEqual([]);
  });

  it("returns [] when the target body names nothing recoverable", () => {
    const db = new Db(":memory:");
    const { root, target } = seed(db);

    const slices = collectImportedSymbols(
      db,
      root,
      target,
      "function noop() { return 1 + 2; }",
      new Set(),
    );
    expect(slices).toEqual([]);
  });

  it("never throws when an imported file is unreadable (skips it)", () => {
    const db = new Db(":memory:");
    db.migrate();
    const root = writeRepo();
    node(db, "src/a.ts::run", "src/a.ts", [4, 9]);
    node(db, "src/a.ts", "src/a.ts", [1, 9], "module");
    // Point the import at a module whose file does NOT exist on disk.
    node(db, "src/ghost.ts", "src/ghost.ts", [1, 1], "module");
    edge(db, "src/a.ts", "src/ghost.ts", "import", 1);
    const target = db.getNode("src/a.ts::run");
    if (!target) throw new Error("target not found");

    expect(() =>
      collectImportedSymbols(db, root, target, A_BODY, new Set()),
    ).not.toThrow();
    expect(collectImportedSymbols(db, root, target, A_BODY, new Set())).toEqual([]);
  });

  it("skips imported TEST files as candidate sources", () => {
    const db = new Db(":memory:");
    db.migrate();
    const root = mkdtempSync(join(tmpdir(), "hayven-impsym-test-"));
    const aAbs = join(root, "src/a.ts");
    const tAbs = join(root, "src/fixtures.test.ts");
    mkdirSync(dirname(aAbs), { recursive: true });
    writeFileSync(aAbs, A_TS);
    writeFileSync(tAbs, "export const HANDLERS = { a() {} };\n");
    node(db, "src/a.ts::run", "src/a.ts", [4, 9]);
    node(db, "src/a.ts", "src/a.ts", [1, 9], "module");
    node(db, "src/fixtures.test.ts", "src/fixtures.test.ts", [1, 1], "module");
    edge(db, "src/a.ts", "src/fixtures.test.ts", "import", 1);
    const target = db.getNode("src/a.ts::run");
    if (!target) throw new Error("target not found");

    const slices = collectImportedSymbols(db, root, target, A_BODY, new Set());
    expect(slices).toEqual([]);
  });
});
