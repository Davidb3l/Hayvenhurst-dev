/**
 * `POST /api/traces/observations` — ingest a batch of runtime call edges.
 *
 * Wire format (per PRD §4.6 / §9 vertical-integration discipline):
 *
 * ```json
 * {
 *   "source": "python",
 *   "sample_rate": 100,
 *   "observations": [
 *     {"src": "...", "dst": "...", "ts": 1715789520, "observed": 5, "weight": 500}
 *   ]
 * }
 * ```
 *
 * `observed` is the raw sample count; `weight = observed * sample_rate` is
 * the scaled estimate. We carry both on the wire so the daemon can verify
 * the conversion and reject mismatched payloads (no hidden math). A small
 * ±1 rounding slack is allowed.
 *
 * Storage path (ARCHITECTURE.md §12 + §14): each observation becomes a
 * `GsetOp` appended to the on-disk op log and applied to the in-memory
 * G-Set via `deps.crdt.observe`. The SQL `observations` table is kept
 * populated as a denormalized read cache (cheap range queries, plus the
 * v0.0.1 `lastObservationTs` / `observationsCount` helpers still in use).
 *
 * Defense-in-depth for coverage POSTs (schema v6, additive). The Python
 * collector now sends runtime traces in BOUNDED batches (a single giant POST
 * was timing out and silently dropping ~half a large suite's `test_coverage`).
 * The collector-side batching is the PRIMARY mitigation; this route is the
 * daemon-side complement so a large/edge-case coverage chunk is never silently
 * dropped:
 *   1. A coverage-ONLY chunk (`observations: []`, non-empty `test_coverage`)
 *      still inserts its coverage — coverage is NOT gated on observations.
 *   2. A single malformed coverage row is SKIPPED, never rejecting the batch;
 *      we report `coverage_accepted` + `coverage_skipped`.
 *   3. A coverage INSERT failure (DB error) is caught and reported, never
 *      500-ing the request after observations have already committed.
 *
 * Body-size limit (task 3 — honest scope note): the only body-size cap is
 * Bun's `Bun.serve` `maxRequestBodySize` (default 128 MB). It is configured at
 * `app.listen(...)` in `daemon/src/cli/daemon.ts` (app-level), NOT in this
 * route — so this file CANNOT raise or lower it. We deliberately impose NO
 * additional per-request size cap here: the handler accepts whatever size
 * Bun/Elysia parses and hands us. With the collector now chunking into bounded
 * batches (Lane A), a multi-MB single POST should no longer occur, which makes
 * the 128 MB default moot in practice; if the app-level cap ever needs raising
 * it must be done at the `Bun.serve` config, not from this file.
 */
import { Elysia } from "elysia";

import type { ServerDependencies } from "../server.ts";
import type { ObservationRow, TestCoverageRow } from "../../db/queries.ts";
import { bucketize, type GsetOp } from "../../crdt/gset.ts";

const ROUNDING_SLACK = 1;
const UINT16_MAX = 0xffff;

interface RawObservation {
  src?: unknown;
  dst?: unknown;
  ts?: unknown;
  observed?: unknown;
  weight?: unknown;
}

interface RawTestCoverage {
  test?: unknown;
  entity?: unknown;
  weight?: unknown;
}

interface RawPayload {
  source?: unknown;
  sample_rate?: unknown;
  observations?: unknown;
  /** Phase 0.0.4 (optional, additive): per-test coverage rows. When the
   *  collector tracks the active test context it sends, alongside the GLOBAL
   *  `observations` graph, the precise (test, entity) pairs it observed each
   *  test execute. Absent on older collectors → only the global graph is stored. */
  test_coverage?: unknown;
}

export function tracesRoutes(deps: ServerDependencies) {
  return new Elysia().post("/api/traces/observations", ({ body, set }) => {
    const validation = validate(body);
    if (!validation.ok) {
      set.status = 400;
      return { error: validation.error };
    }
    const { source, sampleRate, rows, coverage, coverageSkipped } = validation;
    // Observations path. Note this loop and `insertObservations` are a no-op for
    // an EMPTY `observations: []` (a coverage-only surplus batch) — there is no
    // `if (rows.length === 0) return` early-out, so a coverage-only chunk falls
    // through to the coverage insert below. Observations and coverage are
    // INDEPENDENT: an empty observations array never short-circuits coverage.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const op: GsetOp = {
        kind: "observe",
        src: row.src,
        dst: row.dst,
        tsBucket: bucketize(row.ts),
        observed: row.observed,
        weight: row.weight,
        hlc: deps.crdt.tick(),
        writer: deps.crdt.writer,
      };
      deps.crdt.observe(op);
    }
    deps.db.insertObservations(rows);

    // Additive (schema v6): per-test coverage, when the collector sent it. The
    // global graph above is unchanged; this preserves the per-test attribution
    // that makes `affected-tests` precise (db/test_coverage.ts resolves it).
    //
    // Inserted INDEPENDENTLY of `rows.length` so a coverage-only batch lands
    // (task 1). The DB insert is wrapped (task 4): observations have ALREADY
    // committed at this point, so a coverage-insert DB error must NOT bubble out
    // and 500 the whole request — we log it and report `coverage_accepted: 0`
    // instead of crashing. Malformed individual rows were already skipped during
    // validation (task 2), surfaced here as `coverage_skipped`.
    let coverageAccepted = 0;
    let coverageError: string | undefined;
    if (coverage.length > 0) {
      try {
        coverageAccepted = deps.db.insertTestCoverage(coverage);
      } catch (err) {
        coverageError = (err as Error).message;
        deps.logger.error("test_coverage insert failed", {
          message: coverageError,
          attempted: coverage.length,
        });
      }
    }
    return {
      ok: true,
      accepted: rows.length,
      coverage_accepted: coverageAccepted,
      coverage_skipped: coverageSkipped,
      ...(coverageError !== undefined ? { coverage_error: coverageError } : {}),
      source,
      sample_rate: sampleRate,
    };
  });
}

type ValidateResult =
  | {
      ok: true;
      source: string;
      sampleRate: number;
      rows: ObservationRow[];
      coverage: TestCoverageRow[];
      /** How many `test_coverage` entries were dropped as malformed (task 2).
       *  A single bad row never rejects the batch — it is counted here so the
       *  collector can surface "N coverage rows skipped" without a 400/throw. */
      coverageSkipped: number;
    }
  | { ok: false; error: string };

function validate(body: unknown): ValidateResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const raw = body as RawPayload;
  const source = typeof raw.source === "string" ? raw.source : "";
  if (!source) return { ok: false, error: "missing or invalid `source`" };

  const sampleRate = Number(raw.sample_rate);
  if (!Number.isInteger(sampleRate) || sampleRate < 1) {
    return { ok: false, error: "`sample_rate` must be a positive integer" };
  }

  const obs = raw.observations;
  if (!Array.isArray(obs)) {
    return { ok: false, error: "`observations` must be an array" };
  }

  const rows: ObservationRow[] = [];
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i] as RawObservation;
    if (typeof o !== "object" || o === null) {
      return { ok: false, error: `observations[${i}] must be an object` };
    }
    if (typeof o.src !== "string" || !o.src) {
      return { ok: false, error: `observations[${i}].src missing` };
    }
    if (typeof o.dst !== "string" || !o.dst) {
      return { ok: false, error: `observations[${i}].dst missing` };
    }
    const ts = Number(o.ts);
    if (!Number.isFinite(ts)) {
      return { ok: false, error: `observations[${i}].ts invalid` };
    }
    const observed = Number(o.observed);
    if (!Number.isInteger(observed) || observed < 0) {
      return {
        ok: false,
        error: `observations[${i}].observed must be a non-negative integer`,
      };
    }
    if (observed > UINT16_MAX) {
      return {
        ok: false,
        error: `observations[${i}].observed exceeds uint16 max ${UINT16_MAX}; split the batch`,
      };
    }
    const weight = Number(o.weight);
    if (!Number.isInteger(weight) || weight < 0) {
      return {
        ok: false,
        error: `observations[${i}].weight must be a non-negative integer`,
      };
    }
    if (weight > UINT16_MAX) {
      return {
        ok: false,
        error: `observations[${i}].weight exceeds uint16 max ${UINT16_MAX}; split the batch`,
      };
    }
    const expected = observed * sampleRate;
    if (Math.abs(weight - expected) > ROUNDING_SLACK) {
      return {
        ok: false,
        error: `observations[${i}] weight mismatch: expected ${expected} (±${ROUNDING_SLACK}), got ${weight}`,
      };
    }
    rows.push({ src: o.src, dst: o.dst, ts, observed, weight, source });
  }

  // Optional per-test coverage (additive). Absent / non-array → empty (older
  // collectors). Each row needs non-empty `test` + `entity`; `weight` defaults
  // to 1 and must be a non-negative integer. A malformed entry is SKIPPED (not
  // a hard 400) and COUNTED — so a single bad coverage row never rejects the
  // whole batch's global observations NOR throws, and the caller learns how
  // many were dropped (task 2). `test`/`entity` are trimmed so a blank-but-
  // present string ("   ") is treated as missing rather than stored.
  const coverage: TestCoverageRow[] = [];
  let coverageSkipped = 0;
  const rawCov = raw.test_coverage;
  if (Array.isArray(rawCov)) {
    for (const c of rawCov as RawTestCoverage[]) {
      if (typeof c !== "object" || c === null) {
        coverageSkipped++;
        continue;
      }
      const test = typeof c.test === "string" ? c.test.trim() : "";
      const entity = typeof c.entity === "string" ? c.entity.trim() : "";
      if (!test || !entity) {
        coverageSkipped++;
        continue;
      }
      const w = c.weight === undefined ? 1 : Number(c.weight);
      if (!Number.isInteger(w) || w < 0) {
        coverageSkipped++;
        continue;
      }
      coverage.push({ test, entity, weight: w, source });
    }
  }

  return { ok: true, source, sampleRate, rows, coverage, coverageSkipped };
}
