/**
 * FAIL-FAST test-case prioritization (APFD) for `hayven affected-tests`.
 *
 * THE PROBLEM. `affected-tests` answers "which tests should run for this
 * change?" — but the SET says nothing about ORDER. Run that set in arbitrary
 * (or alphabetical) order and a fleet of agents/CI may burn minutes of compute
 * on green tests before hitting the one red test that actually proves the change
 * broke something. The whole value of a small affected-set is fast feedback;
 * squandering it on bad ordering defeats the point.
 *
 * THE OBJECTIVE — APFD (Average Percentage of Faults Detected, Rothermel et
 * al.). Given an ordering and the faults a change actually introduces, APFD
 * measures how EARLY the ordering surfaces those faults: 1.0 = first test is
 * red, ~0 = you only find out at the very end. Maximizing APFD == minimizing
 * wasted compute before the first failure. This module produces an ordering that
 * BEATS naive order on APFD, and exposes {@link apfd} so tests + a measurement
 * harness can PROVE it (not just assert it).
 *
 * WHY A TRANSPARENT WEIGHTED SUM (not a model). The signals here are few,
 * cheap, and individually defensible; a black-box ranker would be unauditable
 * and non-deterministic. We rank by a documented composite score whose every
 * term has a stated rationale and a NAMED weight constant, so a reviewer can see
 * exactly why test A precedes test B — and the ordering is fully deterministic
 * (ties broken by id), which matters because a flaky order is itself a bug
 * (agents distrust a tool whose output churns run-to-run).
 *
 * PURITY. The function takes plain input data (mirroring, but NOT importing, the
 * shape `affected-tests` emits — keeping this module dependency-free so it can be
 * unit-tested and fed from anywhere) and an injected `now` (so recency scoring is
 * deterministic instead of reading the wall clock). It NEVER mutates its input.
 *
 * THE RANKING, in priority order:
 *   1. EVIDENCE is the TOP-LEVEL PARTITION. A "trace" test was OBSERVED
 *      executing the changed code (ground truth from the runtime collectors); a
 *      "static" test is only PREDICTED to via the graph. Trace tests are far
 *      likelier to actually exercise the change, so EVERY trace test precedes
 *      EVERY static test — regardless of the other signals. (We partition rather
 *      than fold evidence into the score with a huge constant: a partition is
 *      unambiguous and immune to a pathological score blowing past the constant.)
 *   2. Within each partition, sort by the COMPOSITE SCORE (desc) — recency +
 *      proximity + intensity, see {@link scoreOf}.
 *   3. Cheapness tiebreak: among near-equal scores, the CHEAPER test (lower
 *      `lastDurationMs`) runs first — faster feedback, better APFD-per-second.
 *   4. Final tiebreak: `id` ascending, so the output is STABLE + deterministic.
 */

/**
 * A test to be ordered. Mirrors the shape `affected-tests` emits, but kept
 * local + minimal so this module has NO dependency on other lanes' modules
 * (`affected_tests.ts` / `test_coverage.ts`). The integrator maps that output
 * onto this plain shape before calling {@link prioritize}.
 */
export interface PrioritizableTest {
  id: string;
  /**
   * "trace" = the test was OBSERVED executing the changed code (ground truth
   * from the runtime trace collectors); "static" = predicted via the graph.
   * Trace tests are likelier to actually exercise the change → they go first.
   */
  evidence: "trace" | "static";
  /**
   * Reverse-walk distance from the change (1 = direct caller of the changed
   * code). Closer → likelier to exercise the change → earlier.
   */
  depth: number;
  /**
   * Coverage/edge weight — how heavily this test exercises the changed code.
   * Heavier → earlier (more of the change runs sooner → faults surface sooner).
   */
  weight: number;
  /**
   * OPTIONAL signals (undefined when unknown — the scorer DEGRADES GRACEFULLY,
   * never punishing a missing signal):
   *   - lastFailedAt: wall-clock ms this test last failed. Recently-failed tests
   *     are historically the single best early fault indicator (a test that just
   *     broke is the likeliest to break again) → boost them.
   *   - lastDurationMs: typical runtime in ms; among otherwise-equal tests, run
   *     the CHEAPER one first (faster feedback, better APFD per second).
   */
  lastFailedAt?: number;
  lastDurationMs?: number;
}

/** Tuning knobs for {@link prioritize}. Injected so the function stays pure. */
export interface PrioritizeOpts {
  /**
   * "now" in ms for recency scoring (callers pass `Date.now()`). Injected so the
   * function is pure + deterministically testable. When absent, the recency term
   * is simply 0 (we never invent a clock) — the other signals still rank.
   */
  now?: number;
  /**
   * Half-life (ms) for the recently-failed boost's exponential decay. At one
   * half-life since the failure the boost is 0.5; at two, 0.25; etc. Default
   * ~7 days — recent enough to favor this week's regressions, long enough that a
   * failure from last sprint still counts for something.
   */
  failureHalfLifeMs?: number;
}

/** A {@link PrioritizableTest} annotated with the score it was ranked by. */
export interface PrioritizedTest extends PrioritizableTest {
  /**
   * The composite score this test was ranked by WITHIN its evidence partition
   * (higher = earlier). Exposed for transparency + tests; it does NOT encode the
   * evidence partition (that's applied as a hard pre-sort), so a static test may
   * carry a higher score than a trace test yet still sort AFTER it.
   */
  score: number;
}

/**
 * Default failure-recency half-life: ~7 days in ms. A test that failed within
 * the last week is treated as a strong early-fault signal; older failures decay
 * smoothly toward 0 rather than cutting off at a cliff.
 */
const DEFAULT_FAILURE_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * RELATIVE WEIGHTS of the three composite-score terms (all in the same [0,1]-ish
 * range so the weights ARE the relative importance). Tuned, not sacred — but
 * documented so a reviewer sees the intended priority:
 *   recency > proximity > intensity.
 *
 * WHY this order:
 *   - RECENCY dominates because a just-failed test is the empirically strongest
 *     predictor of the NEXT failure (regression clustering) — when we know a
 *     test failed yesterday, that outranks any structural guess.
 *   - PROXIMITY next: a direct (depth-1) caller of the change is more likely to
 *     exercise it than a distant transitive one.
 *   - INTENSITY last: heavier coverage helps, but a test can heavily exercise
 *     UNCHANGED parts of the touched symbol, so it's the weakest of the three.
 */
const W_RECENCY = 1.0;
const W_PROXIMITY = 0.6;
const W_INTENSITY = 0.4;

/**
 * Saturation constant for the intensity term `weight / (weight + K)`. This maps
 * an UNBOUNDED, non-comparable raw coverage weight into [0,1) with diminishing
 * returns: at `weight == K` the term is 0.5, and it asymptotes toward 1 — so a
 * test with 100× the weight of another doesn't get a 100× score and steamroll
 * every other signal. K≈4 means "a handful of edges already counts as solid
 * coverage"; tune if the weight distribution shifts.
 */
const INTENSITY_SATURATION_K = 4;

/**
 * Two scores are "effectively equal" (→ fall through to the cheapness tiebreak)
 * when they differ by less than this. Floating-point sums of the weighted terms
 * won't land on exact equality even for logically-tied tests, so a small epsilon
 * is what lets the cheaper-duration tiebreak actually fire instead of being
 * masked by sub-ULP score noise.
 */
const SCORE_EPSILON = 1e-9;

/**
 * Fallback duration when EVERY test has an unknown duration (so there's no mean
 * to compute). 0 vs 0 ties cleanly → the id tiebreak decides, which is the right
 * behavior when the cheapness signal is entirely absent.
 */
const NO_KNOWN_DURATION_FALLBACK = 0;

/** Evidence partition rank — LOWER sorts EARLIER. Trace strictly before static. */
function evidenceRank(e: PrioritizableTest["evidence"]): number {
  return e === "trace" ? 0 : 1;
}

/**
 * The recency boost in [0,1): `2^(-(now - lastFailedAt)/halfLife)`. A test that
 * failed exactly `now` → ~1.0; one half-life ago → 0.5; long ago → ~0. Returns 0
 * (no boost, never negative) when:
 *   - `now` was not injected (we don't invent a clock),
 *   - the test has no recorded `lastFailedAt`,
 *   - or `lastFailedAt` is in the FUTURE relative to `now` (clock skew / bad
 *     data) — clamped to 0 elapsed so the boost caps at 1.0 instead of blowing
 *     up past it.
 */
function recencyBoost(t: PrioritizableTest, now: number | undefined, halfLifeMs: number): number {
  if (now === undefined || t.lastFailedAt === undefined) return 0;
  // Clamp negative elapsed (future timestamp) to 0 → boost ≤ 1, never >1.
  const elapsed = Math.max(0, now - t.lastFailedAt);
  return Math.pow(2, -elapsed / halfLifeMs);
}

/**
 * Composite WITHIN-PARTITION score (higher = earlier). A transparent weighted
 * sum of three independently-defensible terms, each documented at its weight
 * constant ({@link W_RECENCY}/{@link W_PROXIMITY}/{@link W_INTENSITY}):
 *   - recency:   `recencyBoost` ∈ [0,1] — recently-failed → near +1.
 *   - proximity: `1/depth` ∈ (0,1]   — depth-1 (direct) → 1, distant → small.
 *   - intensity: `weight/(weight+K)` ∈ [0,1) — heavier coverage, saturating.
 *
 * NOTE: this score deliberately does NOT include the evidence signal; evidence
 * is a HARD partition applied in {@link prioritize}, not a score term, so it can
 * never be overridden by an extreme score. Defensive against bad input: a
 * non-positive/non-finite `depth` falls back to proximity 0 rather than dividing
 * by zero / producing Infinity (untrusted-input arithmetic — see DESIGN_LESSONS).
 */
function scoreOf(t: PrioritizableTest, now: number | undefined, halfLifeMs: number): number {
  const recency = recencyBoost(t, now, halfLifeMs);
  // Guard depth: 1/depth only makes sense for a positive, finite distance.
  const proximity = Number.isFinite(t.depth) && t.depth > 0 ? 1 / t.depth : 0;
  // Guard weight: a negative/non-finite weight contributes no intensity.
  const w = Number.isFinite(t.weight) && t.weight > 0 ? t.weight : 0;
  const intensity = w / (w + INTENSITY_SATURATION_K);
  return W_RECENCY * recency + W_PROXIMITY * proximity + W_INTENSITY * intensity;
}

/**
 * The mean of the KNOWN durations in `tests`, used as the stand-in for tests
 * whose `lastDurationMs` is undefined. Computing the real average (rather than a
 * fixed sentinel) is what makes "unknown sorts as AVERAGE" literally true: an
 * unknown-duration test lands between the known-faster and known-slower ones
 * instead of being front-run (sentinel 0) or buried (sentinel +Infinity). When
 * NO test has a known duration there's nothing to average → {@link
 * NO_KNOWN_DURATION_FALLBACK} (0), so unknowns tie and fall to the id tiebreak.
 */
function averageKnownDuration(tests: PrioritizableTest[]): number {
  let sum = 0;
  let count = 0;
  for (const t of tests) {
    if (t.lastDurationMs !== undefined && Number.isFinite(t.lastDurationMs)) {
      sum += t.lastDurationMs;
      count++;
    }
  }
  return count === 0 ? NO_KNOWN_DURATION_FALLBACK : sum / count;
}

/** The duration used by the cheapness tiebreak; unknown → the cohort average. */
function durationFor(t: PrioritizableTest, avgUnknown: number): number {
  return t.lastDurationMs === undefined || !Number.isFinite(t.lastDurationMs)
    ? avgUnknown
    : t.lastDurationMs;
}

/**
 * Order `tests` for EARLIEST fault detection (maximize APFD). PURE +
 * deterministic — does NOT mutate the input (it sorts a shallow copy) and yields
 * a stable order for identical input.
 *
 * The comparator, in strict priority order:
 *   1. EVIDENCE partition  — all `trace` before all `static` (hard, score-proof).
 *   2. COMPOSITE SCORE desc — recency + proximity + intensity ({@link scoreOf}).
 *   3. CHEAPER duration     — when scores are within {@link SCORE_EPSILON}
 *                             (unknown duration sorts as average, not worst).
 *   4. `id` ascending       — final deterministic tiebreak (stable output).
 *
 * Each returned test carries its within-partition `score` for transparency.
 */
export function prioritize(tests: PrioritizableTest[], opts?: PrioritizeOpts): PrioritizedTest[] {
  const now = opts?.now;
  const halfLifeMs =
    opts?.failureHalfLifeMs !== undefined && opts.failureHalfLifeMs > 0
      ? opts.failureHalfLifeMs
      : DEFAULT_FAILURE_HALF_LIFE_MS;

  // The cohort mean of known durations — the stand-in for unknown durations so
  // they sort as AVERAGE (computed once, not per-comparison).
  const avgUnknown = averageKnownDuration(tests);

  // Score once per test (avoid recomputing inside the comparator's O(n log n)
  // calls), carried alongside so the result can expose it.
  const scored: PrioritizedTest[] = tests.map((t) => ({
    ...t,
    score: scoreOf(t, now, halfLifeMs),
  }));

  // Sort a COPY (`scored` is already a fresh array from map → input untouched).
  scored.sort((a, b) => {
    // 1. Evidence partition: trace (rank 0) strictly before static (rank 1).
    const ev = evidenceRank(a.evidence) - evidenceRank(b.evidence);
    if (ev !== 0) return ev;

    // 2. Composite score, higher first. Only decisive when the gap exceeds the
    //    epsilon, so logically-tied tests fall through to the cheapness tiebreak.
    const ds = b.score - a.score;
    if (Math.abs(ds) > SCORE_EPSILON) return ds;

    // 3. Cheaper duration first (unknown sorts as average via the sentinel).
    //    Compare with `<`/`>` rather than subtraction: two unknown durations are
    //    both the +Infinity sentinel, and `Infinity - Infinity` is NaN — which a
    //    `return NaN` comparator silently corrupts the sort with. The relational
    //    form yields a clean 0 for the equal-sentinel case so we fall through to
    //    the id tiebreak instead.
    const da = durationFor(a, avgUnknown);
    const db_ = durationFor(b, avgUnknown);
    if (da < db_) return -1;
    if (da > db_) return 1;

    // 4. Stable, deterministic final tiebreak.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return scored;
}

/**
 * APFD — Average Percentage of Faults Detected — for an `ordering` against the
 * set of test ids that ACTUALLY fail (`failingIds`). The standard Rothermel
 * metric in [0,1]:
 *
 *   APFD = 1 - (TF1 + TF2 + … + TFm) / (n * m) + 1 / (2n)
 *
 * where:
 *   - n  = total number of tests in the ordering,
 *   - m  = number of faults (here: one "fault" per failing test id present in
 *          the ordering — each failing test detects its own fault),
 *   - TFi = the 1-BASED position in `ordering` of the i-th fault's
 *           earliest-detecting test.
 *
 * Intuition: faults found EARLY → small positions → large APFD (→ 1.0 when every
 * fault is caught by the very first test). Faults found late → APFD → ~0. This
 * is what we OPTIMIZE for and what the tests use to PROVE the prioritized order
 * beats a naive/reverse one.
 *
 * Edge cases (documented, defensive — never throw, never NaN):
 *   - empty ordering (n == 0) → 0 (nothing run, nothing detected).
 *   - no faults (m == 0)      → 1.0 (vacuously perfect: zero faults, all "found"
 *                              — and avoids dividing by m == 0).
 *   - a failing id NOT present in the ordering is IGNORED for m (it can't be
 *     "detected" by an ordering that never runs it), so m counts only faults the
 *     ordering can actually surface. This keeps APFD honest: you can't score a
 *     fault you never had the chance to find.
 */
export function apfd(ordering: string[], failingIds: Set<string>): number {
  const n = ordering.length;
  if (n === 0) return 0;

  // Sum the 1-based position of the FIRST occurrence of each failing id that the
  // ordering actually contains. A single pass: the first time we see a failing
  // id, record its position; ignore later occurrences (the EARLIEST detects it).
  let positionSum = 0;
  let m = 0;
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const id = ordering[i]!; // i < n, so this index is in-bounds.
    if (failingIds.has(id) && !seen.has(id)) {
      seen.add(id);
      positionSum += i + 1; // 1-based position.
      m++;
    }
  }

  // No detectable fault in this ordering → vacuously perfect (and no /0).
  if (m === 0) return 1;

  return 1 - positionSum / (n * m) + 1 / (2 * n);
}
