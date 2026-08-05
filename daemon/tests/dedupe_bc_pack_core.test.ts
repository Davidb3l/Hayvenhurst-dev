/**
 * Task B (shared neighbor-pass core) + Task C (behavior change in the packer).
 *
 * TASK B pins the things the extraction could plausibly have broken:
 *   - the two entry points' omission NOTES differ by design
 *     ("unresolved/module" vs "unresolved/module/dup") and must stay different,
 *   - a single-element `buildContextPackForSymbols` must produce the same pack
 *     as `buildContextPack` for that id (the root-set generalization degenerates
 *     correctly at length 1). The parity check compares FULL slice tuples,
 *     including `text`, `weight` and `truncatedFromEndLine`, plus `notes` and
 *     the token accounting, because those are exactly the fields the ref
 *     truncation branch can corrupt. The fixture is built so both the same-file
 *     (4a) and cross-file (4b) ref scans AND the truncation branch actually run;
 *     a fixture without a `class` node and an `import` edge would exercise none
 *     of them and the parity claim would be vacuous.
 *
 * TASK C pins the LANGUAGE-CLASSIFICATION BEHAVIOR CHANGE. The packer drops a
 * callee whose file is a test, on the grounds that source never legitimately
 * depends on a test, so such an edge is an ambiguous-name mis-resolution. That
 * filter used to recognise JS/TS test files ONLY, so a Python/Go/Rust test
 * helper with a colliding name was inlined into the pack as if it were the real
 * implementation. It is now correctly dropped. Each language gets its own case,
 * and each fixture gives the TEST callee the HIGHER call weight so an
 * unfiltered packer would rank the wrong body FIRST.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildContextPack,
  buildContextPackForSymbols,
  type ContextPack,
} from "../src/db/context_pack.ts";
import { Db } from "../src/db/queries.ts";
import type { EdgeKind, NodeKind } from "../src/graph/types.ts";

/** Every fixture file. Per language: a real implementation, a real same-language
 *  helper, and a TEST file exporting a same-named helper (the mis-resolution
 *  bait). Python additionally carries a same-file class (4a) and an imported
 *  class (4b) so the ref pass and its truncation branch are covered. */
const FILES: Record<string, string> = {
  // --- Python -------------------------------------------------------------
  "src/parser.py": `import util
from models import Cfg

class Local:
    x = 1

def parse(s):
    c = Cfg()
    l = Local()
    return normalize(s, c)
`,
  "src/models.py": `class Cfg:
    a = 1
    b = 2
    c = 3
    d = 4
`,
  "src/util.py": `def normalize(s, c):
    return s.strip()
`,
  "src/main.py": `def main():
    return parse("x")
`,
  "pkg/parser_test.py": `def normalize(s, c):
    return "PYTHON-TEST-HELPER"

def test_parse():
    return parse("x")
`,
  // --- Go -----------------------------------------------------------------
  "src/walk.go": `package src

func Walk(p string) string {
	return Clean(p)
}
`,
  "src/clean.go": `package src

func Clean(p string) string {
	return p
}
`,
  "internal/walk_test.go": `package internal

func Clean(p string) string {
	return "GO-TEST-HELPER"
}
`,
  // --- Rust ---------------------------------------------------------------
  "src/lib.rs": `pub fn run(x: u32) -> u32 {
    helper(x)
}
`,
  "src/helper.rs": `pub fn helper(x: u32) -> u32 {
    x + 1
}
`,
  "tests/integration.rs": `pub fn helper(x: u32) -> u32 {
    0 // RUST-TEST-HELPER
}
`,
};

/** Temp trees to clean up; `seed` is called many times per run. */
const TEMP_ROOTS: string[] = [];

afterAll(() => {
  for (const r of TEMP_ROOTS) rmSync(r, { recursive: true, force: true });
});

function writeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-dedupe-bc-"));
  TEMP_ROOTS.push(root);
  for (const [rel, content] of Object.entries(FILES)) {
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

function edge(db: Db, src: string, dst: string, kind: EdgeKind, weight = 1) {
  db.upsertEdge({ src, dst, kind, weight, last_seen: 0 });
}

/** Seed one graph covering all three languages. In every language the TEST
 *  helper carries the HEAVIER weight, so it would sort first if not filtered. */
function seed(db: Db): string {
  db.migrate();
  const root = writeRepo();

  // Python: target `parse`, one real callee, one test callee (heavier), a
  // same-file class ref (`Local`), a cross-file class ref via an import edge
  // (`Cfg`), and two callers - one real source, one in a test file.
  node(db, "src/parser.py", "src/parser.py", [1, 10], "module");
  node(db, "src/models.py", "src/models.py", [1, 5], "module");
  node(db, "src/parser.py::Local", "src/parser.py", [4, 5], "class");
  node(db, "src/models.py::Cfg", "src/models.py", [1, 5], "class");
  node(db, "src/parser.py::parse", "src/parser.py", [7, 10]);
  node(db, "src/util.py::normalize", "src/util.py", [1, 2]);
  node(db, "src/main.py::main", "src/main.py", [1, 2]);
  node(db, "pkg/parser_test.py::normalize", "pkg/parser_test.py", [1, 2]);
  node(db, "pkg/parser_test.py::test_parse", "pkg/parser_test.py", [4, 5]);
  edge(db, "src/parser.py", "src/models.py", "import", 1);
  edge(db, "src/parser.py::parse", "src/util.py::normalize", "static_call", 1);
  edge(db, "src/parser.py::parse", "pkg/parser_test.py::normalize", "static_call", 9);
  edge(db, "src/main.py::main", "src/parser.py::parse", "static_call", 1);
  edge(db, "pkg/parser_test.py::test_parse", "src/parser.py::parse", "static_call", 9);

  node(db, "src/walk.go::Walk", "src/walk.go", [3, 5]);
  node(db, "src/clean.go::Clean", "src/clean.go", [3, 5]);
  node(db, "internal/walk_test.go::Clean", "internal/walk_test.go", [3, 5]);
  edge(db, "src/walk.go::Walk", "src/clean.go::Clean", "static_call", 1);
  edge(db, "src/walk.go::Walk", "internal/walk_test.go::Clean", "static_call", 9);

  node(db, "src/lib.rs::run", "src/lib.rs", [1, 3]);
  node(db, "src/helper.rs::helper", "src/helper.rs", [1, 3]);
  node(db, "tests/integration.rs::helper", "tests/integration.rs", [1, 3]);
  edge(db, "src/lib.rs::run", "src/helper.rs::helper", "static_call", 1);
  edge(db, "src/lib.rs::run", "tests/integration.rs::helper", "static_call", 9);

  return root;
}

/** Files contributed by the pack's neighbor slices, in emission order. */
function neighborFiles(pack: ContextPack): Array<string | null> {
  return pack.slices.filter((s) => s.role === "neighbor").map((s) => s.file);
}

describe("packer drops mis-resolved test callees in every indexed language", () => {
  const CASES = [
    {
      lang: "Python",
      target: "src/parser.py::parse",
      keep: "src/util.py",
      drop: "pkg/parser_test.py",
    },
    {
      lang: "Go",
      target: "src/walk.go::Walk",
      keep: "src/clean.go",
      drop: "internal/walk_test.go",
    },
    {
      lang: "Rust",
      target: "src/lib.rs::run",
      keep: "src/helper.rs",
      drop: "tests/integration.rs",
    },
  ] as const;

  for (const c of CASES) {
    it(`${c.lang}: keeps ${c.keep}, drops ${c.drop}`, () => {
      const db = new Db(":memory:");
      const root = seed(db);
      const pack = buildContextPack(db, root, c.target);
      expect(pack).not.toBeNull();
      if (!pack) return;
      const files = neighborFiles(pack);
      expect(files).toContain(c.keep);
      expect(files).not.toContain(c.drop);
    });

    it(`${c.lang}: the multi-root entry point drops it too`, () => {
      const db = new Db(":memory:");
      const root = seed(db);
      const pack = buildContextPackForSymbols(db, root, [c.target]);
      expect(pack).not.toBeNull();
      if (!pack) return;
      const files = neighborFiles(pack);
      expect(files).toContain(c.keep);
      expect(files).not.toContain(c.drop);
    });
  }

  it("a TEST target DOES get its test-file callees (the filter is one-way)", () => {
    // The guard is "real source must not depend on a test", not "tests are
    // invisible". With a test-file target the guard must not fire at all, so
    // the test-file callee has to actually appear. `normalize` lives at lines
    // 1-2 of pkg/parser_test.py and the target `test_parse` at 4-5, so the
    // already-shown overlap guard cannot mask the result.
    const db = new Db(":memory:");
    const root = seed(db);
    edge(
      db,
      "pkg/parser_test.py::test_parse",
      "pkg/parser_test.py::normalize",
      "static_call",
      5,
    );
    const pack = buildContextPack(db, root, "pkg/parser_test.py::test_parse");
    expect(pack).not.toBeNull();
    if (!pack) return;
    expect(neighborFiles(pack)).toContain("pkg/parser_test.py");
    expect(neighborFiles(pack)).toContain("src/parser.py");
  });
});

describe("the widened predicate also reaches the opt-in CALLERS pass", () => {
  // Documented behavior change, pinned deliberately: `src/parser.py::parse` has
  // two callers, a real-source one and one in a Python test file. Before the
  // shared predicate the Python test caller was inlined; now it is dropped, and
  // it is the HEAVIER edge, so this fails loudly if the filter regresses.
  it("drops a Python test-file caller, keeps the real-source caller", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const pack = buildContextPack(db, root, "src/parser.py::parse", {
      maxCallers: 5,
    });
    expect(pack).not.toBeNull();
    if (!pack) return;
    const callers = pack.slices.filter((s) => s.via === "caller").map((s) => s.file);
    expect(callers).toEqual(["src/main.py"]);
  });
});

describe("shared neighbor core preserves each entry point's distinct notes", () => {
  it("single-target omission note says unresolved/module", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const pack = buildContextPack(db, root, "src/parser.py::parse", {
      maxNeighbors: 1,
    });
    expect(pack).not.toBeNull();
    if (!pack) return;
    const note = pack.notes.find((n) => n.includes("more callee(s) omitted"));
    expect(note).toBe("1 more callee(s) omitted (cap 1, or unresolved/module)");
  });

  it("multi-root omission note says unresolved/module/dup", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const pack = buildContextPackForSymbols(db, root, ["src/parser.py::parse"], {
      maxNeighbors: 1,
    });
    expect(pack).not.toBeNull();
    if (!pack) return;
    const note = pack.notes.find((n) => n.includes("more callee(s) omitted"));
    expect(note).toBe("1 more callee(s) omitted (cap 1, or unresolved/module/dup)");
  });
});

describe("the Python fixture actually exercises both ref scans", () => {
  // Guards the parity suite below against going vacuous: if a future edit stops
  // the ref pass from firing, THIS fails rather than parity silently comparing
  // two empty ref sets.
  it("emits a same-file (4a) ref and a cross-file (4b) ref", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const pack = buildContextPack(db, root, "src/parser.py::parse");
    expect(pack).not.toBeNull();
    if (!pack) return;
    const refs = pack.slices.filter((s) => s.via === "ref").map((s) => s.id);
    expect(refs).toContain("src/parser.py::Local"); // 4a, same file
    expect(refs).toContain("src/models.py::Cfg"); // 4b, via the import edge
  });

  it("truncates an over-long ref slice line-exactly and notes it", () => {
    const db = new Db(":memory:");
    const root = seed(db);
    const pack = buildContextPack(db, root, "src/parser.py::parse", {
      maxRefSliceLines: 2,
    });
    expect(pack).not.toBeNull();
    if (!pack) return;
    const cfg = pack.slices.find((s) => s.id === "src/models.py::Cfg");
    expect(cfg).toBeDefined();
    expect(cfg?.startLine).toBe(1);
    expect(cfg?.endLine).toBe(2);
    expect(cfg?.truncatedFromEndLine).toBe(5);
    expect(cfg?.text).toBe("class Cfg:\n    a = 1");
    expect(pack.notes).toContain(
      "ref `src/models.py::Cfg` truncated to first 2 of 5 lines",
    );
  });
});

describe("single-root buildContextPackForSymbols matches buildContextPack", () => {
  /** Full slice tuples, not just shape: `text` and `truncatedFromEndLine` are
   *  what the truncation branch can corrupt. */
  const full = (p: ContextPack) =>
    p.slices.map((s) => [
      s.role,
      s.id,
      s.kind,
      s.file,
      s.startLine,
      s.endLine,
      s.via ?? null,
      s.weight ?? null,
      s.truncatedFromEndLine ?? null,
      s.text,
    ]);

  const TARGETS = ["src/parser.py::parse", "src/walk.go::Walk", "src/lib.rs::run"];
  const OPTIONS = [
    {},
    { maxNeighbors: 1 },
    { maxRefSliceLines: 2 },
    { neighbors: false },
    { maxHeaderLines: 2 },
  ] as const;

  for (const target of TARGETS) {
    for (const [i, opts] of OPTIONS.entries()) {
      it(`${target} @ opts#${i}: identical slices and notes`, () => {
        const dbA = new Db(":memory:");
        const rootA = seed(dbA);
        const dbB = new Db(":memory:");
        const rootB = seed(dbB);
        const single = buildContextPack(dbA, rootA, target, opts);
        const multi = buildContextPackForSymbols(dbB, rootB, [target], opts);
        expect(single).not.toBeNull();
        expect(multi).not.toBeNull();
        if (!single || !multi) return;
        expect(full(multi)).toEqual(full(single));
        // Notes differ ONLY in the documented callee-omission suffix; normalize
        // that one token and everything else must match verbatim.
        const norm = (ns: string[]) =>
          ns.map((n) => n.replace("unresolved/module/dup", "unresolved/module"));
        expect(norm(multi.notes)).toEqual(norm(single.notes));
        expect(multi.lineCount).toBe(single.lineCount);
        expect(multi.estTokens).toBe(single.estTokens);
        expect(multi.targetFileEstTokens).toBe(single.targetFileEstTokens);
        expect(multi.worthwhile).toBe(single.worthwhile);
      });
    }
  }
});
