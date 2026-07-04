/**
 * Periodic flush of aggregated observations to the daemon.
 *
 * Mirrors `trace/python/src/hayven_trace/flusher.py` and `trace/go/flusher.go`:
 * a background interval timer drains an Aggregator and POSTs the batch; the
 * transport is INJECTABLE (tests pass a mock sender, so no live daemon is
 * needed); and a flush against an unreachable daemon is a graceful no-op — the
 * error is recorded on `lastError`, never thrown into user code.
 */

import type { Aggregator, Observation } from "./aggregator.ts";

/** The daemon's per-observation ceiling on `observed`/`weight` (uint16). */
const UINT16_MAX = 0xffff;

/**
 * Injectable transport. Production uses `fetch`; tests inject a mock so the
 * flusher can be exercised without a live daemon. A thrown/rejected sender
 * makes `flushOnce` no-op gracefully (the error is stashed, not raised).
 */
export type Sender = (url: string, payload: string) => Promise<void>;

/** On-wire shape of a single observation (carries BOTH observed and weight). */
interface WireObservation {
  src: string;
  dst: string;
  ts: number;
  observed: number;
  weight: number;
  kind: string;
}

/** POST envelope. `sample_rate` is envelope-level. */
interface WirePayload {
  source: string;
  sample_rate: number;
  observations: WireObservation[];
}

export interface FlusherOptions {
  /** Daemon base URL; `/api/traces/observations` is appended. */
  daemonUrl: string;
  /** Background flush cadence in MILLISECONDS. Default 30_000. */
  intervalMs?: number;
  /**
   * Envelope `sample_rate`. For the CPU-profiler honest mapping this MUST be 1
   * (`observed == weight`). Values < 1 are coerced to 1.
   */
  sampleRate?: number;
  /** Per-POST timeout in MILLISECONDS. Default 2_000. */
  timeoutMs?: number;
  /** Batch source tag. Default "browser". */
  source?: string;
  /** Injectable transport (the test seam). Default uses `fetch`. */
  sender?: Sender;
}

export class Flusher {
  private readonly agg: Aggregator;
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly sampleRate: number;
  private readonly timeoutMs: number;
  private readonly source: string;
  private readonly sender: Sender;

  private timer: ReturnType<typeof setInterval> | null = null;
  private _lastError: string | null = null;
  private _lastFlushCount = 0;
  private _lastFlushAt = 0;

  constructor(aggregator: Aggregator, opts: FlusherOptions) {
    this.agg = aggregator;
    this.url = opts.daemonUrl.replace(/\/+$/, "") + "/api/traces/observations";
    this.intervalMs = opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : 30_000;
    this.sampleRate = opts.sampleRate && opts.sampleRate >= 1 ? Math.floor(opts.sampleRate) : 1;
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 2_000;
    this.source = opts.source && opts.source.length > 0 ? opts.source : "browser";
    this.sender = opts.sender ?? this.defaultSender.bind(this);
  }

  // ----- lifecycle -----

  /** Launch the background flush timer. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.flushOnce();
    }, this.intervalMs);
    // Don't keep the process alive just for the flush timer (Bun/Node).
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Stop the background timer. If `flush` is true (default) it performs a final
   * `flushOnce` so the last batch is not lost on shutdown.
   */
  async stop(flush = true): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (flush) await this.flushOnce();
  }

  // ----- public surface -----

  /**
   * Drain and POST. Returns the number of observations sent. Errors are stashed
   * on `lastError`; we never throw into user code.
   */
  async flushOnce(): Promise<number> {
    const obs = this.agg.drain();
    if (obs.length === 0) return 0;
    const payload = this.encode(obs);
    try {
      await this.sender(this.url, payload);
      this._lastFlushAt = Date.now();
      this._lastFlushCount = obs.length;
      this._lastError = null;
    } catch (e) {
      this._lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    return obs.length;
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

  // ----- internals -----

  /**
   * Build the wire payload. Sends BOTH the raw sample count (`observed`) and
   * the scaled estimate (`weight = observed * sample_rate`); the daemon
   * re-derives `weight` and rejects a mismatch beyond ±1. Counts are clamped to
   * the daemon's uint16 ceiling; the clamp preserves the invariant because the
   * honest mapping uses `sample_rate == 1` (so `weight == observed`).
   */
  encode(observations: Observation[]): string {
    const rate = this.sampleRate;
    const body: WirePayload = {
      source: this.source,
      sample_rate: rate,
      observations: observations.map((o) => {
        let observed = Math.min(o.observed, UINT16_MAX);
        let weight = observed * rate;
        if (weight > UINT16_MAX) {
          // Only reachable when rate > 1; clamp observed so the invariant
          // weight == observed * rate still holds exactly.
          observed = Math.floor(UINT16_MAX / rate);
          weight = observed * rate;
        }
        return {
          src: o.src,
          dst: o.dst,
          ts: o.ts,
          observed,
          weight,
          kind: o.kind || "call",
        };
      }),
    };
    return JSON.stringify(body);
  }

  private async defaultSender(url: string, payload: string): Promise<void> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "hayven-trace-browser/0.0.4",
        },
        body: payload,
        signal: controller.signal,
      });
      // Drain and discard so the connection can be reused.
      await resp.arrayBuffer().catch(() => undefined);
    } finally {
      clearTimeout(t);
    }
  }
}
