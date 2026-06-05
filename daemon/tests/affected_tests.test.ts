/**
 * TRACE-AUGMENTED test-impact selection (`db/affected_tests.ts`).
 *
 * The headline contract: the run list fuses the STATIC reverse-impact walk with
 * the RUNTIME trace coverage map. A test that reaches the changed symbol only
 * through a runtime-observed call (the re-export / `click.echo` case static
 * MISSES) MUST surface with `evidence:"trace"` — proving we merged
 * `db.resolvedTraceEdges()` rather than walking `db.incoming` alone.
 *
 * Fixtures are synthetic in-memory graphs: nodes via `db.upsertNode`, static
 * edges via `db.upsertEdge`, trace edges via `db.insertObservations` (the runtime
 * src/dst are the node `name`s, set equal to `qualified_name`, so the
 * conservative resolver maps them unambiguously — same pattern as
 * `neighbors_trace.test.ts`).
 */
import { describe, expect, it } from "bun:test";

import { Db } from "../src/db/queries.ts";
import type { EdgeKind } from "../src/graph/types.ts";
import { affectedTests, affectedTestsForFiles } from "../src/db/affected_tests.ts";

/**
 * Index a node with a DISTINCT bare `name` == `qualified_name` so a runtime
 * observation whose src/dst is that name resolves unambiguously to this id.
 */
function seedNode(
  db: Db,
  id: string,
  name: string,
  file: string | null,
  language = "typescript",
): void {
  db.upsertNode({
    id,
    name,
    qualified_name: name,
    kind: "function",
    language,
    // A null `file` exercises the file-less node path (NodeRow.file is nullable
    // even though GraphNode types it `string`); cast so the fixture can seed it.
    file: file as string,
    range: [1, 10],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

/** A resolved static call/import edge `src → dst`. */
function staticEdge(db: Db, src: string, dst: string, weight = 1, kind: EdgeKind = "static_call"): void {
  db.upsertEdge({ src, dst, kind, weight, last_seen: 0 });
}

/** A runtime trace observation `srcName → dstName` (bare names; resolver maps). */
function traceObs(db: Db, srcName: string, dstName: string, weight: number): void {
  db.insertObservations([
    { src: srcName, dst: dstName, ts: 1, observed: weight, weight, source: "py" },
  ]);
}

/** A PRECISE per-test coverage row `testName → entityName` (bare names; resolver
 *  maps). Its mere presence flips `affectedTests` onto the precise path. */
function coverage(db: Db, testName: string, entityName: string, weight: number): void {
  db.insertTestCoverage([
    { test: testName, entity: entityName, weight, source: "py" },
  ]);
}

function freshDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  return db;
}

describe("affectedTests — static-only", () => {
  it("reaches a test via static_call edges with evidence:static and correct depth", () => {
    const db = freshDb();
    // sym ← helper ← test_uses_helper  (test is 2 hops up the reverse walk)
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "src/helper", "helperFn", "src/helper.ts");
    seedNode(db, "tests/test_helper", "test_uses_helper", "tests/test_helper.py", "python");

    staticEdge(db, "src/helper", "src/sym", 3); // helper calls sym
    staticEdge(db, "tests/test_helper", "src/helper", 5); // test calls helper

    const res = affectedTests(db, "src/sym");

    expect(res.roots).toEqual(["src/sym"]);
    expect(res.traceEdgeCount).toBe(0);
    expect(res.note).toContain("UNDER-report"); // cold-trace note present
    expect(res.tests).toHaveLength(1);
    const t = res.tests[0]!;
    expect(t.id).toBe("tests/test_helper");
    expect(t.evidence).toBe("static");
    expect(t.depth).toBe(2); // sym → helper(1) → test(2)
  });
});

describe("affectedTests — trace-only (the headline re-export miss)", () => {
  it("surfaces a test with NO static path but a runtime observation as evidence:trace", () => {
    const db = freshDb();
    // The `click.echo` shape: the real symbol `utils/echo`, and a test that
    // calls it only through a runtime-observed edge. NO static edge connects them.
    seedNode(db, "click/utils/echo", "echo", "click/utils/echo.py", "python");
    seedNode(db, "tests/test_echo", "test_echo", "tests/test_echo.py", "python");

    // Runtime: the test fn was observed calling echo. resolves test_echo→test
    // node, echo→symbol node.
    traceObs(db, "test_echo", "echo", 7);

    // SANITY: a static-only reverse walk finds NOTHING (no incoming edges).
    expect(db.incoming("click/utils/echo")).toHaveLength(0);

    // Explicitly assert the fixture's trace edge RESOLVES both endpoints — else
    // the test would silently pass as static and we'd ship a broken feature.
    const resolved = db.resolvedTraceEdges();
    const echoEdge = resolved.find(
      (e) => e.resolvedDst === "click/utils/echo" && e.resolvedSrc === "tests/test_echo",
    );
    expect(echoEdge).toBeDefined();

    const res = affectedTests(db, "click/utils/echo");

    expect(res.traceEdgeCount).toBe(1);
    expect(res.note).toBeUndefined(); // traces present → no cold note
    expect(res.tests).toHaveLength(1);
    const t = res.tests[0]!;
    expect(t.id).toBe("tests/test_echo");
    expect(t.evidence).toBe("trace"); // the signal static MISSES
    expect(t.depth).toBe(1);
    expect(t.weight).toBe(7);
  });
});

describe("affectedTests — mixed (trace wins)", () => {
  it("tags a node reachable BOTH statically and via trace as evidence:trace", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_both", "test_both", "tests/test_both.py", "python");

    // BOTH a static call edge AND a runtime observation test_both → sym.
    staticEdge(db, "tests/test_both", "src/sym", 2);
    traceObs(db, "test_both", "symFn", 9);

    const res = affectedTests(db, "src/sym");
    expect(res.tests).toHaveLength(1);
    const t = res.tests[0]!;
    expect(t.evidence).toBe("trace"); // trace OR-promotes over static
    expect(t.weight).toBe(9); // trace weight wins for ranking
    expect(t.depth).toBe(1);
  });
});

describe("affectedTests — ranking", () => {
  it("orders trace before static, then depth asc, then weight desc", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // A static test at depth 1.
    seedNode(db, "tests/test_static", "test_static", "tests/test_static.py", "python");
    staticEdge(db, "tests/test_static", "src/sym", 5);
    // A trace test at depth 1 — should rank BEFORE the static one.
    seedNode(db, "tests/test_trace", "test_trace", "tests/test_trace.py", "python");
    traceObs(db, "test_trace", "symFn", 1);

    const res = affectedTests(db, "src/sym");
    expect(res.tests.map((t) => t.id)).toEqual(["tests/test_trace", "tests/test_static"]);
    expect(res.tests[0]!.evidence).toBe("trace");
    expect(res.tests[1]!.evidence).toBe("static");
  });

  it("breaks ties on depth then weight among same-evidence tests", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "src/mid", "midFn", "src/mid.ts");
    // test_near: static depth 1, weight 1.
    seedNode(db, "tests/test_near", "test_near", "tests/test_near.py", "python");
    staticEdge(db, "tests/test_near", "src/sym", 1);
    // test_heavy: static depth 1, weight 8 (same depth, heavier → ranks first).
    seedNode(db, "tests/test_heavy", "test_heavy", "tests/test_heavy.py", "python");
    staticEdge(db, "tests/test_heavy", "src/sym", 8);
    // test_far: static depth 2 (ranks last).
    seedNode(db, "tests/test_far", "test_far", "tests/test_far.py", "python");
    staticEdge(db, "src/mid", "src/sym", 1);
    staticEdge(db, "tests/test_far", "src/mid", 1);

    const res = affectedTests(db, "src/sym");
    expect(res.tests.map((t) => t.id)).toEqual([
      "tests/test_heavy", // depth 1, weight 8
      "tests/test_near", // depth 1, weight 1
      "tests/test_far", // depth 2
    ]);
  });
});

describe("affectedTests — non-test exclusion", () => {
  it("drops reached nodes that are NOT tests", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // A production helper (no test name, no test path) reaches sym — must NOT
    // appear in the run list even though the walk reaches it.
    seedNode(db, "src/prod_helper", "doWork", "src/prod_helper.ts");
    staticEdge(db, "src/prod_helper", "src/sym", 1);
    // An actual test that goes THROUGH the helper.
    seedNode(db, "tests/test_real", "test_real", "tests/test_real.py", "python");
    staticEdge(db, "tests/test_real", "src/prod_helper", 1);

    const res = affectedTests(db, "src/sym");
    expect(res.tests.map((t) => t.id)).toEqual(["tests/test_real"]);
    expect(res.tests.every((t) => t.id !== "src/prod_helper")).toBe(true);
  });
});

describe("affectedTests — traceOnly filter", () => {
  it("keeps only evidence:trace tests when traceOnly is set", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_static", "test_static", "tests/test_static.py", "python");
    staticEdge(db, "tests/test_static", "src/sym", 1);
    seedNode(db, "tests/test_trace", "test_trace", "tests/test_trace.py", "python");
    traceObs(db, "test_trace", "symFn", 1);

    const all = affectedTests(db, "src/sym");
    expect(all.tests).toHaveLength(2);

    const traceOnly = affectedTests(db, "src/sym", { traceOnly: true });
    expect(traceOnly.tests).toHaveLength(1);
    expect(traceOnly.tests[0]!.id).toBe("tests/test_trace");
    expect(traceOnly.tests.every((t) => t.evidence === "trace")).toBe(true);
  });
});

describe("affectedTests — limit", () => {
  it("caps the returned test count after ranking", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    for (let i = 0; i < 4; i++) {
      seedNode(db, `tests/test_${i}`, `test_${i}`, `tests/test_${i}.py`, "python");
      staticEdge(db, `tests/test_${i}`, "src/sym", i + 1); // distinct weights for stable order
    }

    const res = affectedTests(db, "src/sym", { limit: 2 });
    expect(res.tests).toHaveLength(2);
    // Heaviest first (depth all 1): test_3 (w4), test_2 (w3).
    expect(res.tests.map((t) => t.id)).toEqual(["tests/test_3", "tests/test_2"]);
  });
});

describe("affectedTests — cold trace cache", () => {
  it("sets the cold note but still returns static results", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_x", "test_x", "tests/test_x.py", "python");
    staticEdge(db, "tests/test_x", "src/sym", 1);
    // Zero observations → cold.

    const res = affectedTests(db, "src/sym");
    expect(res.traceEdgeCount).toBe(0);
    expect(res.note).toContain("UNDER-report");
    expect(res.tests).toHaveLength(1);
    expect(res.tests[0]!.evidence).toBe("static");
  });

  it("returns a 'symbol not found' note for an unresolvable symbol", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    const res = affectedTests(db, "totally::nonexistent::zzz");
    expect(res.roots).toEqual([]);
    expect(res.tests).toEqual([]);
    expect(res.note).toBe("symbol not found");
  });
});

describe("affectedTestsForFiles — union across files", () => {
  it("unions two files, keeping strongest evidence + min depth per test", () => {
    const db = freshDb();
    // File A defines symA; File B defines symB.
    seedNode(db, "src/a/symA", "symA", "src/a/mod.ts");
    seedNode(db, "src/b/symB", "symB", "src/b/mod.ts");

    // test_shared reaches symA via STATIC at depth 2, and symB via TRACE at
    // depth 1. Union: strongest evidence = trace, min depth = 1.
    seedNode(db, "tests/test_shared", "test_shared", "tests/test_shared.py", "python");
    seedNode(db, "src/a/mid", "midA", "src/a/mid.ts");
    staticEdge(db, "src/a/mid", "src/a/symA", 1);
    staticEdge(db, "tests/test_shared", "src/a/mid", 1); // depth 2 via file A
    traceObs(db, "test_shared", "symB", 4); // depth 1 via file B (trace)

    // test_a_only reaches only symA (static, depth 1).
    seedNode(db, "tests/test_a_only", "test_a_only", "tests/test_a_only.py", "python");
    staticEdge(db, "tests/test_a_only", "src/a/symA", 1);

    const res = affectedTestsForFiles(db, ["src/a/mod.ts", "src/b/mod.ts"]);

    // roots = union of entity nodes defined in the two files.
    expect(res.roots).toEqual(["src/a/symA", "src/b/symB"]);

    const shared = res.tests.find((t) => t.id === "tests/test_shared")!;
    expect(shared).toBeDefined();
    expect(shared.evidence).toBe("trace"); // trace from file B wins
    expect(shared.depth).toBe(1); // min depth across files

    const aOnly = res.tests.find((t) => t.id === "tests/test_a_only")!;
    expect(aOnly.evidence).toBe("static");
    expect(aOnly.depth).toBe(1);

    // Ranking: trace (shared) before static (a_only).
    expect(res.tests.map((t) => t.id)).toEqual(["tests/test_shared", "tests/test_a_only"]);
  });
});

describe("affectedTests — runnable/runner surfacing", () => {
  it("surfaces a pytest node-id runnable + runner for a test_*.py test", () => {
    const db = freshDb();
    seedNode(db, "src/foo", "fooFn", "src/foo.ts");
    seedNode(db, "tests/test_foo", "test_foo", "tests/test_foo.py", "python");
    staticEdge(db, "tests/test_foo", "src/foo", 1);

    const res = affectedTests(db, "src/foo");
    expect(res.tests).toHaveLength(1);
    const t = res.tests[0]!;
    expect(t.runner).toBe("pytest");
    expect(t.runnable).toBe("tests/test_foo.py::test_foo");
    expect(t.file).toBe("tests/test_foo.py");
  });
});

/**
 * The PRECISION FIX (`db/test_coverage.ts` + the precise path in
 * `affected_tests.ts`). When ANY `test_coverage` row exists, trace evidence comes
 * from PER-TEST coverage (each test's OWN observed execution), NOT the global
 * transitive trace walk that collapses through shared hubs and over-reports
 * (bench/affected-tests-RESULTS.md: recall 1.00, precision 0.01–0.54).
 */
describe("affectedTests — precise per-test coverage path", () => {
  /**
   * THE HEADLINE TIERING GUARD. A symbol is PRECISELY covered by one test, but an
   * UNRELATED test reaches it transitively through a shared hub in the GLOBAL
   * observations graph — exactly the false positive the global walk over-reports.
   * The TIERED precise path keeps both for recall safety but ranks them by
   * confidence: the truly-covering test is `observed` (precision), the hub-only
   * one is `reachable` (safety net). `--trace-only` narrows to the `observed`
   * tier — the minimal high-precision set the precision fix delivers.
   */
  it("tiers the truly-covering test (observed) above a hub-only one (reachable)", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // The test that ACTUALLY executes sym (precise per-test coverage).
    seedNode(db, "tests/test_covers", "test_covers", "tests/test_covers.py", "python");
    coverage(db, "test_covers", "symFn", 6);

    // An UNRELATED test + a shared hub. The GLOBAL observation graph links
    // test_hub_only → hub → sym, so the transitive walk reaches it. It belongs in
    // the `reachable` safety net, NOT the `observed` set.
    seedNode(db, "tests/test_hub_only", "test_hub_only", "tests/test_hub_only.py", "python");
    seedNode(db, "src/hub", "hubFn", "src/hub.ts");
    traceObs(db, "test_hub_only", "hubFn", 9); // test → hub (global)
    traceObs(db, "hubFn", "symFn", 9); // hub → sym (global) — the transitive edge

    const res = affectedTests(db, "src/sym");
    expect(res.precise).toBe(true);
    expect(res.note).toContain("precise");

    // DEFAULT keeps both (recall safety), but the covering test is `observed` and
    // ranks FIRST; the hub-only one is `reachable`.
    const covers = res.tests.find((x) => x.id === "tests/test_covers")!;
    const hub = res.tests.find((x) => x.id === "tests/test_hub_only")!;
    expect(covers.confidence).toBe("observed");
    expect(covers.evidence).toBe("trace");
    expect(covers.depth).toBe(1);
    expect(covers.weight).toBe(6);
    expect(hub.confidence).toBe("reachable");
    // Observed ranks ahead of reachable.
    expect(res.tests[0]!.id).toBe("tests/test_covers");

    // `--trace-only` narrows to the OBSERVED tier — the precision win: ONLY the
    // test we KNOW executed sym, the hub-only false positive excluded.
    const precise = affectedTests(db, "src/sym", { traceOnly: true });
    expect(precise.tests).toHaveLength(1);
    expect(precise.tests[0]!.id).toBe("tests/test_covers");
    expect(precise.tests[0]!.confidence).toBe("observed");
  });

  it("fuses precise coverage (trace) with the STATIC reverse walk (static)", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // A precise coverage test (trace).
    seedNode(db, "tests/test_cov", "test_cov", "tests/test_cov.py", "python");
    coverage(db, "test_cov", "symFn", 4);
    // A static-only test reaching sym via a static call edge (static, depth 1).
    seedNode(db, "tests/test_static", "test_static", "tests/test_static.py", "python");
    staticEdge(db, "tests/test_static", "src/sym", 2);

    const res = affectedTests(db, "src/sym");
    expect(res.precise).toBe(true);
    expect(res.tests.map((t) => t.id)).toEqual(["tests/test_cov", "tests/test_static"]);
    expect(res.tests[0]!.evidence).toBe("trace"); // coverage ranks first
    expect(res.tests[1]!.evidence).toBe("static");
  });

  it("OR-promotes a statically-reached test to trace when coverage also covers it", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // The SAME test reaches sym both statically AND via precise coverage.
    seedNode(db, "tests/test_both", "test_both", "tests/test_both.py", "python");
    staticEdge(db, "tests/test_both", "src/sym", 2);
    coverage(db, "test_both", "symFn", 8);

    const res = affectedTests(db, "src/sym");
    expect(res.precise).toBe(true);
    expect(res.tests).toHaveLength(1);
    const t = res.tests[0]!;
    expect(t.evidence).toBe("trace"); // coverage OR-promotes over static
    expect(t.weight).toBe(8); // coverage weight wins for ranking
    expect(t.depth).toBe(1);
  });

  it("traceOnly keeps only the coverage-backed tests on the precise path", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_cov", "test_cov", "tests/test_cov.py", "python");
    coverage(db, "test_cov", "symFn", 1);
    seedNode(db, "tests/test_static", "test_static", "tests/test_static.py", "python");
    staticEdge(db, "tests/test_static", "src/sym", 1);

    const res = affectedTests(db, "src/sym", { traceOnly: true });
    expect(res.precise).toBe(true);
    expect(res.tests.map((t) => t.id)).toEqual(["tests/test_cov"]);
    expect(res.tests.every((t) => t.evidence === "trace")).toBe(true);
  });

  it("affectedTestsForFiles unions precise coverage across each file's entities", () => {
    const db = freshDb();
    // File A defines symA; File B defines symB.
    seedNode(db, "src/a/symA", "symA", "src/a/mod.ts");
    seedNode(db, "src/b/symB", "symB", "src/b/mod.ts");
    // test_a precisely covers symA; test_b precisely covers symB.
    seedNode(db, "tests/test_a", "test_a", "tests/test_a.py", "python");
    seedNode(db, "tests/test_b", "test_b", "tests/test_b.py", "python");
    coverage(db, "test_a", "symA", 3);
    coverage(db, "test_b", "symB", 5);

    const res = affectedTestsForFiles(db, ["src/a/mod.ts", "src/b/mod.ts"]);
    expect(res.precise).toBe(true);
    expect(res.roots).toEqual(["src/a/symA", "src/b/symB"]);
    // Union of both files' precise coverage; both are trace, depth 1.
    expect(res.tests.map((t) => t.id).sort()).toEqual(["tests/test_a", "tests/test_b"]);
    expect(res.tests.every((t) => t.evidence === "trace" && t.depth === 1)).toBe(true);
  });

  it("returns a 'symbol not found' note (precise) for an unresolvable symbol", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_cov", "test_cov", "tests/test_cov.py", "python");
    coverage(db, "test_cov", "symFn", 1); // table non-empty → precise path

    const res = affectedTests(db, "totally::nonexistent::zzz");
    expect(res.roots).toEqual([]);
    expect(res.tests).toEqual([]);
    expect(res.precise).toBe(true);
    expect(res.note).toBe("symbol not found");
  });
});
