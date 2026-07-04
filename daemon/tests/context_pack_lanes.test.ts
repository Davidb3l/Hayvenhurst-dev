/**
 * Phase 0.0.4.5 packer — the two ADDITIVE lanes that close the two measured
 * reality-check caveats:
 *
 *   LANE 1 — buildModuleFrame: the file's MODULE FRAME (top-level lines outside
 *     ANY entity body — imports, module assignments, `__all__`), closing
 *     MISS_MODULE_LEVEL. Must EXCLUDE function/class bodies and be smaller than
 *     the whole file.
 *
 *   LANE 2 — buildContextPackForSymbols: a MULTI-ROOT pack (each root's body +
 *     1-hop deps, deduped, one shared skeleton per file), closing MISS_STRADDLE.
 *     A single-element rawIds must be EQUIVALENT to buildContextPack.
 *
 *   buildContextPackForChange — the region-classifying convenience that fuses
 *     the two.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildContextPack,
  buildContextPackForChange,
  buildContextPackForSymbols,
  buildModuleFrame,
} from "../src/db/context_pack.ts";
import { Db } from "../src/db/queries.ts";
import type { EdgeKind, NodeKind } from "../src/graph/types.ts";

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

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// ── LANE 1 — buildModuleFrame ────────────────────────────────────────────────
describe("buildModuleFrame", () => {
  // A Python-ish module: imports + a top-level assignment + `__all__` + module
  // constants, with two functions and a class whose BODIES must be excluded.
  const SRC = `import sys

MAC = sys.platform == "darwin"
LIMIT = 42

__all__ = ["run", "Helper"]


def run(x):
    SECRET_RUN_BODY = 1
    return x + SECRET_RUN_BODY


class Helper:
    def method(self):
        SECRET_METHOD_BODY = 2
        return SECRET_METHOD_BODY
`;

  function seed(): { db: Db; root: string } {
    const root = mkdtempSync(join(tmpdir(), "hayven-modframe-"));
    writeFile(root, "pkg/mod.py", SRC);
    const db = new Db(":memory:");
    db.migrate();
    // run = lines 9-11; Helper = 14-18; Helper.method = 15-18.
    node(db, "pkg/mod.py::run", "pkg/mod.py", [9, 11]);
    node(db, "pkg/mod.py::Helper", "pkg/mod.py", [14, 18], "class");
    node(db, "pkg/mod.py::Helper.method", "pkg/mod.py", [15, 18], "method");
    node(db, "pkg/mod.py", "pkg/mod.py", [1, 18], "module");
    return { db, root };
  }

  it("contains the module-level lines and excludes entity bodies", () => {
    const { db, root } = seed();
    const frame = buildModuleFrame(db, root, "pkg/mod.py");
    expect(frame).not.toBeNull();
    if (!frame) return;

    const allRoles = new Set(frame.slices.map((s) => s.role));
    expect(allRoles).toEqual(new Set(["module-frame"]));

    const text = frame.slices.map((s) => s.text).join("\n");
    // Module-level lines ARE present.
    expect(text).toContain("import sys");
    expect(text).toContain('MAC = sys.platform == "darwin"');
    expect(text).toContain("LIMIT = 42");
    expect(text).toContain('__all__ = ["run", "Helper"]');
    // Entity BODIES are NOT.
    expect(text).not.toContain("SECRET_RUN_BODY");
    expect(text).not.toContain("SECRET_METHOD_BODY");

    // Smaller than the whole file.
    expect(frame.estTokens).toBeLessThan(frame.targetFileEstTokens);
    expect(frame.worthwhile).toBe(true);
    expect(frame.lineCount).toBeGreaterThan(0);
    expect(frame.lineCount).toBeLessThan(SRC.split("\n").length);
    db.close();
  });

  it("returns null when the file can't be read", () => {
    const { db, root } = seed();
    expect(buildModuleFrame(db, root, "pkg/does-not-exist.py")).toBeNull();
    db.close();
  });

  it("serves a module-level change — the changed line is inside the frame", () => {
    const { db, root } = seed();
    const frame = buildModuleFrame(db, root, "pkg/mod.py");
    expect(frame).not.toBeNull();
    // The `MAC = …` line (3) is module-scope → covered by a frame slice.
    const covers = (frame?.slices ?? []).some(
      (s) => s.file === "pkg/mod.py" && s.startLine <= 3 && s.endLine >= 3,
    );
    expect(covers).toBe(true);
    db.close();
  });
});

// ── LANE 2 — buildContextPackForSymbols ──────────────────────────────────────
describe("buildContextPackForSymbols", () => {
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

  function seed(): { db: Db; root: string } {
    const root = mkdtempSync(join(tmpdir(), "hayven-multiroot-"));
    writeFile(root, "src/cookie.ts", COOKIE_TS);
    writeFile(root, "src/util.ts", UTIL_TS);
    writeFile(root, "src/format.ts", FORMAT_TS);
    const db = new Db(":memory:");
    db.migrate();
    node(db, "src/cookie.ts::serialize", "src/cookie.ts", [5, 8]);
    node(db, "src/cookie.ts::unused", "src/cookie.ts", [10, 12]);
    node(db, "src/util.ts::parse", "src/util.ts", [1, 3]);
    node(db, "src/format.ts::format", "src/format.ts", [1, 3]);
    node(db, "src/util.ts", "src/util.ts", [1, 3], "module");
    edge(db, "src/cookie.ts::serialize", "src/util.ts::parse", "static_call", 3);
    edge(db, "src/cookie.ts::serialize", "src/format.ts::format", "static_call", 1);
    edge(db, "src/cookie.ts::serialize", "src/util.ts", "import", 1);
    return { db, root };
  }

  it("single-element rawIds is equivalent to buildContextPack", () => {
    const { db, root } = seed();
    const single = buildContextPack(db, root, "src/cookie.ts::serialize");
    const multi = buildContextPackForSymbols(db, root, ["src/cookie.ts::serialize"]);
    expect(single).not.toBeNull();
    expect(multi).not.toBeNull();
    // The slices must be byte-identical (role/id/file/range/text/via/weight).
    expect(JSON.stringify(multi?.slices)).toBe(JSON.stringify(single?.slices));
    expect(multi?.estTokens).toBe(single?.estTokens);
    expect(multi?.lineCount).toBe(single?.lineCount);
    expect(multi?.targetFileEstTokens).toBe(single?.targetFileEstTokens);
    db.close();
  });

  it("covers all roots' bodies, dedupes a shared callee, one skeleton per file", () => {
    const { db, root } = seed();
    // Two roots in the SAME file (serialize + unused). serialize calls parse +
    // format; both come in once. unused has no callees.
    const pack = buildContextPackForSymbols(db, root, [
      "src/cookie.ts::serialize",
      "src/cookie.ts::unused",
    ]);
    expect(pack).not.toBeNull();
    if (!pack) return;

    // BOTH root bodies are present as target slices.
    const targets = pack.slices.filter((s) => s.role === "target");
    expect(targets.map((s) => s.id).sort()).toEqual([
      "src/cookie.ts::serialize",
      "src/cookie.ts::unused",
    ]);
    expect(targets.find((s) => s.id === "src/cookie.ts::serialize")?.text).toContain(
      "export function serialize",
    );
    expect(targets.find((s) => s.id === "src/cookie.ts::unused")?.text).toContain(
      "function unused",
    );

    // ONE shared skeleton for cookie.ts (both roots are in it) — the header runs
    // are all for cookie.ts, none duplicated.
    const headers = pack.slices.filter((s) => s.role === "header");
    expect(headers.every((h) => h.file === "src/cookie.ts")).toBe(true);
    const headerKeys = headers.map((h) => `${h.startLine}:${h.endLine}`);
    expect(new Set(headerKeys).size).toBe(headerKeys.length); // no dup runs

    // Callees parse + format come in as neighbors, once each.
    const neighborIds = pack.slices.filter((s) => s.role === "neighbor").map((s) => s.id);
    expect(neighborIds.sort()).toEqual(["src/format.ts::format", "src/util.ts::parse"]);
    // The module node never appears.
    expect(pack.slices.some((s) => s.kind === "module")).toBe(false);
    db.close();
  });

  it("dedupes a callee that is ALSO a root (no double-include)", () => {
    const { db, root } = seed();
    // Roots = serialize AND parse. parse is serialize's callee — it must appear
    // exactly ONCE, as a target (not also as a neighbor).
    const pack = buildContextPackForSymbols(db, root, [
      "src/cookie.ts::serialize",
      "src/util.ts::parse",
    ]);
    expect(pack).not.toBeNull();
    const parseSlices = (pack?.slices ?? []).filter((s) => s.id === "src/util.ts::parse");
    expect(parseSlices).toHaveLength(1);
    expect(parseSlices[0]!.role).toBe("target");
    db.close();
  });

  it("applies maxNeighbors across the COMBINED dep set", () => {
    const { db, root } = seed();
    const pack = buildContextPackForSymbols(
      db,
      root,
      ["src/cookie.ts::serialize"],
      { maxNeighbors: 1 },
    );
    const callNeighbors = (pack?.slices ?? []).filter((s) => s.via === "call");
    expect(callNeighbors).toHaveLength(1);
    expect(callNeighbors[0]!.id).toBe("src/util.ts::parse"); // highest weight
    expect(pack?.notes.some((n) => n.includes("omitted"))).toBe(true);
    db.close();
  });

  it("returns null only when NO id resolves; skips unresolvable ones otherwise", () => {
    const { db, root } = seed();
    expect(buildContextPackForSymbols(db, root, ["nope-a", "nope-b"])).toBeNull();
    const mixed = buildContextPackForSymbols(db, root, [
      "totally-missing",
      "src/cookie.ts::serialize",
    ]);
    expect(mixed).not.toBeNull();
    expect(mixed?.slices.some((s) => s.id === "src/cookie.ts::serialize")).toBe(true);
    db.close();
  });

  it("groups skeletons per file for mixed-file roots", () => {
    const { db, root } = seed();
    // Roots in two files: serialize (cookie.ts) + format (format.ts).
    const pack = buildContextPackForSymbols(db, root, [
      "src/cookie.ts::serialize",
      "src/format.ts::format",
    ]);
    expect(pack).not.toBeNull();
    const headerFiles = new Set(
      (pack?.slices ?? []).filter((s) => s.role === "header").map((s) => s.file),
    );
    // Each root file contributes its own skeleton.
    expect(headerFiles.has("src/cookie.ts")).toBe(true);
    db.close();
  });
});

// ── buildContextPackForChange (convenience) ──────────────────────────────────
describe("buildContextPackForChange", () => {
  const SRC = `import sys

MAC = sys.platform == "darwin"

def alpha(x):
    return x + 1

def beta(x):
    return x + 2
`;

  function seed(): { db: Db; root: string } {
    const root = mkdtempSync(join(tmpdir(), "hayven-change-"));
    writeFile(root, "m.py", SRC);
    const db = new Db(":memory:");
    db.migrate();
    // alpha = 5-6, beta = 8-9.
    node(db, "m.py::alpha", "m.py", [5, 6]);
    node(db, "m.py::beta", "m.py", [8, 9]);
    node(db, "m.py", "m.py", [1, 9], "module");
    return { db, root };
  }

  it("classifies entity regions → multi-root, module-level → frame, merged", () => {
    const { db, root } = seed();
    // Three regions: inside alpha (line 6), inside beta (line 9), and the
    // module-level MAC assignment (line 3, no enclosing entity).
    const pack = buildContextPackForChange(db, root, "m.py", [
      { startLine: 6, endLine: 6 },
      { startLine: 9, endLine: 9 },
      { startLine: 3, endLine: 3 },
    ]);
    expect(pack).not.toBeNull();
    if (!pack) return;

    // Both entity bodies served as targets.
    const targetIds = pack.slices.filter((s) => s.role === "target").map((s) => s.id);
    expect(targetIds.sort()).toEqual(["m.py::alpha", "m.py::beta"]);

    // The module-level line (3) is covered by a frame OR header slice.
    const coversMac = pack.slices.some(
      (s) => s.file === "m.py" && s.startLine <= 3 && s.endLine >= 3,
    );
    expect(coversMac).toBe(true);

    // Every changed line is in the served pack (sufficiency).
    for (const L of [3, 6, 9]) {
      const covered = pack.slices.some(
        (s) => s.file === "m.py" && s.startLine <= L && s.endLine >= L,
      );
      expect(covered).toBe(true);
    }
    db.close();
  });

  it("dedupes merged slices by (file,start,end)", () => {
    const { db, root } = seed();
    const pack = buildContextPackForChange(db, root, "m.py", [
      { startLine: 6, endLine: 6 },
      { startLine: 3, endLine: 3 },
    ]);
    const keys = (pack?.slices ?? []).map((s) => `${s.file}:${s.startLine}:${s.endLine}`);
    expect(new Set(keys).size).toBe(keys.length);
    db.close();
  });

  it("entity-only regions need no module frame", () => {
    const { db, root } = seed();
    const pack = buildContextPackForChange(db, root, "m.py", [
      { startLine: 6, endLine: 6 },
    ]);
    expect(pack).not.toBeNull();
    expect(pack?.slices.some((s) => s.role === "target" && s.id === "m.py::alpha")).toBe(
      true,
    );
    expect(pack?.slices.some((s) => s.role === "module-frame")).toBe(false);
    db.close();
  });
});

// ── LANE 3 — never-worse-than-the-file fallback ──────────────────────────────
describe("buildContextPackForChange — whole-file fallback (Lane 3)", () => {
  // a.py is small; its `f` calls a HUGE `big` in b.py. The assembled pack
  // (f + the big cross-file callee body) is LARGER than just reading a.py, so the
  // packer must fall through and return a.py whole — never worse than the file.
  function seed(): { db: Db; root: string } {
    const root = mkdtempSync(join(tmpdir(), "hayven-fallback-"));
    const aSrc = `import b

def f(x):
    return b.big(x)
`;
    const bigBody = Array.from({ length: 200 }, (_, i) => `    s${i} = ${i} * 2  # padded line`).join("\n");
    const bSrc = `def big(x):\n${bigBody}\n    return x\n`;
    writeFile(root, "a.py", aSrc);
    writeFile(root, "b.py", bSrc);
    const db = new Db(":memory:");
    db.migrate();
    node(db, "a.py::f", "a.py", [3, 4]);
    node(db, "a.py", "a.py", [1, 4], "module");
    node(db, "b.py::big", "b.py", [1, 203]);
    node(db, "b.py", "b.py", [1, 203], "module");
    edge(db, "a.py::f", "b.py::big", "static_call", 3);
    return { db, root };
  }

  it("falls back to the whole file when the pack would be no smaller, and is never worse", () => {
    const { db, root } = seed();
    const pack = buildContextPackForChange(db, root, "a.py", [{ startLine: 3, endLine: 4 }]);
    expect(pack).not.toBeNull();
    if (!pack) return;
    // The guarantee: the returned pack never exceeds just reading the file.
    expect(pack.estTokens).toBeLessThanOrEqual(pack.targetFileEstTokens);
    expect(pack.fellBackToWholeFile).toBe(true);
    // It returned a.py WHOLE as a single slice (lossless for the change).
    expect(pack.slices).toHaveLength(1);
    expect(pack.slices[0]!.kind).toBe("whole-file");
    expect(pack.slices[0]!.file).toBe("a.py");
    expect(pack.slices[0]!.text).toContain("def f(x):");
    expect(pack.notes.some((n) => n.includes("never worse"))).toBe(true);
    db.close();
  });

  it("does NOT fall back when the pack is genuinely smaller than the file", () => {
    // A big file whose changed entity is a small fraction and has no large deps:
    // the slice is much smaller than the file → worthwhile → no fallback.
    const root = mkdtempSync(join(tmpdir(), "hayven-nofallback-"));
    const filler = Array.from({ length: 180 }, (_, i) => `def other_${i}():\n    return ${i}\n`).join("\n");
    const src = `import sys\n\ndef target(x):\n    return x + 1\n\n${filler}`;
    writeFile(root, "big.py", src);
    const db = new Db(":memory:");
    db.migrate();
    node(db, "big.py::target", "big.py", [3, 4]);
    node(db, "big.py", "big.py", [1, src.split("\n").length], "module");
    const pack = buildContextPackForChange(db, root, "big.py", [{ startLine: 3, endLine: 4 }]);
    expect(pack).not.toBeNull();
    if (!pack) return;
    expect(pack.fellBackToWholeFile).toBeFalsy();
    expect(pack.worthwhile).toBe(true);
    expect(pack.estTokens).toBeLessThan(pack.targetFileEstTokens);
    expect(pack.slices.some((s) => s.kind === "whole-file")).toBe(false);
    db.close();
  });
});
