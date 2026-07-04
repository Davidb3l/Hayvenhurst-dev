/**
 * TRACE-AUGMENTED test-impact selection (ROADMAP "affected-tests") — given a
 * changed symbol (or a set of changed files), return the MINIMAL ranked set of
 * tests to run for that change.
 *
 * WHY this is not just `impactOf`: the static call/import graph badly
 * UNDER-reports which tests exercise a symbol. The canonical miss is a re-export
 * (`from click import echo`): a test that calls `echo` through the `click`
 * facade has NO static call edge to the real `utils/echo` definition, so a
 * purely static reverse-walk (`db.incoming`, or `impactOf`) finds ZERO tests and
 * silently tells the agent "nothing to run". The RUNTIME trace collectors capture
 * exactly that edge — the observed `testFn → echo` call — which is the novel
 * ground-truth signal this query fuses in. Building this on `db.incoming` alone
 * defeats the entire feature; we MUST merge `db.resolvedTraceEdges()`.
 *
 * TWO PATHS, chosen by whether PRECISE per-test coverage exists
 * (`db.testCoverageCount() > 0`):
 *
 *   - PRECISE PATH (coverage present) — the precision fix. We MEASURED
 *     (bench/affected-tests-RESULTS.md) that the global transitive trace walk has
 *     recall 1.00 but precision 0.01–0.54: per-test call paths collapse through
 *     shared hubs (`CliRunner.invoke` links ~506 tests to nearly every symbol),
 *     so a symbol one test touched reports as covered by hundreds. The fix: take
 *     trace evidence from PER-TEST coverage (`db/test_coverage.ts` —
 *     `testsCovering`, each test's OWN observed execution, `depth:1`), and DO NOT
 *     use the global transitive trace walk at all. Static evidence is still the
 *     reverse `db.incoming` walk, now run with NO trace edges. Same fusion/ranking.
 *
 *   - FALLBACK PATH (no coverage) — UNCHANGED, backward-compatible. A CYCLE-SAFE
 *     two-colour reverse BFS over the UNION of:
 *       - STATIC incoming edges (`db.incoming`, filtered to call/import kinds), and
 *       - TRACE incoming edges (resolved runtime observations, both endpoints
 *         resolved), built ONCE per call into a `traceIn` adjacency map exactly as
 *         `daemon/src/daemon/routes/stats.ts` constructs it.
 *     Indexes that only seed the global `observations` graph (never
 *     `insertTestCoverage`) take this path and behave exactly as before.
 *
 * Every reached node is classified by {@link classifyTest}; the ones that ARE
 * tests become the run list. A test reached via ANY trace edge is tagged
 * `evidence:"trace"` (ground truth); one reached only through static edges is
 * `evidence:"static"` (predicted, may under-report). Trace beats static when
 * both apply.
 *
 * PURE-ish + deterministic, mirroring graph_walk.ts: no mutation of the `Db`,
 * `.ts` import extensions, 2-space indent, and a stable total ordering on the
 * output so callers and tests see a fixed result.
 */
import type { Db } from "./queries.ts";
import {
  IMPORT_KIND,
  isCallKind,
  MAX_IMPACT_DEPTH,
  resolveNodeId,
} from "./graph_walk.ts";
import { classifyTest, type TestCandidate } from "./test_nodes.ts";
import {
  buildTestCoverageIndex,
  testsCovering,
  type TestCoverageIndex,
} from "./test_coverage.ts";

/**
 * How a test was reached from the changed symbol:
 *   - `"trace"`  — via ≥1 runtime `trace_call` edge (GROUND TRUTH: the suite was
 *     actually observed exercising this path).
 *   - `"static"` — only through static `static_call`/`import` edges (PREDICTED;
 *     static under-reports, e.g. re-exports, so this set may be incomplete).
 */
export type TestEvidence = "trace" | "static";

/**
 * How CONFIDENT we are that running this test exercises the change:
 *   - `"observed"` — per-test coverage shows this SPECIFIC test executed the
 *     changed entity. Ground truth, high precision (MEASURED ~0.98–1.00 on click,
 *     `bench/affected-tests-RESULTS.md`). The minimal "definitely run" set.
 *   - `"reachable"` — the test only REACHES the change through the graph or the
 *     GLOBAL transitive trace walk (which over-reports via shared hubs). The
 *     recall SAFETY NET: might exercise it, kept so the default never silently
 *     drops a real regression-catcher (the precise set alone has ~0.6 recall).
 *
 * Default results return both tiers (observed first); `--trace-only` narrows to
 * the `observed` tier when per-test coverage exists.
 */
export type TestConfidence = "observed" | "reachable";

/** One test in the affected-tests run list. */
export interface AffectedTest {
  /** Test node id. */
  id: string;
  /** Test file (repo-relative) or null. */
  file: string | null;
  /** `trace` = reached via ≥1 runtime trace_call edge (ground truth);
   *  `static` = reached only through static_call/import edges (predicted). */
  evidence: TestEvidence;
  /** Confidence tier (precise path only): `observed` = per-test coverage proved
   *  this test ran the change; `reachable` = graph/transitive reach only. On the
   *  fallback path (no per-test coverage) every test is `reachable`. */
  confidence: TestConfidence;
  /** Shortest BFS depth from the changed symbol (1 = direct). */
  depth: number;
  /** Ranking weight: the edge weight by which it was reached (trace weight when
   *  trace, else summed static edge weight). */
  weight: number;
  /** Runnable handle from classifyTest (pytest node id / spec file) or null. */
  runnable: string | null;
  /** Runner ("pytest"|"vitest"|"jest"|"go"|"cargo"|"unknown"). */
  runner: string;
  /** ADDITIVE. True iff a STATIC-ONLY reverse walk (`db.incoming` call/import
   *  edges, NO trace edges) reaches this test from the changed symbol(s) — i.e. a
   *  grep/static reverse-search would have found it. False means the only path to
   *  this test goes through a runtime trace edge. */
  staticReachable: boolean;
  /** ADDITIVE — the differentiated value. True iff the test was reached via a
   *  runtime trace edge (`evidence === "trace"`) AND static analysis alone would
   *  NOT have found it (`!staticReachable`): observed purely through runtime
   *  dispatch, exactly the set a grep of the changed function name or a static
   *  reverse-walk MISSES. */
  dispatchOnly: boolean;
}

/** Options for {@link affectedTests} / {@link affectedTestsForFiles}. */
export interface AffectedTestsOpts {
  /** Reverse-walk depth cap. Default = MAX_IMPACT_DEPTH from graph_walk.ts (64). */
  maxDepth?: number;
  /** --trace-only: keep ONLY evidence:"trace" tests. */
  traceOnly?: boolean;
  /** SAFETY FALLBACK for the `traceOnly` (minimal) tier: when the observed set is
   *  EMPTY for a changed symbol that DOES have `reachable` tests — the "no per-test
   *  coverage on this shelf" case — return the reachable safety set instead of an
   *  empty (silently unsafe) selection. A minimal selector must never tell you to
   *  "run nothing" for something you changed. Off by default to preserve the strict
   *  observed-only contract; the CLI/product turns it on for `--trace-only`.
   *  No effect unless `traceOnly` is set. */
  fallbackReachableWhenEmpty?: boolean;
  /** Cap the returned test count (after ranking). */
  limit?: number;
  /** Config `test.patterns` (path patterns) forwarded to test detection. */
  patterns?: readonly string[];
  /**
   * SAFE-TIER CLASS ROLLUP (recall safety net for hub-class methods). When a
   * changed symbol is a class METHOD, the per-test coverage of a sibling method
   * of the SAME enclosing class is folded into the `reachable` tier — connecting
   * a test that exercised the class (e.g. covered `CliRunner.invoke`) to a change
   * in a leaf method the test never calls directly (`CliRunner.visible_input`).
   * This closes the INTRINSIC bug-only-edge miss: a regression test that uses the
   * class heavily but never touches the changed leaf method in clean code has NO
   * test→symbol coverage edge and NO static edge, so BOTH tiers miss it.
   *
   * SCOPED to the SAFE/`reachable` tier ONLY: rolled-up tests are tagged
   * confidence `reachable`, NEVER `observed`. The `observed` tier (and therefore
   * `--trace-only` output) is BYTE-IDENTICAL whether this is on or off. Off by
   * default so existing callers/tests are unaffected; the bench SAFE arm + the
   * CLI/product turn it on.
   */
  classRollup?: boolean;
}

/** The ranked run list plus the trace-coverage signal a caller needs to judge
 *  confidence (a cold trace cache means the static-only result may under-report). */
export interface AffectedTestsResult {
  /** The symbol id(s) / file(s) the walk started from (resolved). */
  roots: string[];
  /** Ranked tests to run. */
  tests: AffectedTest[];
  /** Count of resolved trace edges (both endpoints) considered across the project. 0 → cold. */
  traceEdgeCount: number;
  /**
   * ADDITIVE (the precision fix): true when the coverage-backed PRECISE path ran
   * — trace evidence came from per-test `test_coverage` (each test's OWN observed
   * execution), not the global transitive trace walk. False/omitted on the
   * backward-compatible FALLBACK path (no coverage rows → the global
   * `resolvedTraceEdges` two-colour BFS, behaving exactly as before).
   */
  precise?: boolean;
  /** Cold-trace / degrade note, or undefined when traces were present. */
  note?: string;
  /** ADDITIVE. Count of returned tests with `dispatchOnly === true` — the
   *  differentiated set a grep/static search would MISS. */
  dispatchOnlyCount: number;
  /** ADDITIVE. True when the affected set is a large fraction of all test nodes
   *  (`blastRadiusFraction >= HUB_BLAST_RADIUS_THRESHOLD`): the changed symbol is a
   *  HUB, so this map degrades toward "run almost everything". An honest signal,
   *  not an error. */
  hub: boolean;
  /** ADDITIVE. The affected test count as a fraction of total test nodes in the
   *  index (0..1), the basis for {@link hub}. 0 when the index has no test nodes. */
  blastRadiusFraction: number;
}

/**
 * Per-node accumulator built during the reverse BFS. We track the SHORTEST depth
 * (the first BFS layer that reached the node), whether ANY trace edge ever
 * relaxed into it (`viaTrace`, which OR-promotes its evidence to `"trace"`), and
 * a `weight` for ranking — preferring the strongest trace weight if any trace
 * edge reached it, else the strongest static weight.
 */
interface NodeReach {
  depth: number;
  viaTrace: boolean;
  /** Max trace edge weight seen relaxing into this node (when `viaTrace`). */
  traceWeight: number;
  /** Max static edge weight seen relaxing into this node. */
  staticWeight: number;
  /** True once PRECISE per-test coverage attributed the change to this test
   *  (set by {@link injectCoverage}). Distinguishes the high-precision `observed`
   *  tier from the `reachable` safety net; never set on the fallback path. */
  observed: boolean;
}

/** The cold-trace note: traces are the novel signal, so their absence means the
 *  result is static-only and may MISS tests that only runtime reaches. */
const COLD_TRACE_NOTE =
  "no traces yet — static only, may UNDER-report (run the suite once with HAYVEN_TRACE=1)";

/**
 * HUB DETECTION threshold. When the affected test set is at least this fraction of
 * ALL test nodes in the index, the changed symbol is a HUB: its blast radius is so
 * wide the selection degrades toward "run almost everything" and the map's value
 * drops. We surface `hub:true` + the measured `blastRadiusFraction` so a caller
 * can decide honestly (e.g. `type_cast_value` reaches ~19% of click's suite; a
 * genuine hub like a shared base method can exceed 30%). Deterministic, no ML.
 */
export const HUB_BLAST_RADIUS_THRESHOLD = 0.3;

/**
 * Total number of TEST nodes in the index — the denominator for the hub
 * blast-radius fraction. Counts nodes that {@link classifyTest} accepts as tests,
 * honoring the same optional `patterns`. A single bounded scan over `nodes`.
 */
function totalTestNodeCount(db: Db, patterns: readonly string[] | undefined): number {
  const rows = db.handle
    .query<{ id: string; name: string; file: string | null; language: string }, []>(
      "SELECT id, name, file, language FROM nodes",
    )
    .all();
  let n = 0;
  for (const r of rows) {
    const candidate: TestCandidate = {
      id: r.id,
      name: r.name,
      file: r.file,
      language: r.language,
    };
    const handle = patterns !== undefined
      ? classifyTest(candidate, patterns)
      : classifyTest(candidate);
    if (handle !== null) n++;
  }
  return n;
}

/**
 * Build the {@link AffectedTestsResult} hub fields from the ranked test list. The
 * blast-radius fraction is (affected test count / total test nodes); `hub` fires
 * when it crosses {@link HUB_BLAST_RADIUS_THRESHOLD}. A zero denominator (no test
 * nodes indexed) yields fraction 0 / hub false — never divides by zero.
 *
 * NOTE: computed from the FULL ranked set BEFORE any `limit` truncation, so a
 * `--limit` can't mask a hub. Callers pass the pre-limit count.
 */
function hubMetrics(
  db: Db,
  affectedCount: number,
  patterns: readonly string[] | undefined,
): { hub: boolean; blastRadiusFraction: number } {
  const total = totalTestNodeCount(db, patterns);
  const blastRadiusFraction = total > 0 ? affectedCount / total : 0;
  return { hub: blastRadiusFraction >= HUB_BLAST_RADIUS_THRESHOLD, blastRadiusFraction };
}

/**
 * Build the trace INCOMING adjacency map ONCE, mirroring `stats.ts`'s `traceIn`.
 *
 * `db.resolvedTraceEdges()` scans the `observations` table and REBUILDS the
 * runtime-name resolver on every call, so we invoke it EXACTLY ONCE and index
 * the result. Only edges with BOTH endpoints resolved (`resolvedSrc` AND
 * `resolvedDst` non-null) can join the graph — an unresolved endpoint can't be
 * tied to a node id, so it would invent a false edge. Returns the map plus the
 * count of such both-resolved edges (the `traceEdgeCount` confidence signal).
 */
function buildTraceIn(db: Db): {
  traceIn: Map<string, Array<{ src: string; weight: number }>>;
  traceEdgeCount: number;
} {
  const traceIn = new Map<string, Array<{ src: string; weight: number }>>();
  let traceEdgeCount = 0;
  for (const e of db.resolvedTraceEdges()) {
    if (e.resolvedSrc === null || e.resolvedDst === null) continue;
    traceEdgeCount++;
    let inList = traceIn.get(e.resolvedDst);
    if (!inList) traceIn.set(e.resolvedDst, (inList = []));
    inList.push({ src: e.resolvedSrc, weight: e.weight });
  }
  return { traceIn, traceEdgeCount };
}

/**
 * Reverse-BFS the UNION of static + trace incoming edges from `root`, recording
 * for every reached node its shortest depth, whether a trace edge ever reached
 * it, and its ranking weight. Cycle-safe via the `reach` map (each node enters
 * the frontier once). The root itself is excluded from the result.
 *
 * Two-colour subtlety (the headline correctness rule): a node first DISCOVERED
 * via a static edge at depth d must STILL be promoted to trace-evidence if a
 * trace edge ever relaxes into it. So we inspect trace edges into ALREADY-visited
 * nodes too — the visited-guard only suppresses re-enqueueing for the frontier,
 * it must NOT suppress the `viaTrace`/weight update. We merge into a shared
 * `reach` map (passed in) so {@link affectedTestsForFiles} can UNION multiple
 * roots, keeping each node's strongest evidence and min depth across walks.
 */
function reverseWalk(
  db: Db,
  root: string,
  traceIn: Map<string, Array<{ src: string; weight: number }>>,
  cap: number,
  reach: Map<string, NodeReach>,
): void {
  // Local depth bookkeeping for THIS root's BFS layering — independent of the
  // shared `reach` map (which may already hold deeper entries from a prior root).
  const localDepth = new Map<string, number>([[root, 0]]);
  let frontier: string[] = [root];

  /** Relax one incoming edge `neighbor → cur` discovered at BFS depth `d`. */
  const relax = (
    neighbor: string,
    d: number,
    isTrace: boolean,
    weight: number,
    next: string[],
  ): void => {
    if (neighbor === root) return; // never re-add the root

    // Update the SHARED accumulator regardless of the visited-guard, so a trace
    // edge into an already-visited node still OR-promotes its evidence.
    const prev = reach.get(neighbor);
    if (prev === undefined) {
      reach.set(neighbor, {
        depth: d,
        viaTrace: isTrace,
        traceWeight: isTrace ? weight : 0,
        staticWeight: isTrace ? 0 : weight,
        observed: false, // graph/transitive reach only — coverage sets this true
      });
    } else {
      if (d < prev.depth) prev.depth = d;
      if (isTrace) {
        prev.viaTrace = true;
        if (weight > prev.traceWeight) prev.traceWeight = weight;
      } else if (weight > prev.staticWeight) {
        prev.staticWeight = weight;
      }
    }

    // Frontier bookkeeping is keyed on THIS walk's local depth so a node is
    // enqueued at most once per root (cycle-safe).
    if (!localDepth.has(neighbor)) {
      localDepth.set(neighbor, d);
      next.push(neighbor);
    }
  };

  for (let d = 1; d <= cap; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      // STATIC incoming: callers (call edges) + importers (import edges). These
      // are the only kinds that constitute a "depends on the changed symbol"
      // relationship — mirrors impactOf's filter.
      for (const e of db.incoming(cur)) {
        if (e.kind !== IMPORT_KIND && !isCallKind(e.kind)) continue;
        relax(e.src, d, false, e.weight, next);
      }
      // TRACE incoming: runtime-observed callers the static parser missed. This
      // is the novel signal — its presence is what flips evidence to "trace".
      for (const t of traceIn.get(cur) ?? []) {
        relax(t.src, d, true, t.weight, next);
      }
    }
    frontier = next;
    if (next.length === 0) break;
  }
}

/**
 * Turn the reached-node accumulator into a ranked {@link AffectedTest} list:
 * classify every reached node, keep the tests, then sort by the stable total
 * order (evidence: trace before static → depth asc → weight desc → id asc) and
 * apply `traceOnly` + `limit`. Shared by the symbol and file entry points so
 * ranking is defined in exactly one place.
 */
function rankReached(
  db: Db,
  reach: Map<string, NodeReach>,
  patterns: readonly string[] | undefined,
  traceOnly: boolean | undefined,
  limit: number | undefined,
  preciseMode: boolean,
  staticReach: ReadonlySet<string>,
): AffectedTest[] {
  const tests: AffectedTest[] = [];
  for (const [id, r] of reach) {
    const node = db.getNode(id);
    if (!node) continue;
    const candidate: TestCandidate = {
      id: node.id,
      name: node.name,
      file: node.file,
      language: node.language,
      kind: node.kind, // a module node runs as its FILE, not `file::<module-name>`
    };
    const handle = patterns !== undefined
      ? classifyTest(candidate, patterns)
      : classifyTest(candidate);
    if (handle === null) continue; // not a test — drop it from the run list

    const evidence: TestEvidence = r.viaTrace ? "trace" : "static";
    // staticReachable is keyed on the REACHED node id `id`; the handle id can be a
    // pytest node id (`file::name`) which differs, so look up the original.
    const staticReachable = staticReach.has(id);
    // dispatchOnly = observed via runtime dispatch AND static analysis alone would
    // NOT have found it. The differentiated, easy-to-miss value.
    const dispatchOnly = evidence === "trace" && !staticReachable;
    tests.push({
      id: handle.id,
      file: handle.file,
      evidence,
      confidence: r.observed ? "observed" : "reachable",
      depth: r.depth,
      // Rank weight: the trace weight when trace reached it, else the static one.
      weight: r.viaTrace ? r.traceWeight : r.staticWeight,
      runnable: handle.runnable,
      runner: handle.runner,
      staticReachable,
      dispatchOnly,
    });
  }

  // Stable total order. dispatchOnly FIRST (the differentiated, grep/static-would-
  // miss value), THEN the prior order: OBSERVED (per-test ground truth) first, then
  // trace before static, then closest (lowest depth), then heaviest, then id for
  // determinism. dispatchOnly-first means a truncating `--limit` keeps the
  // differentiated set at the head of the run list.
  tests.sort((a, b) => {
    const ad = a.dispatchOnly ? 0 : 1;
    const bd = b.dispatchOnly ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const ao = a.confidence === "observed" ? 0 : 1;
    const bo = b.confidence === "observed" ? 0 : 1;
    if (ao !== bo) return ao - bo;
    if (a.evidence !== b.evidence) return a.evidence === "trace" ? -1 : 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.weight !== b.weight) return b.weight - a.weight;
    return a.id.localeCompare(b.id);
  });

  // `--trace-only` narrows to the highest-confidence trace-backed tier: the
  // `observed` per-test set in precise mode (precision ~1.0, the minimal "I KNOW
  // this runs the change" set), or evidence-`trace` on the fallback path (no
  // per-test coverage to observe). Default keeps both tiers (recall safety).
  const filtered = traceOnly
    ? tests.filter((t) => (preciseMode ? t.confidence === "observed" : t.evidence === "trace"))
    : tests;
  if (limit !== undefined && limit >= 0 && filtered.length > limit) {
    return filtered.slice(0, limit);
  }
  return filtered;
}

/**
 * The cold/degrade note for a result. A zero trace-edge count means the walk was
 * static-only and may UNDER-report (the whole point of the feature is the trace
 * signal). When `traceOnly` is combined with a cold cache the same note applies —
 * the filter then keeps nothing, so the caller should know WHY.
 */
function noteFor(traceEdgeCount: number): string | undefined {
  return traceEdgeCount === 0 ? COLD_TRACE_NOTE : undefined;
}

/** The precise-path note: the trace evidence is per-test ground truth, not a
 *  transitive graph estimate — surfaced so a caller can distinguish the precise
 *  result from the (potentially over/under-reporting) fallback. */
const PRECISE_NOTE = "precise (per-test coverage)";

/** The safety-fallback note: the minimal (traceOnly) tier found NO observed
 *  coverage for the change, so it returned the reachable safety set instead of an
 *  empty selection — surfaced so a caller knows this symbol wasn't precisely
 *  covered (the "no camera on this shelf → run the safe set for it" case). */
const REACHABLE_FALLBACK_NOTE =
  "precise (per-test coverage); no observed coverage for the change — fell back to the reachable safety set (a minimal selector must never return zero tests for a change)";

/**
 * Apply the {@link AffectedTestsOpts.fallbackReachableWhenEmpty} safety net to a
 * computed precise result. When the caller asked for the minimal `traceOnly` tier
 * AND opted into the fallback AND that tier came back EMPTY, recompute WITHOUT
 * `traceOnly` (which, since the observed set was empty, yields exactly the
 * `reachable` safety set) and return it with the fallback note. A genuinely empty
 * reachable set (nothing reaches the change at all) is returned unchanged — there
 * is nothing safe to fall back to. Pure: recomputes from the same `reach` map.
 */
function applyReachableFallback(
  db: Db,
  reach: Map<string, NodeReach>,
  opts: AffectedTestsOpts,
  observedTests: AffectedTest[],
  staticReach: ReadonlySet<string>,
): { tests: AffectedTest[]; fellBack: boolean } {
  if (!opts.traceOnly || !opts.fallbackReachableWhenEmpty || observedTests.length > 0) {
    return { tests: observedTests, fellBack: false };
  }
  const reachable = rankReached(db, reach, opts.patterns, false, opts.limit, true, staticReach);
  return reachable.length > 0
    ? { tests: reachable, fellBack: true }
    : { tests: observedTests, fellBack: false };
}

/* ============================ PRECISE PATH ============================
 *
 * Engaged when `db.testCoverageCount() > 0` (at least one per-test coverage row
 * exists). The over-reporting we measured (precision 0.01–0.54,
 * bench/affected-tests-RESULTS.md) comes from the GLOBAL transitive trace walk:
 * per-test paths collapse through shared hubs. The fix is to STOP using that
 * walk for trace evidence and instead read PRECISE per-test coverage — each
 * test's OWN observed execution — from `db/test_coverage.ts`.
 *
 * The fusion mirrors the fallback EXACTLY in spirit, just with a different trace
 * source:
 *   - TRACE evidence for symbol S = `testsCovering(db, S)` (direct ground truth,
 *     `depth:1` — coverage is not a graph distance — weight = coverage weight).
 *   - STATIC evidence = the SAME reverse-walk over `db.incoming` (static∪import),
 *     run with an EMPTY trace adjacency so NO global trace edge leaks in.
 *   - Fusion = the shared `reach` accumulator + `rankReached`: a test reached both
 *     ways keeps `trace` (the coverage row OR-promotes it), trace ranks before
 *     static, depth asc, weight desc, id asc — identical to today.
 */

/**
 * Inject the PRECISE per-test coverage for `entityId` into the shared `reach`
 * accumulator as TRACE evidence. Each covering test becomes a direct
 * (`depth:1`) trace reach with its coverage weight — OR-promoting any test the
 * static walk already discovered to `trace`, exactly like a global trace edge
 * would in the fallback's {@link reverseWalk}.
 *
 * `roots` are the changed symbols themselves: a test "covering" a root is the
 * thing we want, but a root is never a dependent of itself, so we skip a covering
 * id that IS a root (symmetry with `reverseWalk`'s root exclusion).
 */
function injectCoverage(
  entityId: string,
  index: TestCoverageIndex,
  reach: Map<string, NodeReach>,
  roots: ReadonlySet<string>,
): void {
  for (const { testId, weight } of index.byEntity.get(entityId) ?? []) {
    if (roots.has(testId)) continue; // a root is not a dependent of itself
    const prev = reach.get(testId);
    if (prev === undefined) {
      reach.set(testId, {
        depth: 1, // coverage is direct ground truth, not a graph hop distance
        viaTrace: true,
        traceWeight: weight,
        staticWeight: 0,
        observed: true, // per-test coverage proved this test ran the change
      });
    } else {
      // Already reached (statically, transitively, or by another root's coverage):
      // OR-promote to trace + OBSERVED, keep the heaviest coverage weight, and
      // pull depth to 1 (direct). `observed` upgrades a reachable test to the
      // high-precision tier.
      prev.viaTrace = true;
      prev.observed = true;
      if (weight > prev.traceWeight) prev.traceWeight = weight;
      if (prev.depth > 1) prev.depth = 1;
    }
  }
}

/* ====================== SAFE-TIER CLASS ROLLUP ======================
 *
 * The INTRINSIC bug-only-edge miss (bench/affected-tests-RESULTS.md): a changed
 * leaf method (`CliRunner.visible_input`) has its OWN per-test coverage, but the
 * regression test (`test_pipeline`) exercises the class through OTHER methods
 * (`CliRunner.invoke`) and NEVER calls the changed leaf in clean code — so there
 * is no test→symbol coverage edge AND no static call edge. Both tiers miss it.
 *
 * The rollup widens the `reachable` (SAFE) tier ONLY: a method change pulls in
 * every test whose coverage hit ANY method of the SAME enclosing class. It NEVER
 * touches the `observed` tier (those stay byte-identical), so `--trace-only` is
 * unchanged. The cost is honest and quantified: a hub class (CliRunner) connects
 * its whole test population, so the SAFE cut drops on hub-class methods — the
 * correct price of never silently dropping a regression-catcher.
 */

/**
 * The enclosing class of a method node, recovered from its `qualified_name` tail.
 * `CliRunner.visible_input` → `CliRunner`; a bare `foo` (top-level function) →
 * null. We take the LAST head segment so a namespaced `pkg.CliRunner.method`
 * still yields `CliRunner`, and require the head segment to look like a class
 * (PascalCase) so a function-qualified nested name (`helper.inner`) is NOT
 * mistaken for a class — mirroring the discipline in test_nodes.ts.
 */
function enclosingClassOf(qualifiedName: string): string | null {
  const dot = qualifiedName.lastIndexOf(".");
  if (dot <= 0) return null;
  const head = qualifiedName.slice(0, dot);
  const cls = head.includes(".") ? head.slice(head.lastIndexOf(".") + 1) : head;
  // A class qualifier is PascalCase (`CliRunner`); a lowercase head is a function
  // scope (a nested `<locals>`-style qualname), not a class — don't roll those up.
  return /^[A-Z]/.test(cls) ? cls : null;
}

/**
 * Sibling METHOD node ids of `root`'s enclosing class: every node in the SAME
 * file whose `qualified_name` is `<Class>.<member>` (a direct method of the
 * class), EXCLUDING `root` itself. Returns [] when `root` is not a class method
 * (no recoverable class), so a non-method change rolls up nothing.
 *
 * Same-file scoping keeps this deterministic and bounded (one indexed `file`
 * lookup) and avoids cross-file collisions when two files define a same-named
 * class. PURE: a single read, no Db mutation.
 */
function classSiblings(db: Db, root: string): string[] {
  const node = db.getNode(root);
  if (!node || node.file === null) return [];
  const cls = enclosingClassOf(node.qualified_name);
  if (cls === null) return [];

  const rows = db.handle
    .query<{ id: string; qualified_name: string }, [string]>(
      "SELECT id, qualified_name FROM nodes WHERE file = ?",
    )
    .all(node.file);
  const out: string[] = [];
  const prefix = cls + ".";
  for (const r of rows) {
    if (r.id === root) continue; // a method is not its own sibling
    // A direct member of the class: `<Class>.<member>` whose LAST head segment is
    // the class. Reuse enclosingClassOf so `pkg.Cls.m` and `Cls.m` both match.
    if (r.qualified_name.startsWith(prefix) && enclosingClassOf(r.qualified_name) === cls) {
      out.push(r.id);
    }
  }
  return out;
}

/**
 * Inject the SAFE-tier class rollup for `root` into `reach`: union the per-test
 * coverage of every sibling method of `root`'s enclosing class as `reachable`
 * evidence (viaTrace for ranking, but `observed:false` ALWAYS). A test already
 * present keeps whatever it had — we NEVER downgrade an `observed` test, and we
 * NEVER set `observed:true` here (that would corrupt the high-precision tier).
 *
 * Mirrors injectCoverage's accumulator discipline, but is strictly ADDITIVE to
 * the reachable tier: a brand-new test enters as a `depth:1` trace reach with
 * `observed:false`; an already-reached test only has its trace weight bumped.
 */
function injectClassRollup(
  root: string,
  db: Db,
  index: TestCoverageIndex,
  reach: Map<string, NodeReach>,
  roots: ReadonlySet<string>,
): void {
  for (const siblingId of classSiblings(db, root)) {
    if (roots.has(siblingId)) continue; // a changed root is handled by injectCoverage
    for (const { testId, weight } of index.byEntity.get(siblingId) ?? []) {
      if (roots.has(testId)) continue; // a root is not a dependent of itself
      const prev = reach.get(testId);
      if (prev === undefined) {
        reach.set(testId, {
          depth: 1,
          viaTrace: true,
          traceWeight: weight,
          staticWeight: 0,
          observed: false, // ROLLUP IS REACHABLE-ONLY — never the observed tier
        });
      } else {
        // Already reached: keep its evidence/observed flag (NEVER promote to
        // observed), just OR-promote to trace + keep the heaviest weight so the
        // rolled-up signal can lift its rank within the reachable tier.
        prev.viaTrace = true;
        if (weight > prev.traceWeight) prev.traceWeight = weight;
      }
    }
  }
}

/**
 * The set of node ids a STATIC-ONLY reverse walk reaches from `roots` — the
 * `db.incoming` (call/import) reverse walk run with NO trace edges, i.e. exactly
 * what a static reverse-search (grep of callers / `impactOf`) would find. We
 * REUSE {@link reverseWalk} with an EMPTY trace adjacency (the same machinery the
 * precise path already runs with the real trace map), seeded from every root and
 * unioned, then take its key set. This is the `staticReachable` oracle: a test in
 * this set is reachable by static analysis alone; a test reached via trace but
 * ABSENT here is `dispatchOnly`.
 *
 * Cheap: one BFS per root over the same `db.incoming` edges the affected walk
 * already touches, no trace-edge resolution. Run ONCE per query.
 */
function staticReachableSet(
  db: Db,
  roots: Iterable<string>,
  cap: number,
): Set<string> {
  const emptyTraceIn = new Map<string, Array<{ src: string; weight: number }>>();
  const staticReach = new Map<string, NodeReach>();
  for (const root of roots) {
    reverseWalk(db, root, emptyTraceIn, cap, staticReach);
  }
  return new Set(staticReach.keys());
}

/** Clamp `maxDepth` to the same bounds impactOf uses: ≥1 and ≤ MAX_IMPACT_DEPTH. */
function depthCap(maxDepth: number | undefined): number {
  return Math.min(
    MAX_IMPACT_DEPTH,
    Math.max(1, Math.trunc(maxDepth ?? MAX_IMPACT_DEPTH)),
  );
}

/**
 * Affected tests for a single changed `symbol`.
 *
 * Two paths, chosen by whether PRECISE per-test coverage exists
 * (`db.testCoverageCount() > 0`):
 *
 *   - PRECISE (coverage present): trace evidence = `testsCovering(symbol)` (each
 *     test's OWN observed execution, `depth:1`); static evidence = the reverse
 *     walk over `db.incoming` with NO global trace edges; fused + ranked as
 *     today. `precise:true`, no cold note (a precise note instead). This is the
 *     fix for the global-walk over-reporting (bench/affected-tests-RESULTS.md).
 *   - FALLBACK (no coverage): UNCHANGED — the global `resolvedTraceEdges`
 *     two-colour static∪trace BFS, with the cold note when traces are absent.
 *     Backward-compatible: indexes/tests that only seed `observations` (never
 *     `insertTestCoverage`) take this path and behave exactly as before.
 *
 * Both paths first resolve `symbol` ({@link resolveNodeId}: exact, else top-FTS);
 * an unresolvable symbol returns an empty result with `"symbol not found"`.
 */
export function affectedTests(
  db: Db,
  symbol: string,
  opts: AffectedTestsOpts = {},
): AffectedTestsResult {
  const resolved = resolveNodeId(db, symbol);

  if (db.testCoverageCount() > 0) {
    // ---- PRECISE PATH (TIERED) ----
    if (resolved === null) {
      return {
        roots: [],
        tests: [],
        traceEdgeCount: 0,
        precise: true,
        note: "symbol not found",
        dispatchOnlyCount: 0,
        hub: false,
        blastRadiusFraction: 0,
      };
    }
    const index = buildTestCoverageIndex(db);
    // The reverse walk uses the REAL trace adjacency so its reach is the recall
    // SAFETY NET (static ∪ global transitive trace). Those tests are tagged
    // `reachable`. injectCoverage then UPGRADES the per-test-covered ones to the
    // high-precision `observed` tier. Default returns both (recall preserved);
    // `--trace-only` keeps only `observed` (precision ~1.0).
    const { traceIn, traceEdgeCount } = buildTraceIn(db);
    const cap = depthCap(opts.maxDepth);
    const reach = new Map<string, NodeReach>();
    const roots = new Set<string>([resolved.id]);
    reverseWalk(db, resolved.id, traceIn, cap, reach);
    injectCoverage(resolved.id, index, reach, roots);
    // SAFE-tier class rollup (opt-in): after injectCoverage tagged the observed
    // tests, widen the REACHABLE tier with sibling-class coverage. It only ever
    // ADDS reachable tests / OR-promotes ranking — it can never change an
    // observed test, so the `observed`/`--trace-only` result is byte-identical.
    if (opts.classRollup) injectClassRollup(resolved.id, db, index, reach, roots);

    // STATIC-ONLY reachable oracle (no trace edges): drives per-test
    // `staticReachable`/`dispatchOnly`. Same `db.incoming` machinery, empty trace.
    const staticReach = staticReachableSet(db, roots, cap);
    const observed = rankReached(db, reach, opts.patterns, opts.traceOnly, opts.limit, true, staticReach);
    const { tests, fellBack } = applyReachableFallback(db, reach, opts, observed, staticReach);
    // Hub blast-radius from the FULL pre-limit set the function RETURNS — derived
    // the SAME way `tests` is (observed rank THEN the reachable fallback), just
    // without the `limit`, so a `--limit` can't mask a hub. Re-running the whole
    // pipeline (not just `rankReached`) is what keeps the fallback case honest: on
    // a fell-back result the observed/traceOnly tier is empty, so a bare re-rank
    // would come back empty and report hub=false even though the RETURNED tests are
    // a non-empty reachable set.
    let fullForHub = tests;
    if (opts.limit !== undefined) {
      const optsNoLimit: AffectedTestsOpts = { ...opts, limit: undefined };
      const observedFull = rankReached(db, reach, opts.patterns, opts.traceOnly, undefined, true, staticReach);
      fullForHub = applyReachableFallback(db, reach, optsNoLimit, observedFull, staticReach).tests;
    }
    const { hub, blastRadiusFraction } = hubMetrics(db, fullForHub.length, opts.patterns);
    return {
      roots: [resolved.id],
      tests,
      traceEdgeCount,
      precise: true,
      note: fellBack ? REACHABLE_FALLBACK_NOTE : PRECISE_NOTE,
      dispatchOnlyCount: tests.filter((t) => t.dispatchOnly).length,
      hub,
      blastRadiusFraction,
    };
  }

  // ---- FALLBACK PATH (unchanged) ----
  const { traceIn, traceEdgeCount } = buildTraceIn(db);

  if (resolved === null) {
    return {
      roots: [],
      tests: [],
      traceEdgeCount,
      note: "symbol not found",
      dispatchOnlyCount: 0,
      hub: false,
      blastRadiusFraction: 0,
    };
  }

  const cap = depthCap(opts.maxDepth);
  const reach = new Map<string, NodeReach>();
  reverseWalk(db, resolved.id, traceIn, cap, reach);

  const staticReach = staticReachableSet(db, [resolved.id], cap);
  const tests = rankReached(db, reach, opts.patterns, opts.traceOnly, opts.limit, false, staticReach);
  const fullForHub = opts.limit === undefined
    ? tests
    : rankReached(db, reach, opts.patterns, opts.traceOnly, undefined, false, staticReach);
  const { hub, blastRadiusFraction } = hubMetrics(db, fullForHub.length, opts.patterns);
  return {
    roots: [resolved.id],
    tests,
    traceEdgeCount,
    note: noteFor(traceEdgeCount),
    dispatchOnlyCount: tests.filter((t) => t.dispatchOnly).length,
    hub,
    blastRadiusFraction,
  };
}

/**
 * Affected tests for a set of changed `files`. For each file we seed the walk
 * from EVERY entity node defined in that file, run the same reverse BFS, and
 * UNION the reached sets into one shared accumulator — so a test keeps its
 * STRONGEST evidence (trace if any file's walk reached it via trace) and its MIN
 * depth across files. `traceIn` is built ONCE and reused across every file/seed.
 *
 * `roots` is the union of resolved seed node ids (the entities defined in the
 * changed files). Ranking + `traceOnly` + `limit` run ONCE at the end.
 */
export function affectedTestsForFiles(
  db: Db,
  files: string[],
  opts: AffectedTestsOpts = {},
): AffectedTestsResult {
  const precise = db.testCoverageCount() > 0;
  // BOTH paths use the REAL trace adjacency for the reverse walk (the recall
  // safety net). In PRECISE mode the per-test coverage index then UPGRADES the
  // covered tests to the `observed` tier (below); in FALLBACK there is no
  // coverage so every reached test stays `reachable`, exactly as before.
  const coverageIndex = precise ? buildTestCoverageIndex(db) : null;
  const { traceIn, traceEdgeCount } = buildTraceIn(db);

  const cap = depthCap(opts.maxDepth);
  const reach = new Map<string, NodeReach>();
  const roots: string[] = [];
  const seenRoot = new Set<string>();

  for (const file of files) {
    const rows = db.handle
      .query<{ id: string }, [string]>("SELECT id FROM nodes WHERE file = ?")
      .all(file);
    for (const { id } of rows) {
      if (!seenRoot.has(id)) {
        seenRoot.add(id);
        roots.push(id);
      }
      reverseWalk(db, id, traceIn, cap, reach);
    }
  }

  // PRECISE: union the per-test coverage of EVERY seed entity into the reach set
  // as trace evidence (after the static walks, so coverage OR-promotes them). Run
  // over the final root set so a covering id that is itself a root is excluded.
  if (coverageIndex) {
    for (const id of seenRoot) injectCoverage(id, coverageIndex, reach, seenRoot);
    // SAFE-tier class rollup (opt-in), after coverage so it never downgrades an
    // observed test. Reachable-tier only; the observed/--trace-only result is
    // byte-identical with it off.
    if (opts.classRollup) {
      for (const id of seenRoot) injectClassRollup(id, db, coverageIndex, reach, seenRoot);
    }
  }

  // Defend the union: a seed node that is ALSO defined in another changed file
  // could have been added to `reach` as a neighbor of a different root; drop any
  // root from the reached set before ranking (a root is the thing changed, not
  // an affected dependent of itself).
  for (const id of seenRoot) reach.delete(id);

  // Deterministic root order, independent of file-iteration order.
  roots.sort((a, b) => a.localeCompare(b));

  // STATIC-ONLY reachable oracle across the UNION of all seed roots (no trace
  // edges): drives per-test `staticReachable`/`dispatchOnly`. A test reached via
  // trace from ANY changed file but not statically from ANY of them is dispatchOnly.
  const staticReach = staticReachableSet(db, seenRoot, cap);

  // Rank WITHOUT the limit first; the limit is applied once at the very end so a
  // per-root fallback (below) can't be truncated away before it's even added.
  const ranked = rankReached(db, reach, opts.patterns, opts.traceOnly, undefined, precise, staticReach);
  let tests = ranked;
  let fellBack = false;

  // PER-ROOT reachable fallback (the multi-root safety net). A single global
  // "is the observed set empty?" check would MASK an uncovered changed symbol
  // whenever ANY OTHER changed symbol happens to be covered — silently dropping
  // the uncovered one's tests on the common multi-file `--changed` path. So we
  // fall back PER ROOT: for every changed root that has NO per-test coverage, walk
  // ITS reachable set and union those tests in (deduped by id). Mirrors the
  // single-symbol guarantee — a minimal selector never returns zero tests for a
  // changed symbol — at file granularity. Only on the precise + traceOnly path.
  if (precise && opts.traceOnly && opts.fallbackReachableWhenEmpty && coverageIndex) {
    const uncovered = roots.filter((r) => (coverageIndex.byEntity.get(r)?.length ?? 0) === 0);
    if (uncovered.length > 0) {
      const byId = new Map<string, AffectedTest>(ranked.map((t) => [t.id, t]));
      for (const r of uncovered) {
        const rr = new Map<string, NodeReach>();
        reverseWalk(db, r, traceIn, cap, rr);
        for (const id of seenRoot) rr.delete(id); // a root is not its own dependent
        for (const t of rankReached(db, rr, opts.patterns, false, undefined, precise, staticReach)) {
          if (!byId.has(t.id)) {
            byId.set(t.id, t);
            fellBack = true;
          }
        }
      }
      if (fellBack) tests = [...byId.values()];
    }
  }

  // Hub blast-radius from the FULL set (pre-limit), so a `--limit` can't mask it.
  const { hub, blastRadiusFraction } = hubMetrics(db, tests.length, opts.patterns);

  if (opts.limit !== undefined && opts.limit >= 0 && tests.length > opts.limit) {
    tests = tests.slice(0, opts.limit);
  }
  return {
    roots,
    tests,
    traceEdgeCount,
    ...(precise ? { precise: true } : {}),
    note: precise ? (fellBack ? REACHABLE_FALLBACK_NOTE : PRECISE_NOTE) : noteFor(traceEdgeCount),
    dispatchOnlyCount: tests.filter((t) => t.dispatchOnly).length,
    hub,
    blastRadiusFraction,
  };
}
