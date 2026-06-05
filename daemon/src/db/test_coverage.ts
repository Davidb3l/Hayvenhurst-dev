/**
 * PRECISE per-test coverage index (the `affected-tests` precision fix).
 *
 * WHY this exists: the original `affected-tests` trace evidence walks the
 * GLOBALLY-aggregated `observations` graph transitively (`resolvedTraceEdges`).
 * We MEASURED (bench/affected-tests-RESULTS.md) that this has recall 1.00 but
 * precision 0.01–0.54: per-test call paths COLLAPSE through shared hubs (e.g.
 * `CliRunner.invoke` links ~506 tests to nearly every symbol), so a symbol that
 * ONE test actually exercised reports as covered by HUNDREDS of unrelated tests.
 * The global graph cannot tell whose call reached the symbol — the aggregation
 * already threw that attribution away.
 *
 * The `test_coverage` table (schema v6) keeps that attribution: it records, PER
 * TEST, the entities that SPECIFIC test executed. This module is the DERIVED
 * read-time index over it — exactly mirroring how `resolvedTraceEdges` derives
 * the resolved trace graph from raw `observations`:
 *   - the table stores RAW runtime names (`<module>:<qualname>`), never node ids;
 *   - we resolve each row's `test` and `entity` names through the SAME
 *     CONSERVATIVE {@link buildTraceResolver} the global path uses;
 *   - a row whose EITHER endpoint can't be resolved unambiguously is DROPPED — an
 *     unresolvable name can't be tied to a node id, so keeping it would either
 *     invent a false coverage edge or leave a dangling key (same discipline as
 *     `resolvedTraceEdges`, which only joins both-resolved edges).
 *
 * PURE: never mutates the `Db`. Deterministic ordering on every output so callers
 * and tests see a fixed result (mirrors graph_walk.ts / affected_tests.ts).
 */
import type { Db } from "./queries.ts";
import { buildTraceResolver } from "../graph/traceResolve.ts";

/** One test's coverage of an entity: the resolved test node id and the summed
 *  weight of that test's executions reaching the entity. */
export interface CoverageEntry {
  testId: string;
  weight: number;
}

/**
 * The resolved per-test coverage index, built ONCE. `byEntity` is the read
 * structure the affected-tests query consumes: given a changed entity, it yields
 * the tests whose OWN execution reached that entity (direct ground truth, no
 * graph distance). `hasCoverage`/`testCount` are the cold/warm + scale signals.
 */
export interface TestCoverageIndex {
  /** entity node id → the tests that executed it (with summed weight). */
  byEntity: Map<string, CoverageEntry[]>;
  /** True when the table had ≥1 row whose BOTH endpoints resolved. */
  hasCoverage: boolean;
  /** Distinct resolved test node ids seen across all coverage. */
  testCount: number;
}

/**
 * Build the per-test coverage index ONCE.
 *
 * Resolves every `test_coverage` row's raw `test` + `entity` names to node ids
 * via {@link buildTraceResolver} (built a single time — like `resolvedTraceEdges`,
 * which rebuilds the resolver per call, we build it here exactly once for the
 * whole table). A row where EITHER endpoint is unresolved is DROPPED (the same
 * both-endpoints-resolved discipline `resolvedTraceEdges` applies). Within an
 * entity, multiple rows for the SAME test (different sources, or a re-run) SUM
 * their weight, so `byEntity[entity]` holds one entry per distinct test.
 *
 * Deterministic: each entity's entries are sorted summed-weight desc, then test
 * id asc, so the output order never depends on table/iteration order.
 */
export function buildTestCoverageIndex(db: Db): TestCoverageIndex {
  const resolver = buildTraceResolver(db);

  // entity id → (test id → summed weight). The inner map dedupes a test across
  // multiple coverage rows (re-runs / sources) before we flatten to entries.
  const accum = new Map<string, Map<string, number>>();
  const testIds = new Set<string>();
  let hasCoverage = false;

  for (const row of db.allTestCoverage()) {
    const testId = resolver.resolve(row.test);
    if (testId === null) continue; // unresolvable test name → drop the row
    const entityId = resolver.resolve(row.entity);
    if (entityId === null) continue; // unresolvable entity name → drop the row

    hasCoverage = true;
    testIds.add(testId);

    let perTest = accum.get(entityId);
    if (perTest === undefined) accum.set(entityId, (perTest = new Map()));
    perTest.set(testId, (perTest.get(testId) ?? 0) + row.weight);
  }

  // Flatten to the public shape with deterministic per-entity ordering.
  const byEntity = new Map<string, CoverageEntry[]>();
  for (const [entityId, perTest] of accum) {
    const entries: CoverageEntry[] = [];
    for (const [testId, weight] of perTest) entries.push({ testId, weight });
    entries.sort((a, b) => b.weight - a.weight || a.testId.localeCompare(b.testId));
    byEntity.set(entityId, entries);
  }

  return { byEntity, hasCoverage, testCount: testIds.size };
}

/**
 * The tests whose OWN execution reached `entityId` (already a resolved node id),
 * summed-weight desc then test id asc — the precise, attribution-preserving
 * answer to "which tests cover this symbol?".
 *
 * Pass a prebuilt `index` to avoid rebuilding the resolver+index inside a loop
 * (the symbol-set path unions `testsCovering` across many entities); omit it for
 * a one-off lookup and we build the index for you. Pure: no `Db` mutation.
 * Returns a FRESH array (a copy of the index's entries) so callers can sort or
 * mutate the result without corrupting the cached index.
 */
export function testsCovering(
  db: Db,
  entityId: string,
  index?: TestCoverageIndex,
): CoverageEntry[] {
  const idx = index ?? buildTestCoverageIndex(db);
  const entries = idx.byEntity.get(entityId);
  // Copy so a caller's downstream sort/mutation can't corrupt the shared index;
  // entries are already in the deterministic order built above.
  return entries ? entries.map((e) => ({ testId: e.testId, weight: e.weight })) : [];
}
