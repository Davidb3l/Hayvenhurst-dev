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

import type { Aggregator, Observation } from "./aggregator.ts";
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

/** The full POST envelope the daemon validates. */
export interface WirePayload {
  source: string;
  sample_rate: number;
  observations: WireObservation[];
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
): WirePayload {
  const rate = Math.max(1, Math.floor(sampleRate));
  const observedCeiling = Math.floor(UINT16_MAX / rate);
  return {
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
}

export class Flusher {
  private readonly agg: Aggregator;
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
   * Drain and POST. Returns the number of observations sent (0 if none or on
   * error). Never throws into user code; errors land on `lastError`.
   */
  async flushOnce(): Promise<number> {
    const obs = this.agg.drain();
    if (obs.length === 0) return 0;
    const payload = encodePayload(obs, this.sampleRate, this.source);
    const body = JSON.stringify(payload);
    const run = (async () => {
      try {
        await this.sender(this.url, body);
        this._lastFlushAt = Date.now();
        this._lastFlushCount = obs.length;
        this._lastError = null;
      } catch (e) {
        this._lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
    })();
    this.inFlight = run;
    await run;
    this.inFlight = null;
    return this._lastError === null ? obs.length : 0;
  }

  private async defaultSender(url: string, body: string): Promise<void> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "hayven-trace-bun/0.0.5",
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
