/**
 * Periodic flush of aggregated observations to the daemon.
 *
 * Uses the built-in `fetch` (Bun/Node) so we ship zero runtime deps. The flush
 * runs on a `setInterval` timer; it gracefully no-ops if the daemon is
 * unreachable — the error is recorded on `lastError` and the next interval
 * retries with fresh data. No error is ever thrown into the user's code.
 *
 * The transport is INJECTABLE (`sender`) so the flusher can be unit-tested with
 * a mock that captures the encoded payload — no live daemon required.
 */

import type { Aggregator, CoverageAggregator, CoverageRow, Observation } from "./aggregator.ts";
import { UINT16_MAX } from "./profile.ts";

/** Injectable transport. Receives the full URL and the JSON-encoded body. */
export type Sender = (url: string, body: string) => Promise<void>;

/** A single observation as it goes on the wire (both `observed` and `weight`). */
export interface WireObservation {
  src: string;
  dst: string;
  ts: number;
  observed: number;
  weight: number;
  kind: string;
}

/** A per-test coverage row on the wire (mirrors trace/python's shape exactly:
 *  non-empty `test`/`entity` raw runtime names + a non-negative int `weight`). */
export interface WireTestCoverage {
  test: string;
  entity: string;
  weight: number;
}

/** The full POST envelope the daemon validates. */
export interface WirePayload {
  source: string;
  sample_rate: number;
  observations: WireObservation[];
  /** Additive per-test coverage (daemon schema v6). Omitted entirely when there
   *  is nothing to report, so edge-only batches stay byte-identical to the
   *  legacy shape (same rule as trace/python's flusher). */
  test_coverage?: WireTestCoverage[];
}

/**
 * Maximum rows (observations OR coverage) carried in a single POST. Mirrors
 * trace/python's `FLUSH_BATCH_SIZE` and the data-loss bug it fixed there: a
 * full suite's shutdown flush in ONE giant JSON blew the per-request timeout
 * and silently dropped everything already drained. Bounded chunks keep every
 * request small, and a single failed chunk is re-buffered instead of taking
 * the rest of the flush down with it.
 */
export const FLUSH_BATCH_SIZE = 1000;

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const s = size < 1 ? 1 : size;
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += s) out.push(rows.slice(i, i + s));
  return out;
}

export interface FlusherOptions {
  /** Base daemon URL; `/api/traces/observations` is appended. */
  daemonUrl: string;
  /** Flush cadence in seconds. Default 30. */
  intervalSeconds?: number;
  /**
   * Envelope `sample_rate`. For the V8-CPU-profiler capture model this is `1`
   * (`observed == weight`). The flusher keeps `weight = observed * sample_rate`
   * exactly for any positive integer, so a future true 1-in-N hook can set it.
   */
  sampleRate?: number;
  /** Per-POST timeout in ms. Default 2000. */
  timeoutMs?: number;
  /** Injectable transport (test seam). Default uses `fetch`. */
  sender?: Sender;
  /** Batch source tag. Default `"bun"`. */
  source?: string;
  /**
   * Optional per-test coverage aggregator. When supplied, each flush also
   * drains it and emits a top-level `test_coverage` array alongside the
   * unchanged `observations` — the SAME lifecycle as the edge aggregate
   * (cleared every flush, including the final shutdown flush). Mirrors
   * trace/python's `Flusher(coverage=…)`.
   */
  coverage?: CoverageAggregator;
}

/**
 * Encode aggregator observations into the daemon wire payload.
 *
 * Carries BOTH the raw summed sample count (`observed`) and the scaled estimate
 * (`weight = observed * sample_rate`). The daemon re-derives `weight` from
 * `observed` and the envelope `sample_rate` and rejects the batch (HTTP 400)
 * if it is off by more than ±1 — no hidden scaling (PRD §4.6 / §9).
 *
 * Both fields are clamped to {@link UINT16_MAX}. To preserve the daemon's
 * `weight == observed * sample_rate` invariant under clamping, `observed` is
 * clamped FIRST to `floor(UINT16_MAX / sample_rate)` so that
 * `observed * sample_rate <= UINT16_MAX`, then `weight` is computed from the
 * clamped `observed`. (At the default `sample_rate = 1` this is just the plain
 * uint16 clamp and `observed == weight`.)
 */
export function encodePayload(
  observations: Observation[],
  sampleRate: number,
  source: string,
  coverage: CoverageRow[] = [],
): WirePayload {
  const rate = Math.max(1, Math.floor(sampleRate));
  const observedCeiling = Math.floor(UINT16_MAX / rate);
  const payload: WirePayload = {
    source,
    sample_rate: rate,
    observations: observations.map((o) => {
      const observed = Math.min(Math.max(0, Math.floor(o.observed)), observedCeiling);
      return {
        src: o.src,
        dst: o.dst,
        ts: o.ts,
        observed,
        weight: observed * rate,
        kind: o.kind || "call",
      };
    }),
  };
  // Additive per-test coverage. The daemon accepts `test_coverage` beside the
  // unchanged `observations` (coverage-only payloads carry `observations: []`,
  // which the route accepts). Weight is NOT sample-rate scaled — it's an
  // advisory count, not the daemon-verified `weight` invariant field. Omit the
  // key entirely when empty (byte-identical legacy shape).
  if (coverage.length > 0) {
    payload.test_coverage = coverage.map((c) => ({
      test: c.test,
      entity: c.entity,
      weight: Math.max(0, Math.floor(c.weight)),
    }));
  }
  return payload;
}

export class Flusher {
  private readonly agg: Aggregator;
  private readonly coverage: CoverageAggregator | null;
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly sampleRate: number;
  private readonly timeoutMs: number;
  private readonly sender: Sender;
  private readonly source: string;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  private _lastFlushAt = 0;
  private _lastFlushCount = 0;
  private _lastError: string | null = null;

  constructor(aggregator: Aggregator, opts: FlusherOptions) {
    this.agg = aggregator;
    this.coverage = opts.coverage ?? null;
    this.url = opts.daemonUrl.replace(/\/+$/, "") + "/api/traces/observations";
    this.intervalMs = Math.max(1, (opts.intervalSeconds ?? 30)) * 1000;
    this.sampleRate = Math.max(1, Math.floor(opts.sampleRate ?? 1));
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.sender = opts.sender ?? this.defaultSender.bind(this);
    this.source = opts.source ?? "bun";
  }

  get lastError(): string | null {
    return this._lastError;
  }
  get lastFlushCount(): number {
    return this._lastFlushCount;
  }
  get lastFlushAt(): number {
    return this._lastFlushAt;
  }

  /** Start the background interval. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.flushOnce();
    }, this.intervalMs);
    // Don't keep the process alive just for the flusher (Bun/Node API).
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Stop the interval and, by default, flush a final batch. */
  async stop(flush = true): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight.catch(() => {});
    if (flush) await this.flushOnce();
  }

  /**
   * Drain and POST in BOUNDED chunks. Returns the number of observations
   * actually sent (0 if none, or if every chunk failed). Never throws into
   * user code; errors land on `lastError`.
   *
   * Mirrors trace/python's chunked flush: the drained payload is split into
   * chunks of at most {@link FLUSH_BATCH_SIZE} rows; observation chunks are
   * PAIRED with coverage chunks so coverage rides with a non-empty
   * `observations` wherever possible, and surplus chunks ship on their own
   * (a coverage-only payload carries `observations: []`, which the daemon
   * accepts). A FAILED chunk is re-buffered into the aggregators so the next
   * flush retries it — a transient daemon outage is a delayed send, not a
   * silent drop — and the loop CONTINUES so one bad chunk can't take the
   * remaining chunks down.
   */
  async flushOnce(): Promise<number> {
    const obs = this.agg.drain();
    const coverage = this.coverage?.drain() ?? [];
    if (obs.length === 0 && coverage.length === 0) return 0;

    const run = (async () => {
      const obsChunks = chunk(obs, FLUSH_BATCH_SIZE);
      const covChunks = chunk(coverage, FLUSH_BATCH_SIZE);
      const nPairs = Math.max(obsChunks.length, covChunks.length);
      let sent = 0;
      let anyError: string | null = null;
      for (let i = 0; i < nPairs; i++) {
        const o = obsChunks[i] ?? [];
        const c = covChunks[i] ?? [];
        const body = JSON.stringify(encodePayload(o, this.sampleRate, this.source, c));
        try {
          await this.sender(this.url, body);
          sent += o.length;
        } catch (e) {
          anyError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          this.rebuffer(o, c);
        }
      }
      if (anyError !== null) {
        this._lastError = anyError;
        this._lastFlushCount = sent;
      } else {
        this._lastFlushAt = Date.now();
        this._lastFlushCount = sent;
        this._lastError = null;
      }
      return sent;
    })();

    this.inFlight = run.then(() => {});
    const sent = await run;
    this.inFlight = null;
    return sent;
  }

  /**
   * Return a failed chunk's rows to the aggregators for the next flush.
   * Best-effort: must never throw out of the flush path.
   */
  private rebuffer(obs: Observation[], coverage: CoverageRow[]): void {
    try {
      for (const o of obs) this.agg.add(o.src, o.dst, o.kind, o.observed);
      if (this.coverage !== null) {
        for (const c of coverage) this.coverage.add(c.test, c.entity, c.weight);
      }
    } catch {
      /* defensive: drop only in the already-degraded double-failure case */
    }
  }

  private async defaultSender(url: string, body: string): Promise<void> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "hayven-trace-bun/0.0.4",
        },
        body,
        signal: ctrl.signal,
      });
      // Drain/discard; a non-2xx (e.g. 400) is surfaced as an error so the
      // user can see a contract mismatch via `lastError`, but never thrown.
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`daemon returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      }
    } finally {
      clearTimeout(t);
    }
  }
}
