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

describe("affectedTestsForFiles — per-root reachable fallback (multi-file safety)", () => {
  // Regression guard for the multi-root masking bug: with a GLOBAL empty-check,
  // an uncovered changed file's tests were silently dropped whenever ANY OTHER
  // changed file happened to be covered. The fallback must fire PER ROOT.
  function seedTwoFileFixture(): Db {
    const db = freshDb();
    // File A: symbol covered by per-test coverage (precise path on, A observed).
    seedNode(db, "src/a", "aFn", "src/a.ts");
    seedNode(db, "tests/test_a", "test_a", "tests/test_a.py", "python");
    coverage(db, "test_a", "aFn", 5);
    // File B: symbol with NO coverage, but statically reachable from test_b.
    seedNode(db, "src/b", "bFn", "src/b.ts");
    seedNode(db, "tests/test_b", "test_b", "tests/test_b.py", "python");
    staticEdge(db, "tests/test_b", "src/b", 4); // test_b calls b
    return db;
  }

  it("keeps the UNCOVERED file's reachable test even when another file IS covered", () => {
    const db = seedTwoFileFixture();
    const res = affectedTestsForFiles(db, ["src/a.ts", "src/b.ts"], {
      traceOnly: true,
      fallbackReachableWhenEmpty: true,
    });
    const ids = res.tests.map((t) => t.id).sort();
    expect(ids).toEqual(["tests/test_a", "tests/test_b"]); // test_b NOT dropped
    expect(res.note).toContain("reachable safety set"); // fellBack fired
  });

  it("without the fallback opt-in, the uncovered file's test is (correctly) excluded under traceOnly", () => {
    const db = seedTwoFileFixture();
    const res = affectedTestsForFiles(db, ["src/a.ts", "src/b.ts"], { traceOnly: true });
    expect(res.tests.map((t) => t.id)).toEqual(["tests/test_a"]);
    expect(res.note).not.toContain("reachable safety set");
  });
});

describe("affectedTests — SAFE-tier class rollup", () => {
  /**
   * Seed a class `Runner` (file `src/testing.py`) with two METHODS sharing the
   * class prefix in their `qualified_name`, plus two tests:
   *   - `test_prompt` covers the CHANGED leaf `Runner.visible_input` (observed).
   *   - `test_pipeline` covers the SIBLING `Runner.invoke` but NEVER the changed
   *     leaf — the intrinsic bug-only-edge shape (no test→leaf coverage, no static
   *     edge). It is the regression-catcher the class rollup must recover.
   */
  function seedClassFixture(): Db {
    const db = freshDb();
    const file = "src/testing.py";
    const seedMethod = (id: string, qn: string) =>
      db.upsertNode({
        id, name: qn.slice(qn.lastIndexOf(".") + 1), qualified_name: qn,
        kind: "method", language: "python", file, range: [1, 10],
        ast_hash: "h", last_seen: 0, logical_clock: 0,
      });
    seedMethod("click/testing/Runner.visible_input", "Runner.visible_input");
    seedMethod("click/testing/Runner.invoke", "Runner.invoke");
    seedNode(db, "tests/test_prompt", "test_prompt", "tests/test_prompt.py", "python");
    seedNode(db, "tests/test_pipeline", "test_pipeline", "tests/test_pipeline.py", "python");
    // test_prompt covers the changed leaf directly (observed source).
    coverage(db, "test_prompt", "Runner.visible_input", 3);
    // test_pipeline covers a SIBLING method only — never the changed leaf.
    coverage(db, "test_pipeline", "Runner.invoke", 5);
    return db;
  }

  it("OBSERVED tier is BYTE-IDENTICAL with and without the rollup", () => {
    const db = seedClassFixture();
    const off = affectedTests(db, "click/testing/Runner.visible_input", { traceOnly: true });
    const on = affectedTests(db, "click/testing/Runner.visible_input", { traceOnly: true, classRollup: true });
    // Only test_prompt observed the changed leaf; the rollup must not touch it.
    expect(off.tests.map((t) => t.id)).toEqual(["tests/test_prompt"]);
    expect(on.tests.map((t) => ({ id: t.id, c: t.confidence }))).toEqual(
      off.tests.map((t) => ({ id: t.id, c: t.confidence })),
    );
    expect(on.tests.every((t) => t.confidence === "observed")).toBe(true);
  });

  it("default (no rollup) MISSES the sibling-class-covered regression test", () => {
    const db = seedClassFixture();
    const safe = affectedTests(db, "click/testing/Runner.visible_input", {});
    // Without the rollup the sibling-only test never surfaces — the intrinsic miss.
    expect(safe.tests.map((t) => t.id)).toEqual(["tests/test_prompt"]);
    expect(safe.tests.some((t) => t.id === "tests/test_pipeline")).toBe(false);
  });

  it("rollup ADDS the sibling-class-covered test to the REACHABLE tier (never observed)", () => {
    const db = seedClassFixture();
    const safe = affectedTests(db, "click/testing/Runner.visible_input", { classRollup: true });
    const byId = new Map(safe.tests.map((t) => [t.id, t]));
    // The rollup recovers test_pipeline (covers sibling Runner.invoke).
    expect(byId.has("tests/test_pipeline")).toBe(true);
    expect(byId.get("tests/test_pipeline")!.confidence).toBe("reachable");
    // The directly-covered test stays in the high-precision observed tier.
    expect(byId.get("tests/test_prompt")!.confidence).toBe("observed");
    // CRITICAL: the rollup NEVER promotes a rolled-up test to observed.
    const rolledObserved = safe.tests.filter(
      (t) => t.confidence === "observed" && t.id !== "tests/test_prompt",
    );
    expect(rolledObserved).toEqual([]);
  });

  it("does NOT roll up for a top-level function change (no enclosing class)", () => {
    const db = freshDb();
    // A plain module-level function in the same file as a class method — its
    // bare qualname has no PascalCase class head, so nothing rolls up.
    seedNode(db, "src/util/helper", "helper", "src/util.py", "python");
    db.upsertNode({
      id: "src/util/Thing.method", name: "method", qualified_name: "Thing.method",
      kind: "method", language: "python", file: "src/util.py", range: [1, 10],
      ast_hash: "h", last_seen: 0, logical_clock: 0,
    });
    seedNode(db, "tests/test_thing", "test_thing", "tests/test_thing.py", "python");
    coverage(db, "test_thing", "Thing.method", 1);
    coverage(db, "test_helper_cov", "helper", 1);
    seedNode(db, "tests/test_helper_cov", "test_helper_cov", "tests/test_helper_cov.py", "python");

    const safe = affectedTests(db, "src/util/helper", { classRollup: true });
    // helper is not a class method → Thing's tests must NOT be pulled in.
    expect(safe.tests.some((t) => t.id === "tests/test_thing")).toBe(false);
  });
});

/**
 * DISPATCH-ONLY TAGGING (#2) — the differentiated value. `staticReachable` is the
 * STATIC-ONLY reverse walk (db.incoming call/import, no trace edges); a test
 * reached via trace but NOT statically is `dispatchOnly:true` — the set a
 * grep/static reverse-search would MISS.
 */
describe("affectedTests — dispatchOnly tagging", () => {
  it("tags a trace test with NO static path dispatchOnly:true, a statically-reachable trace test false", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // test_dispatch: reached ONLY via a runtime trace edge — no static edge to sym.
    seedNode(db, "tests/test_dispatch", "test_dispatch", "tests/test_dispatch.py", "python");
    traceObs(db, "test_dispatch", "symFn", 7);
    // test_both: reached via BOTH a static call edge AND a trace edge — static
    // analysis alone WOULD have found it, so it is NOT dispatch-only.
    seedNode(db, "tests/test_both", "test_both", "tests/test_both.py", "python");
    staticEdge(db, "tests/test_both", "src/sym", 2);
    traceObs(db, "test_both", "symFn", 9);

    const res = affectedTests(db, "src/sym");

    const dispatch = res.tests.find((t) => t.id === "tests/test_dispatch")!;
    const both = res.tests.find((t) => t.id === "tests/test_both")!;

    // The trace-only test: not statically reachable → dispatchOnly.
    expect(dispatch.evidence).toBe("trace");
    expect(dispatch.staticReachable).toBe(false);
    expect(dispatch.dispatchOnly).toBe(true);

    // The both-ways test: statically reachable → trace evidence but NOT dispatchOnly.
    expect(both.evidence).toBe("trace");
    expect(both.staticReachable).toBe(true);
    expect(both.dispatchOnly).toBe(false);

    // Result summary counts the dispatch-only set.
    expect(res.dispatchOnlyCount).toBe(1);
  });

  it("a purely STATIC test is staticReachable:true and dispatchOnly:false", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_static", "test_static", "tests/test_static.py", "python");
    staticEdge(db, "tests/test_static", "src/sym", 3);

    const res = affectedTests(db, "src/sym");
    const t = res.tests[0]!;
    expect(t.evidence).toBe("static");
    expect(t.staticReachable).toBe(true);
    expect(t.dispatchOnly).toBe(false); // static evidence is never dispatch-only
    expect(res.dispatchOnlyCount).toBe(0);
  });

  it("a transitively-static trace test (static path through a hub) is NOT dispatchOnly", () => {
    const db = freshDb();
    // test → mid (static) → sym (static): statically reachable at depth 2. ALSO a
    // direct trace edge test → sym. Trace evidence, but static analysis finds it.
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "src/mid", "midFn", "src/mid.ts");
    seedNode(db, "tests/test_t", "test_t", "tests/test_t.py", "python");
    staticEdge(db, "src/mid", "src/sym", 1);
    staticEdge(db, "tests/test_t", "src/mid", 1);
    traceObs(db, "test_t", "symFn", 5);

    const res = affectedTests(db, "src/sym");
    const t = res.tests.find((x) => x.id === "tests/test_t")!;
    expect(t.evidence).toBe("trace"); // trace OR-promotes
    expect(t.staticReachable).toBe(true); // reachable via the static mid path
    expect(t.dispatchOnly).toBe(false);
  });

  it("dispatchOnly on the PRECISE path: coverage-observed test with no static path is dispatchOnly", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // Precise per-test coverage, no static edge → observed via runtime dispatch.
    seedNode(db, "tests/test_cov", "test_cov", "tests/test_cov.py", "python");
    coverage(db, "test_cov", "symFn", 6);
    // A statically-reachable test too (so the precise path is engaged AND we have
    // a non-dispatch test to contrast).
    seedNode(db, "tests/test_static", "test_static", "tests/test_static.py", "python");
    staticEdge(db, "tests/test_static", "src/sym", 2);

    const res = affectedTests(db, "src/sym");
    expect(res.precise).toBe(true);
    const cov = res.tests.find((t) => t.id === "tests/test_cov")!;
    const stat = res.tests.find((t) => t.id === "tests/test_static")!;
    expect(cov.confidence).toBe("observed");
    expect(cov.staticReachable).toBe(false);
    expect(cov.dispatchOnly).toBe(true);
    expect(stat.dispatchOnly).toBe(false);
    expect(res.dispatchOnlyCount).toBe(1);
  });
});

/**
 * HUB-AWARE RANKING (#3) — when the affected set is a large fraction of all test
 * nodes (>= HUB_BLAST_RADIUS_THRESHOLD), the symbol is a HUB; `hub:true` +
 * `blastRadiusFraction` surface the honest blast radius.
 */
describe("affectedTests — hub detection", () => {
  it("fires hub:true when the affected set exceeds the threshold", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // 4 test nodes total; 2 reach sym → fraction 0.5 >= 0.3 → hub.
    seedNode(db, "tests/test_a", "test_a", "tests/test_a.py", "python");
    seedNode(db, "tests/test_b", "test_b", "tests/test_b.py", "python");
    staticEdge(db, "tests/test_a", "src/sym", 1);
    staticEdge(db, "tests/test_b", "src/sym", 1);
    // Two unrelated tests that do NOT reach sym (enlarge the denominator).
    seedNode(db, "tests/test_c", "test_c", "tests/test_c.py", "python");
    seedNode(db, "tests/test_d", "test_d", "tests/test_d.py", "python");

    const res = affectedTests(db, "src/sym");
    expect(res.tests).toHaveLength(2);
    expect(res.blastRadiusFraction).toBeCloseTo(0.5, 5); // 2 of 4 test nodes
    expect(res.hub).toBe(true);
  });

  it("does NOT fire hub for a small blast radius below the threshold", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // 1 of 5 test nodes reaches sym → 0.2 < 0.3 → not a hub.
    seedNode(db, "tests/test_hit", "test_hit", "tests/test_hit.py", "python");
    staticEdge(db, "tests/test_hit", "src/sym", 1);
    for (let i = 0; i < 4; i++) {
      seedNode(db, `tests/test_miss_${i}`, `test_miss_${i}`, `tests/test_miss_${i}.py`, "python");
    }

    const res = affectedTests(db, "src/sym");
    expect(res.tests).toHaveLength(1);
    expect(res.blastRadiusFraction).toBeCloseTo(0.2, 5);
    expect(res.hub).toBe(false);
  });

  it("a `limit` does NOT mask hub detection (computed from the full pre-limit set)", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // 2 of 2 test nodes reach sym → fraction 1.0 → hub, even with limit 1.
    seedNode(db, "tests/test_a", "test_a", "tests/test_a.py", "python");
    seedNode(db, "tests/test_b", "test_b", "tests/test_b.py", "python");
    staticEdge(db, "tests/test_a", "src/sym", 2);
    staticEdge(db, "tests/test_b", "src/sym", 1);

    const res = affectedTests(db, "src/sym", { limit: 1 });
    expect(res.tests).toHaveLength(1); // truncated
    expect(res.blastRadiusFraction).toBeCloseTo(1.0, 5); // but hub from full set
    expect(res.hub).toBe(true);
  });

  it("a `limit` does NOT mask hub detection on the reachable-fallback path", () => {
    // Regression: the single-symbol precise path recomputed the pre-limit hub set
    // via a bare `rankReached` that re-applied `traceOnly` but SKIPPED the reachable
    // fallback. On an uncovered-but-statically-reachable symbol the observed/
    // traceOnly tier is EMPTY, so that re-rank came back empty → hub=false/fraction=0
    // even though the RETURNED tests are a non-empty reachable set. A `--limit` then
    // silently masked the hub. The full pre-limit hub set must run the SAME
    // observed-rank + applyReachableFallback pipeline the returned `tests` do.
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // TWO tests statically reach sym; NO per-test coverage exists for sym, so under
    // traceOnly the observed set is empty → the reachable fallback returns them.
    seedNode(db, "tests/test_a", "test_a", "tests/test_a.py", "python");
    seedNode(db, "tests/test_b", "test_b", "tests/test_b.py", "python");
    staticEdge(db, "tests/test_a", "src/sym", 1);
    staticEdge(db, "tests/test_b", "src/sym", 1);
    // One unrelated covered test → engages the PRECISE path (testCoverageCount > 0)
    // and enlarges the denominator to 3 (fraction 2/3 ≈ 0.667 ≥ 0.3 → hub).
    seedNode(db, "tests/test_c", "test_c", "tests/test_c.py", "python");
    coverage(db, "test_c", "someUnrelated", 1);

    // Without a limit: fallback fires, 2 of 3 test nodes → hub.
    const full = affectedTests(db, "src/sym", {
      traceOnly: true,
      fallbackReachableWhenEmpty: true,
    });
    expect(full.tests).toHaveLength(2);
    expect(full.note).toContain("reachable safety set"); // fellBack fired
    expect(full.blastRadiusFraction).toBeCloseTo(2 / 3, 5);
    expect(full.hub).toBe(true);

    // With limit 1: the returned set is truncated, but the hub metric must STILL be
    // computed from the full pre-limit reachable-fallback set (2/3), not zero.
    const limited = affectedTests(db, "src/sym", {
      traceOnly: true,
      fallbackReachableWhenEmpty: true,
      limit: 1,
    });
    expect(limited.tests).toHaveLength(1); // truncated
    expect(limited.blastRadiusFraction).toBeCloseTo(2 / 3, 5); // hub from full set
    expect(limited.hub).toBe(true);
  });
});

/**
 * ORDERING (#3) — dispatchOnly tests rank FIRST (the differentiated, easy-to-miss
 * value), then the prior order (observed → trace → depth → weight → id).
 */
describe("affectedTests — dispatchOnly-first ordering", () => {
  it("puts a dispatch-only test ahead of a statically-reachable trace test", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // test_static_trace: reachable both statically AND via trace → trace, NOT
    // dispatch-only. Heavy weight so without dispatch-first it would rank first.
    seedNode(db, "tests/test_static_trace", "test_static_trace", "tests/test_st.py", "python");
    staticEdge(db, "tests/test_static_trace", "src/sym", 5);
    traceObs(db, "test_static_trace", "symFn", 50);
    // test_dispatch: trace-only, no static path → dispatch-only, lighter weight.
    seedNode(db, "tests/test_dispatch", "test_dispatch", "tests/test_dispatch.py", "python");
    traceObs(db, "test_dispatch", "symFn", 1);

    const res = affectedTests(db, "src/sym");
    // dispatch-only ranks FIRST despite its lighter weight.
    expect(res.tests.map((t) => t.id)).toEqual([
      "tests/test_dispatch",
      "tests/test_static_trace",
    ]);
    expect(res.tests[0]!.dispatchOnly).toBe(true);
    expect(res.tests[1]!.dispatchOnly).toBe(false);
  });
});

/**
 * (d) EXISTING fields/behavior unchanged: the new fields are purely ADDITIVE — the
 * old evidence/confidence/depth/weight/runnable/runner fields keep their values.
 */
describe("affectedTests — additive fields leave existing behavior unchanged", () => {
  it("keeps every prior field value alongside the new staticReachable/dispatchOnly", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_helper", "test_uses_helper", "tests/test_helper.py", "python");
    seedNode(db, "src/helper", "helperFn", "src/helper.ts");
    staticEdge(db, "src/helper", "src/sym", 3);
    staticEdge(db, "tests/test_helper", "src/helper", 5);

    const res = affectedTests(db, "src/sym");
    const t = res.tests[0]!;
    // Prior contract (mirrors the static-only headline test) intact.
    expect(t.id).toBe("tests/test_helper");
    expect(t.evidence).toBe("static");
    expect(t.confidence).toBe("reachable");
    expect(t.depth).toBe(2);
    expect(t.runner).toBe("pytest");
    expect(t.runnable).toBe("tests/test_helper.py::test_uses_helper");
    // New additive fields present + correct.
    expect(t.staticReachable).toBe(true);
    expect(t.dispatchOnly).toBe(false);
    // New result-level fields present.
    expect(res.dispatchOnlyCount).toBe(0);
    expect(typeof res.hub).toBe("boolean");
    expect(typeof res.blastRadiusFraction).toBe("number");
  });

  it("affectedTestsForFiles carries the new fields too", () => {
    const db = freshDb();
    seedNode(db, "src/a/symA", "symA", "src/a/mod.ts");
    seedNode(db, "tests/test_dispatch", "test_dispatch", "tests/test_dispatch.py", "python");
    traceObs(db, "test_dispatch", "symA", 4); // trace-only → dispatch-only

    const res = affectedTestsForFiles(db, ["src/a/mod.ts"]);
    const t = res.tests.find((x) => x.id === "tests/test_dispatch")!;
    expect(t.dispatchOnly).toBe(true);
    expect(t.staticReachable).toBe(false);
    expect(res.dispatchOnlyCount).toBe(1);
    expect(typeof res.hub).toBe("boolean");
    expect(typeof res.blastRadiusFraction).toBe("number");
  });
});
