/**
 * WIN A: the multi-root entry point HONORS the opt-in pack options.
 *
 * THE DEFECT these pin: `buildContextPackForSymbols` accepted the same
 * `ContextPackOptions` as `buildContextPack` but never read `maxCallers` or
 * `importedSymbols`. The §5 caller pass and the §6 imported-symbol pass existed
 * only on the single-target path, so a caller passing `{maxCallers: 10}` or
 * `{importedSymbols: true}` to the multi-root entry point got silently nothing
 * back and not even a note saying why. `buildContextPackForChange` inherited the
 * same hole by delegation.
 *
 * The fix generalized both passes to the ROOT SET and moved them into
 * `pack_neighbors.ts` beside the callee/ref passes, so what is asserted here is
 * as much the ANTI-DRIFT property (the two entry points run one implementation)
 * as the feature itself. Hence the parity tests: single-target and single-element
 * multi-root must agree byte-for-byte with the options on, exactly as they
 * already do with the options off.
 *
 * The GOLDEN below is the literal pre-change output of the no-options multi-root
 * pack, captured from this exact fixture before a line of the fix was written.
 * Adding opt-in sections must not move anything for a caller who does not opt in.
 * (The capture used `call` edges and this fixture uses `static_call`; both
 * satisfy `isCallKind`, and the two were verified to produce identical packs for
 * every option shape here, so the golden is the same bytes either way.)
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildContextPack,
  buildContextPackForChange,
  buildContextPackForSymbols,
} from "../src/db/context_pack.ts";
import { Db } from "../src/db/queries.ts";
import type { EdgeKind, NodeKind } from "../src/graph/types.ts";

// `HANDLERS` is deliberately a module-level const with NO graph node: that is
// exactly the shape §6 exists to recover (the ref pass only inlines indexed
// type-like nodes). `Shape` IS a node, so it arrives via the §4 ref pass.
const CORE = `export const HANDLERS = {
  a: 1,
  b: 2,
};

export class Shape {
  width = 0;
}
`;

// alpha + beta are the roots. helper is their shared callee. driver calls alpha;
// runner calls BOTH, so runner outranks driver on summed incoming weight and the
// cap has something to cut.
const MAIN = `import { HANDLERS, Shape } from "./core.ts";

export function helper(x: number): number {
  return x + 1;
}

export function alpha(x: number): number {
  return helper(x) + HANDLERS.a;
}

export function beta(s: Shape): number {
  return helper(s.width) + 2;
}

export function driver(): number {
  return alpha(1) + 1;
}

export function runner(): number {
  return beta({ width: 2 }) + alpha(3);
}
`;

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
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

function edge(db: Db, src: string, dst: string, kind: EdgeKind, weight = 1) {
  db.upsertEdge({ src, dst, kind, weight, last_seen: 0 });
}

// Extra fixture files. These are added ONLY by the tests that ask for them, so
// the golden pack's two files keep exactly the content and line numbers they had
// when the pre-change output was captured.
const EXTRA = `export const OTHERCFG = {
  z: 9,
};
`;

const SECOND = `import { OTHERCFG } from "./extra.ts";

export function gamma(): number {
  return OTHERCFG.z;
}
`;

const FAR = `export function farRoot(): number {
  return 1;
}

export function farCaller(): number {
  return farRoot();
}
`;

const TEST_CALLER = `import { alpha } from "./main.ts";

export function itCallsAlpha(): number {
  return alpha(1);
}
`;

// A SMALL file whose opt-in context lives entirely in OTHER files: `tiny` names
// the non-node `HANDLERS` from core.ts and its only caller is a large function
// in user.ts. That is the shape where the whole-file fallback throws away
// exactly what the caller opted into.
const TINY = `export function tiny(): number {
  return HANDLERS.a;
}

export function padA(): number {
  return 1;
}

export function padB(): number {
  return 2;
}
`;

const USER = `export function useTiny(): number {
  const a = tiny();
  const b = a + 1;
  const c = b + 2;
  const d = c + 3;
  const e = d + 4;
  const f = e + 5;
  const g = f + 6;
  const h = g + 7;
  return h;
}
`;

/** `extra` lets one test add files/nodes/edges without perturbing the golden
 *  fixture. It receives the repo root so it can write files of its own. */
function seed(extra?: (db: Db, root: string) => void): { db: Db; root: string } {
  const root = mkdtempSync(join(tmpdir(), "hayven-wina-"));
  writeFile(root, "src/core.ts", CORE);
  writeFile(root, "src/main.ts", MAIN);
  const db = new Db(":memory:");
  db.migrate();
  node(db, "src/core.ts", "src/core.ts", [1, 8], "module");
  node(db, "src/core.ts::Shape", "src/core.ts", [6, 8], "class");
  node(db, "src/main.ts", "src/main.ts", [1, 21], "module");
  node(db, "src/main.ts::helper", "src/main.ts", [3, 5]);
  node(db, "src/main.ts::alpha", "src/main.ts", [7, 9]);
  node(db, "src/main.ts::beta", "src/main.ts", [11, 13]);
  node(db, "src/main.ts::driver", "src/main.ts", [15, 17]);
  node(db, "src/main.ts::runner", "src/main.ts", [19, 21]);
  edge(db, "src/main.ts", "src/core.ts", "import");
  edge(db, "src/main.ts::alpha", "src/main.ts::helper", "static_call");
  edge(db, "src/main.ts::beta", "src/main.ts::helper", "static_call");
  edge(db, "src/main.ts::driver", "src/main.ts::alpha", "static_call");
  edge(db, "src/main.ts::runner", "src/main.ts::beta", "static_call");
  edge(db, "src/main.ts::runner", "src/main.ts::alpha", "static_call");
  extra?.(db, root);
  return { db, root };
}

/** A second root in its OWN file naming its OWN non-node importable const, so
 *  the §6 budget can be shown to be shared across roots rather than per root. */
function seedSecondImportable(db: Db, root: string): void {
  writeFile(root, "src/extra.ts", EXTRA);
  writeFile(root, "src/second.ts", SECOND);
  node(db, "src/extra.ts", "src/extra.ts", [1, 3], "module");
  node(db, "src/second.ts", "src/second.ts", [1, 5], "module");
  node(db, "src/second.ts::gamma", "src/second.ts", [3, 5]);
  edge(db, "src/second.ts", "src/extra.ts", "import");
}

/** A root in a different file with a caller of its own, for the multi-file
 *  root-set case. */
function seedFarFile(db: Db, root: string): void {
  writeFile(root, "src/far.ts", FAR);
  node(db, "src/far.ts", "src/far.ts", [1, 7], "module");
  node(db, "src/far.ts::farRoot", "src/far.ts", [1, 3]);
  node(db, "src/far.ts::farCaller", "src/far.ts", [5, 7]);
  edge(db, "src/far.ts::farCaller", "src/far.ts::farRoot", "static_call");
}

/** The small-file / big-cross-file-caller fixture for the LANE 3 fallback. */
function seedTiny(db: Db, root: string): void {
  writeFile(root, "src/tiny.ts", TINY);
  writeFile(root, "src/user.ts", USER);
  node(db, "src/tiny.ts", "src/tiny.ts", [1, 11], "module");
  node(db, "src/tiny.ts::tiny", "src/tiny.ts", [1, 3]);
  node(db, "src/tiny.ts::padA", "src/tiny.ts", [5, 7]);
  node(db, "src/tiny.ts::padB", "src/tiny.ts", [9, 11]);
  node(db, "src/user.ts", "src/user.ts", [1, 11], "module");
  node(db, "src/user.ts::useTiny", "src/user.ts", [1, 11]);
  // The import edge is what §6 walks to find HANDLERS; it is graph data, so the
  // file needs no literal import line (which would only bloat the header).
  edge(db, "src/tiny.ts", "src/core.ts", "import");
  edge(db, "src/user.ts::useTiny", "src/tiny.ts::tiny", "static_call");
}

const ROOTS = ["src/main.ts::alpha", "src/main.ts::beta"];
const TWO_IMPORTABLE_ROOTS = ["src/main.ts::alpha", "src/second.ts::gamma"];

/** Slices whose `via` marks them as coming from a specific pass. */
function viaIds(
  pack: { slices: Array<{ via?: string; id: string | null; file: string; startLine: number }> },
  via: string,
): string[] {
  return pack.slices
    .filter((s) => s.via === via)
    .map((s) => s.id ?? `${s.file}:${s.startLine}`);
}

/** The §6 slices specifically: text-extracted declarations carry `via:"ref"`
 *  like §4 refs but have NO node id, which is what distinguishes them. */
function importedDecls(pack: {
  slices: Array<{ via?: string; id: string | null }>;
}): Array<{ via?: string; id: string | null }> {
  return pack.slices.filter((s) => s.via === "ref" && s.id === null);
}

describe("buildContextPackForSymbols honors maxCallers (§5)", () => {
  it("adds via:\"caller\" slices for symbols that call ANY root", () => {
    const { db, root } = seed();
    const pack = buildContextPackForSymbols(db, root, ROOTS, { maxCallers: 10 });
    expect(pack).not.toBeNull();
    if (!pack) return;
    // runner calls both roots (summed weight 2) so it outranks driver (weight 1).
    expect(viaIds(pack, "caller")).toEqual([
      "src/main.ts::runner",
      "src/main.ts::driver",
    ]);
    const runner = pack.slices.find((s) => s.id === "src/main.ts::runner");
    expect(runner?.weight).toBe(2);
    expect(runner?.text).toContain("export function runner()");
    expect(pack.slices.find((s) => s.id === "src/main.ts::driver")?.weight).toBe(1);
    db.close();
  });

  it("respects the cap and records the omission note", () => {
    const { db, root } = seed();
    const pack = buildContextPackForSymbols(db, root, ROOTS, { maxCallers: 1 });
    expect(pack).not.toBeNull();
    if (!pack) return;
    // Cap 1 keeps the highest-weight caller only.
    expect(viaIds(pack, "caller")).toEqual(["src/main.ts::runner"]);
    expect(pack.notes).toContain(
      "1 more caller(s) omitted (cap 1, or unresolved/module/dup)",
    );
    db.close();
  });

  it("emits nothing when maxCallers is absent or 0", () => {
    const { db, root } = seed();
    for (const opts of [{}, { maxCallers: 0 }]) {
      const pack = buildContextPackForSymbols(db, root, ROOTS, opts);
      expect(viaIds(pack!, "caller")).toEqual([]);
      expect(pack!.notes.join("\n")).not.toContain("caller(s) omitted");
    }
    db.close();
  });

  it("never re-adds a caller that is already a root or an included callee", () => {
    // helper is alpha's CALLEE; this edge also makes it alpha's CALLER, and
    // driver is promoted from caller to ROOT. Neither may appear twice.
    const { db, root } = seed((d) =>
      edge(d, "src/main.ts::helper", "src/main.ts::alpha", "static_call"),
    );
    const pack = buildContextPackForSymbols(
      db,
      root,
      ["src/main.ts::alpha", "src/main.ts::driver"],
      { maxCallers: 10 },
    );
    expect(pack).not.toBeNull();
    if (!pack) return;
    // helper stays a single via:"call" slice; it is not re-emitted as a caller.
    expect(viaIds(pack, "call")).toContain("src/main.ts::helper");
    expect(viaIds(pack, "caller")).not.toContain("src/main.ts::helper");
    // driver is a root, so its incoming-edge role into alpha is not a neighbor.
    expect(viaIds(pack, "caller")).not.toContain("src/main.ts::driver");
    const ids = pack.slices.map((s) => s.id).filter((x) => x !== null);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate node id anywhere
    db.close();
  });
});

describe("buildContextPackForSymbols honors importedSymbols (§6)", () => {
  it("inlines a cross-file non-node declaration named in a root body", () => {
    const { db, root } = seed();
    const pack = buildContextPackForSymbols(db, root, ROOTS, {
      importedSymbols: true,
    });
    expect(pack).not.toBeNull();
    if (!pack) return;
    const imported = pack.slices.filter(
      (s) => s.via === "ref" && s.file === "src/core.ts" && s.id === null,
    );
    expect(imported).toHaveLength(1);
    expect(imported[0]?.text).toContain("export const HANDLERS");
    expect(imported[0]?.startLine).toBe(1);
    expect(pack.notes).toContain("+1 cross-file imported symbol(s) (opt-in)");
    db.close();
  });

  it("emits nothing when importedSymbols is absent or false", () => {
    const { db, root } = seed();
    for (const opts of [{}, { importedSymbols: false }]) {
      const pack = buildContextPackForSymbols(db, root, ROOTS, opts);
      expect(pack!.slices.some((s) => s.text.includes("export const HANDLERS"))).toBe(
        false,
      );
      expect(pack!.notes.join("\n")).not.toContain("imported symbol(s)");
    }
    db.close();
  });

  it("shares ONE budget across roots rather than paying it per root", () => {
    // The vacuous version of this test sets maxNeighbors to 0 and checks that
    // nothing arrives, which a PER-ROOT implementation would also satisfy. The
    // real pin needs two roots that each name a DIFFERENT importable
    // declaration and a budget of 1: shared budget gives 1 slice, per-root
    // budget would give 2.
    const { db, root } = seed(seedSecondImportable);
    const budgeted = buildContextPackForSymbols(db, root, TWO_IMPORTABLE_ROOTS, {
      importedSymbols: true,
      maxNeighbors: 1,
    });
    expect(importedDecls(budgeted!)).toHaveLength(1);
    expect(budgeted!.notes).toContain("+1 cross-file imported symbol(s) (opt-in)");
    // Raising the shared budget to 2 lets the second root's declaration in, so
    // the cap above really was the binding constraint and not an empty fixture.
    const wider = buildContextPackForSymbols(db, root, TWO_IMPORTABLE_ROOTS, {
      importedSymbols: true,
      maxNeighbors: 2,
    });
    expect(importedDecls(wider!)).toHaveLength(2);
    db.close();
  });

  it("adds nothing when the imported-symbol budget is 0", () => {
    const { db, root } = seed();
    const pack = buildContextPackForSymbols(db, root, ROOTS, {
      importedSymbols: true,
      maxNeighbors: 0,
    });
    expect(importedDecls(pack!)).toHaveLength(0);
    db.close();
  });
});

describe("the opt-in passes are NOT gated on the callee/ref knobs", () => {
  // Both entry points deliberately run §5/§6 OUTSIDE the
  // `includeNeighbors && maxNeighbors > 0` gate, because those passes carry
  // their own knobs. Nothing pinned that, so moving either call inside the gate
  // would have been a silent regression that every other test still passed.
  it("neighbors:false still honors maxCallers on both entry points", () => {
    const { db, root } = seed();
    const multi = buildContextPackForSymbols(db, root, ROOTS, {
      neighbors: false,
      maxCallers: 10,
    });
    expect(viaIds(multi!, "caller")).toEqual([
      "src/main.ts::runner",
      "src/main.ts::driver",
    ]);
    // No callee/ref slices got through the gate, so the caller hop is genuinely
    // running on its own rather than riding along with §3/§4.
    expect(viaIds(multi!, "call")).toEqual([]);
    expect(viaIds(multi!, "ref")).toEqual([]);

    const single = buildContextPack(db, root, "src/main.ts::alpha", {
      neighbors: false,
      maxCallers: 10,
    });
    expect(viaIds(single!, "caller")).toEqual([
      "src/main.ts::driver",
      "src/main.ts::runner",
    ]);
    expect(viaIds(single!, "call")).toEqual([]);
    db.close();
  });

  it("neighbors:false still honors importedSymbols on both entry points", () => {
    const { db, root } = seed();
    const multi = buildContextPackForSymbols(db, root, ROOTS, {
      neighbors: false,
      importedSymbols: true,
    });
    expect(importedDecls(multi!)).toHaveLength(1);
    const single = buildContextPack(db, root, "src/main.ts::alpha", {
      neighbors: false,
      importedSymbols: true,
    });
    expect(importedDecls(single!)).toHaveLength(1);
    db.close();
  });
});

describe("root-set guards at size > 1", () => {
  it("finds callers of roots that live in DIFFERENT files", () => {
    // alpha is in src/main.ts, farRoot is in src/far.ts, and each has its own
    // caller in its own file. A pass that only ever looked at one root's file
    // would return half of this.
    const { db, root } = seed(seedFarFile);
    const pack = buildContextPackForSymbols(
      db,
      root,
      ["src/main.ts::alpha", "src/far.ts::farRoot"],
      { maxCallers: 10 },
    );
    expect(pack).not.toBeNull();
    if (!pack) return;
    expect(viaIds(pack, "caller").sort()).toEqual([
      "src/far.ts::farCaller",
      "src/main.ts::driver",
      "src/main.ts::runner",
    ]);
    db.close();
  });

  it("does not re-emit a caller whose body already overlaps a root", () => {
    // outer STRADDLES alpha's lines and calls it, so its text is already inside
    // a target slice; overlapsAnyRoot must drop it.
    const { db, root } = seed((d) => {
      node(d, "src/main.ts::outer", "src/main.ts", [6, 10]);
      edge(d, "src/main.ts::outer", "src/main.ts::alpha", "static_call", 9);
    });
    const pack = buildContextPackForSymbols(db, root, ROOTS, { maxCallers: 10 });
    // Weight 9 would have ranked it first if the overlap guard were not firing.
    expect(viaIds(pack!, "caller")).not.toContain("src/main.ts::outer");
    db.close();
  });

  it("drops a TEST-file caller of production roots, and keeps it once a root is a test", () => {
    const { db, root } = seed((d, r) => {
      writeFile(r, "src/main.test.ts", TEST_CALLER);
      node(d, "src/main.test.ts", "src/main.test.ts", [1, 5], "module");
      node(d, "src/main.test.ts::itCallsAlpha", "src/main.test.ts", [3, 5]);
      edge(d, "src/main.test.ts::itCallsAlpha", "src/main.ts::alpha", "static_call", 9);
    });
    // Production roots: the test caller is a stub, not behavior to hand a model.
    const prod = buildContextPackForSymbols(db, root, ROOTS, { maxCallers: 10 });
    expect(viaIds(prod!, "caller")).not.toContain("src/main.test.ts::itCallsAlpha");
    // Add a test-file ROOT and the filter must stand down for the whole set,
    // exactly as it already does on the callee and ref passes.
    const withTestRoot = buildContextPackForSymbols(
      db,
      root,
      [...ROOTS, "src/main.test.ts::itCallsAlpha"],
      { maxCallers: 10 },
    );
    // Now a root itself, so it is a target slice rather than a caller neighbor;
    // what matters is that the pass no longer refuses test-file callers.
    const testFileSlices = withTestRoot!.slices.filter(
      (s) => s.file === "src/main.test.ts",
    );
    expect(testFileSlices.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("no-options output is unchanged by the fix", () => {
  /**
   * The literal pre-change serialization of the no-options multi-root pack,
   * captured by running this exact fixture against the packer BEFORE the §5/§6
   * generalization landed. Both new passes are skipped at their default knobs,
   * so every byte here must still hold.
   */
  const GOLDEN_NO_OPTS =
    String.raw`{"symbol":"src/main.ts::alpha,src/main.ts::beta","resolved":null,"slices":[{"role":"header","id":null,"kind":"header","file":"src/main.ts","startLine":1,"endLine":1,"text":"import { HANDLERS, Shape } from \"./core.ts\";"},{"role":"target","id":"src/main.ts::alpha","kind":"function","file":"src/main.ts","startLine":7,"endLine":9,"text":"export function alpha(x: number): number {\n  return helper(x) + HANDLERS.a;\n}"},{"role":"target","id":"src/main.ts::beta","kind":"function","file":"src/main.ts","startLine":11,"endLine":13,"text":"export function beta(s: Shape): number {\n  return helper(s.width) + 2;\n}"},{"role":"neighbor","id":"src/main.ts::helper","kind":"function","file":"src/main.ts","startLine":3,"endLine":5,"text":"export function helper(x: number): number {\n  return x + 1;\n}","via":"call","weight":2},{"role":"neighbor","id":"src/core.ts::Shape","kind":"class","file":"src/core.ts","startLine":6,"endLine":8,"text":"export class Shape {\n  width = 0;\n}","via":"ref"}],"lineCount":13,"estTokens":73,"notes":[],"targetFileEstTokens":100,"worthwhile":true}`;

  it("multi-root with NO options is byte-identical to the pre-change pack", () => {
    const { db, root } = seed();
    const pack = buildContextPackForSymbols(db, root, ROOTS);
    expect(JSON.stringify(pack)).toBe(GOLDEN_NO_OPTS);
    db.close();
  });

  it("passing the options at their default values is also unchanged", () => {
    const { db, root } = seed();
    const pack = buildContextPackForSymbols(db, root, ROOTS, {
      maxCallers: 0,
      importedSymbols: false,
    });
    expect(JSON.stringify(pack)).toBe(GOLDEN_NO_OPTS);
    db.close();
  });
});

describe("cross-entry-point parity on the shared passes", () => {
  const BOTH = { maxCallers: 10, importedSymbols: true } as const;

  it("single-element multi-root equals buildContextPack WITH the options on", () => {
    const { db, root } = seed();
    const single = buildContextPack(db, root, "src/main.ts::alpha", BOTH);
    const multi = buildContextPackForSymbols(db, root, ["src/main.ts::alpha"], BOTH);
    expect(single).not.toBeNull();
    expect(multi).not.toBeNull();
    // The whole point of sharing the passes: the slices, the notes and the
    // derived counts all agree, so neither entry point can drift on §5/§6.
    expect(JSON.stringify(multi?.slices)).toBe(JSON.stringify(single?.slices));
    expect(multi?.notes).toEqual(single?.notes ?? []);
    expect(multi?.estTokens).toBe(single?.estTokens);
    expect(multi?.lineCount).toBe(single?.lineCount);
    // And it is not vacuous: both passes actually contributed.
    expect(viaIds(multi!, "caller").length).toBeGreaterThan(0);
    expect(multi!.notes).toContain("+1 cross-file imported symbol(s) (opt-in)");
    db.close();
  });

  it("the caller cap behaves the same on both entry points", () => {
    const { db, root } = seed();
    for (const cap of [1, 2, 5]) {
      const single = buildContextPack(db, root, "src/main.ts::alpha", {
        maxCallers: cap,
      });
      const multi = buildContextPackForSymbols(db, root, ["src/main.ts::alpha"], {
        maxCallers: cap,
      });
      expect(viaIds(multi!, "caller")).toEqual(viaIds(single!, "caller"));
      expect(viaIds(multi!, "caller").length).toBeLessThanOrEqual(cap);
      expect(multi!.notes).toEqual(single!.notes);
    }
    db.close();
  });
});

describe("buildContextPackForChange inherits the fix by delegation", () => {
  // The change entry point never read the options itself; it forwards `opts` to
  // buildContextPackForSymbols, so the same defect surfaced there and the same
  // fix closes it. Line 8 sits inside alpha, so alpha is the only entity root.
  const REGION = [{ startLine: 8, endLine: 8 }];

  it("honors maxCallers and importedSymbols through the entity-root pack", () => {
    const { db, root } = seed();
    const pack = buildContextPackForChange(db, root, "src/main.ts", REGION, {
      maxCallers: 10,
      importedSymbols: true,
    });
    expect(pack).not.toBeNull();
    if (!pack) return;
    expect(viaIds(pack, "caller").sort()).toEqual([
      "src/main.ts::driver",
      "src/main.ts::runner",
    ]);
    expect(pack.slices.some((s) => s.text.includes("export const HANDLERS"))).toBe(true);
    db.close();
  });

  it("is unchanged when the options are not passed", () => {
    const { db, root } = seed();
    const pack = buildContextPackForChange(db, root, "src/main.ts", REGION);
    expect(viaIds(pack!, "caller")).toEqual([]);
    expect(pack!.slices.some((s) => s.text.includes("export const HANDLERS"))).toBe(
      false,
    );
    db.close();
  });

  it("says so when the whole-file fallback discards the opt-in slices", () => {
    // LANE 3 replaces the assembled slices with the whole file whenever the pack
    // is not smaller than that file. The opt-in passes are exactly what pushes a
    // pack over that line, and they are also the slices that can come from OTHER
    // files, so the fallback can hand back a pack containing none of what was
    // asked for. The fallback rule is unchanged (changing it would move
    // no-options output); what is pinned here is that it stops being SILENT.
    const { db, root } = seed(seedTiny);
    const TINY_REGION = [{ startLine: 2, endLine: 2 }];
    const pack = buildContextPackForChange(db, root, "src/tiny.ts", TINY_REGION, {
      maxCallers: 10,
      importedSymbols: true,
    });
    expect(pack).not.toBeNull();
    if (!pack) return;
    expect(pack.fellBackToWholeFile).toBe(true);
    expect(pack.slices).toHaveLength(1);
    // The proof that this is an information loss and not just a token trim: the
    // caller body and the imported declaration are both gone from the result.
    expect(pack.slices[0]?.file).toBe("src/tiny.ts");
    expect(pack.slices.some((s) => s.text.includes("useTiny"))).toBe(false);
    expect(pack.slices.some((s) => s.text.includes("HANDLERS ="))).toBe(false);
    expect(pack.notes).toContain(
      "the opt-in caller/imported-symbol slices were dropped by that fallback (the whole file is returned instead)",
    );

    // The same change WITHOUT the options does not fall back, and never carries
    // the note. This is also the guard that the opt-ins are what tipped it.
    const kept = buildContextPackForChange(db, root, "src/tiny.ts", TINY_REGION);
    expect(kept?.fellBackToWholeFile).toBe(false);
    expect(kept!.notes.join("\n")).not.toContain("dropped by that fallback");
    db.close();
  });
});
