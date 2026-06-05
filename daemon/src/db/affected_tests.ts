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
}

/** Options for {@link affectedTests} / {@link affectedTestsForFiles}. */
export interface AffectedTestsOpts {
  /** Reverse-walk depth cap. Default = MAX_IMPACT_DEPTH from graph_walk.ts (64). */
  maxDepth?: number;
  /** --trace-only: keep ONLY evidence:"trace" tests. */
  traceOnly?: boolean;
  /** Cap the returned test count (after ranking). */
  limit?: number;
  /** Config `test.patterns` (path patterns) forwarded to test detection. */
  patterns?: readonly string[];
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
    };
    const handle = patterns !== undefined
      ? classifyTest(candidate, patterns)
      : classifyTest(candidate);
    if (handle === null) continue; // not a test — drop it from the run list

    const evidence: TestEvidence = r.viaTrace ? "trace" : "static";
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
    });
  }

  // Stable total order: OBSERVED (per-test ground truth) first, then trace before
  // static, then closest (lowest depth), then heaviest, then id for determinism.
  // Observed-first means `--order`/a truncating `--limit` keep the high-precision
  // set at the head of the run list.
  tests.sort((a, b) => {
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
      return { roots: [], tests: [], traceEdgeCount: 0, precise: true, note: "symbol not found" };
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

    const tests = rankReached(db, reach, opts.patterns, opts.traceOnly, opts.limit, true);
    return { roots: [resolved.id], tests, traceEdgeCount, precise: true, note: PRECISE_NOTE };
  }

  // ---- FALLBACK PATH (unchanged) ----
  const { traceIn, traceEdgeCount } = buildTraceIn(db);

  if (resolved === null) {
    return { roots: [], tests: [], traceEdgeCount, note: "symbol not found" };
  }

  const cap = depthCap(opts.maxDepth);
  const reach = new Map<string, NodeReach>();
  reverseWalk(db, resolved.id, traceIn, cap, reach);

  const tests = rankReached(db, reach, opts.patterns, opts.traceOnly, opts.limit, false);
  return { roots: [resolved.id], tests, traceEdgeCount, note: noteFor(traceEdgeCount) };
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
  }

  // Defend the union: a seed node that is ALSO defined in another changed file
  // could have been added to `reach` as a neighbor of a different root; drop any
  // root from the reached set before ranking (a root is the thing changed, not
  // an affected dependent of itself).
  for (const id of seenRoot) reach.delete(id);

  // Deterministic root order, independent of file-iteration order.
  roots.sort((a, b) => a.localeCompare(b));

  const tests = rankReached(db, reach, opts.patterns, opts.traceOnly, opts.limit, precise);
  return {
    roots,
    tests,
    traceEdgeCount,
    ...(precise ? { precise: true } : {}),
    note: precise ? PRECISE_NOTE : noteFor(traceEdgeCount),
  };
}
