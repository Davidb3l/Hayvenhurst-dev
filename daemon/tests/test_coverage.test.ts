/**
 * PRECISE per-test coverage index (`db/test_coverage.ts`).
 *
 * The headline contract: the index resolves each `test_coverage` row's RAW
 * runtime `test`/`entity` names to node ids through the SAME conservative
 * resolver the global trace path uses (`buildTraceResolver`), DROPS any row whose
 * either endpoint can't be resolved unambiguously, and sums weight per (entity,
 * test). This is the attribution-preserving signal that fixes the global
 * transitive walk's over-reporting (bench/affected-tests-RESULTS.md).
 *
 * Fixtures are synthetic in-memory graphs: nodes via `db.upsertNode` with DISTINCT
 * bare `name` == `qualified_name` so a coverage row whose test/entity is that name
 * resolves unambiguously to this id (same pattern as `neighbors_trace.test.ts` /
 * `affected_tests.test.ts`). Coverage rows via `db.insertTestCoverage`.
 */
import { describe, expect, it } from "bun:test";

import { Db } from "../src/db/queries.ts";
import {
  buildTestCoverageIndex,
  testsCovering,
} from "../src/db/test_coverage.ts";

/**
 * Index a node with a DISTINCT bare `name` == `qualified_name` so a coverage row
 * whose `test`/`entity` is that name resolves unambiguously to this id.
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
    file: file as string,
    range: [1, 10],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

function freshDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  return db;
}

describe("buildTestCoverageIndex — resolution", () => {
  it("resolves a coverage row's raw test+entity names to node ids", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_sym", "test_sym", "tests/test_sym.py", "python");
    // The test test_sym executed the entity symFn with weight 5.
    db.insertTestCoverage([
      { test: "test_sym", entity: "symFn", weight: 5, source: "py" },
    ]);

    const index = buildTestCoverageIndex(db);
    expect(index.hasCoverage).toBe(true);
    expect(index.testCount).toBe(1);
    const entries = index.byEntity.get("src/sym");
    expect(entries).toBeDefined();
    expect(entries).toEqual([{ testId: "tests/test_sym", weight: 5 }]);
  });

  it("drops rows whose test name is unresolvable", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    // The entity resolves, but the test name matches no node → row dropped.
    db.insertTestCoverage([
      { test: "noSuchTest", entity: "symFn", weight: 3, source: "py" },
    ]);

    const index = buildTestCoverageIndex(db);
    expect(index.hasCoverage).toBe(false);
    expect(index.testCount).toBe(0);
    expect(index.byEntity.size).toBe(0);
  });

  it("drops rows whose entity name is unresolvable", () => {
    const db = freshDb();
    seedNode(db, "tests/test_sym", "test_sym", "tests/test_sym.py", "python");
    // The test resolves, but the entity name matches no node → row dropped.
    db.insertTestCoverage([
      { test: "test_sym", entity: "noSuchEntity", weight: 3, source: "py" },
    ]);

    const index = buildTestCoverageIndex(db);
    expect(index.hasCoverage).toBe(false);
    expect(index.testCount).toBe(0);
    expect(index.byEntity.size).toBe(0);
  });

  it("keeps the resolvable rows and drops only the unresolvable ones (mixed)", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_ok", "test_ok", "tests/test_ok.py", "python");
    db.insertTestCoverage([
      { test: "test_ok", entity: "symFn", weight: 2, source: "py" }, // resolves
      { test: "ghost", entity: "symFn", weight: 9, source: "py" }, // test unresolved
      { test: "test_ok", entity: "ghostEntity", weight: 9, source: "py" }, // entity unresolved
    ]);

    const index = buildTestCoverageIndex(db);
    expect(index.hasCoverage).toBe(true);
    expect(index.testCount).toBe(1);
    expect(index.byEntity.get("src/sym")).toEqual([
      { testId: "tests/test_ok", weight: 2 },
    ]);
  });
});

describe("buildTestCoverageIndex — weight accumulation", () => {
  it("sums weight across multiple rows for the same (entity, test)", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_sym", "test_sym", "tests/test_sym.py", "python");
    // Two rows (e.g. two sources / a re-run) for the same test→entity pair.
    db.insertTestCoverage([
      { test: "test_sym", entity: "symFn", weight: 3, source: "py" },
      { test: "test_sym", entity: "symFn", weight: 4, source: "ts" },
    ]);

    const index = buildTestCoverageIndex(db);
    expect(index.testCount).toBe(1);
    expect(index.byEntity.get("src/sym")).toEqual([
      { testId: "tests/test_sym", weight: 7 },
    ]);
  });

  it("counts DISTINCT resolved test ids across all coverage", () => {
    const db = freshDb();
    seedNode(db, "src/a", "aFn", "src/a.ts");
    seedNode(db, "src/b", "bFn", "src/b.ts");
    seedNode(db, "tests/test_1", "test_1", "tests/test_1.py", "python");
    seedNode(db, "tests/test_2", "test_2", "tests/test_2.py", "python");
    db.insertTestCoverage([
      { test: "test_1", entity: "aFn", weight: 1, source: "py" },
      { test: "test_1", entity: "bFn", weight: 1, source: "py" }, // same test, 2 entities
      { test: "test_2", entity: "aFn", weight: 1, source: "py" },
    ]);

    const index = buildTestCoverageIndex(db);
    // test_1 + test_2 = 2 distinct tests (test_1 across two entities counts once).
    expect(index.testCount).toBe(2);
  });
});

describe("testsCovering — ordering + convenience", () => {
  it("returns the tests covering an entity, summed-weight desc then id asc", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_light", "test_light", "tests/test_light.py", "python");
    seedNode(db, "tests/test_heavy", "test_heavy", "tests/test_heavy.py", "python");
    seedNode(db, "tests/test_tie", "test_tie", "tests/test_tie.py", "python");
    db.insertTestCoverage([
      { test: "test_light", entity: "symFn", weight: 1, source: "py" },
      { test: "test_heavy", entity: "symFn", weight: 5, source: "py" },
      { test: "test_tie", entity: "symFn", weight: 5, source: "py" }, // tie w/ heavy
    ]);

    const covering = testsCovering(db, "src/sym");
    // Heaviest first; the weight-5 tie breaks on id asc (test_heavy < test_tie).
    expect(covering).toEqual([
      { testId: "tests/test_heavy", weight: 5 },
      { testId: "tests/test_tie", weight: 5 },
      { testId: "tests/test_light", weight: 1 },
    ]);
  });

  it("returns [] for an entity with no coverage", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    expect(testsCovering(db, "src/sym")).toEqual([]);
    expect(testsCovering(db, "src/never-seen")).toEqual([]);
  });

  it("reuses a prebuilt index and returns a fresh (mutation-safe) array", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    seedNode(db, "tests/test_sym", "test_sym", "tests/test_sym.py", "python");
    db.insertTestCoverage([
      { test: "test_sym", entity: "symFn", weight: 4, source: "py" },
    ]);

    const index = buildTestCoverageIndex(db);
    const first = testsCovering(db, "src/sym", index);
    expect(first).toEqual([{ testId: "tests/test_sym", weight: 4 }]);

    // Mutating the returned array must NOT corrupt the cached index.
    first.push({ testId: "tests/intruder", weight: 99 });
    const second = testsCovering(db, "src/sym", index);
    expect(second).toEqual([{ testId: "tests/test_sym", weight: 4 }]);
  });
});

describe("buildTestCoverageIndex — empty table", () => {
  it("reports no coverage when the table is empty", () => {
    const db = freshDb();
    seedNode(db, "src/sym", "symFn", "src/sym.ts");
    const index = buildTestCoverageIndex(db);
    expect(index.hasCoverage).toBe(false);
    expect(index.testCount).toBe(0);
    expect(index.byEntity.size).toBe(0);
  });
});
