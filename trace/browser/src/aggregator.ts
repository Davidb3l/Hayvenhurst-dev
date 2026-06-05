/**
 * In-process aggregation of (src, dst) call observations.
 *
 * Mirrors `trace/python/src/hayven_trace/aggregator.py` and
 * `trace/go/aggregator.go`: a map keyed by a packed `(src, dst, kind)` tuple,
 * with an atomic `drain()` that returns the buffered observations and resets
 * state in one step so the reset can never lose a concurrent increment.
 *
 * JavaScript is single-threaded per event-loop turn, so unlike the Go/Python
 * collectors we do not need a mutex — `add` and `drain` are each synchronous
 * and run to completion without interleaving. `drain()` is still "atomic" in
 * the sense that it swaps the backing map in a single synchronous step.
 *
 * Only `observed` (the raw sampled count) is carried at this layer. `weight`
 * — the scaled estimate the daemon re-derives — is added by the flusher when
 * it builds the wire payload, because only the flusher knows the envelope
 * `sample_rate` the daemon will verify against (PRD §4.6: send both the
 * ground truth and the convenience value, no hidden scaling).
 */

/** A flush-ready observation: src -> dst, ts (Unix seconds), raw sample count. */
export interface Observation {
  src: string;
  dst: string;
  /** Unix timestamp in SECONDS (the daemon expects seconds, not ms). */
  ts: number;
  /** Raw sampled count — the ground-truth `observed` on the wire. */
  observed: number;
  kind: string;
}

/** Build the map key for an edge. `kind` is part of the identity. */
function keyFor(src: string, dst: string, kind: string): string {
  // `\x00` cannot appear in a JS-derived symbol name, so it is a safe
  // separator for packing the tuple into a single string map key.
  return `${src}\x00${dst}\x00${kind}`;
}

/** Accumulates call-edge counts in memory, flushed atomically by `drain()`. */
export class Aggregator {
  private counts = new Map<string, number>();

  /** Record `n` occurrences of a single sampled call edge. */
  add(src: string, dst: string, n = 1, kind = "call"): void {
    if (!src || !dst || n <= 0) return;
    const k = keyFor(src, dst, kind);
    this.counts.set(k, (this.counts.get(k) ?? 0) + n);
  }

  /** Record one occurrence for each `[src, dst]` pair. */
  addMany(edges: Array<[string, string]>): void {
    for (const [src, dst] of edges) {
      if (!src || !dst) continue;
      const k = keyFor(src, dst, "call");
      this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    }
  }

  /** Number of distinct edges currently held. */
  size(): number {
    return this.counts.size;
  }

  /**
   * Atomically return all aggregated observations and reset state.
   *
   * Each returned observation carries the current Unix timestamp (SECONDS) as
   * `ts` and the raw count as `observed`. `sample_rate` scaling is applied
   * downstream by the flusher.
   */
  drain(): Observation[] {
    const ts = Math.floor(Date.now() / 1000);
    const counts = this.counts;
    this.counts = new Map();

    const out: Observation[] = [];
    for (const [k, observed] of counts) {
      const [src, dst, kind] = k.split("\x00");
      out.push({ src: src!, dst: dst!, ts, observed, kind: kind! });
    }
    return out;
  }
}
