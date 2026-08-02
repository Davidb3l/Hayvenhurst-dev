// CRDT growth bounds and the loud warning that fires when they are crossed.
//
// WHY THIS EXISTS (F2). The §14 op log is append-only by design: `gset.ts`
// says "Append-only, never deleted", segment files are one-per-UTC-day and
// nothing ever removes them, and `OpLog.hydrate` replays every segment into
// memory on every daemon start. Nothing in `crdt/` compacts, prunes, or GCs.
// So disk, daemon RSS, and start-up read amplification all grow without limit
// and — this is the part that made the home-directory incident possible —
// they grow SILENTLY. A daemon that has quietly accumulated a 593 MB op log
// looks exactly like a healthy one.
//
// WHY WE ONLY WARN, AND DO NOT DELETE. Deleting old segments is NOT safe with
// today's protocol. A Merkle leaf is the op-key set of one day's segment
// (§15.1). If peer A prunes 2026-01-01 and peer B still holds it, their roots
// diverge, `diffSnapshots` reports the day as "present remotely, missing
// locally", and A re-pulls the entire pruned segment on the next sync — a
// permanent pull loop that costs MORE I/O than keeping the data. Dropping ops
// would also change merge results (G-Set weights are summed honestly across
// every observation op, `materializeGset`). Both violate the brief's "preserve
// data over delete" and "do not silently drop data that changes merge
// results", so this module is deliberately observe-and-shout only. The
// compaction design that WOULD be safe is written up in the lane report; it
// needs a negotiated retention horizon exchanged in the Merkle handshake, and
// that is a protocol change, not a patch.
//
// What IS enforced here is the hard inbound cap in `oplog.ts`
// (`maxPushBatchBytes` / `maxSegmentBytes` / the segment-day window), which
// bounds what an untrusted peer can make us store in the first place.

import type { CrdtType, OpLog } from "./oplog.ts";

const TYPES: readonly CrdtType[] = ["lww", "gset", "orset"];

export interface CrdtLimits {
  /** Warn above this many bytes across every segment of every type. */
  readonly warnTotalBytes: number;
  /** Warn above this many bytes in a single day's segment. */
  readonly warnSegmentBytes: number;
  /** Warn above this many segment files for one CRDT type. */
  readonly warnSegmentCount: number;
  /** Warn above this many ops replayed into memory for one CRDT type. */
  readonly warnOpCount: number;
  /** Hard-reject an inbound §13 batch larger than this (bytes). */
  readonly maxPushBatchBytes: number;
  /** Hard-reject an inbound append that would grow a segment past this. */
  readonly maxSegmentBytes: number;
}

/**
 * Defaults. Chosen so a HEALTHY daemon never trips one: a real op is ~100
 * bytes, so 64 MiB in one UTC day is on the order of half a million ops in a
 * single day, and 400 segments is more than a year of continuous daily
 * activity. Crossing any of these means something is wrong — a runaway
 * producer, a peer pushing junk, or an install pointed at the wrong root —
 * which is exactly the class of "plausible default, unbounded work, no
 * signal" that this whole pass exists to kill.
 *
 * `warnTotalBytes` is deliberately set at 512 MiB: the incident's index was
 * 593 MB, so this threshold would have shouted before the user noticed.
 */
export const CRDT_LIMITS: CrdtLimits = {
  warnTotalBytes: 512 * 1024 * 1024,
  warnSegmentBytes: 64 * 1024 * 1024,
  warnSegmentCount: 400,
  warnOpCount: 2_000_000,
  maxPushBatchBytes: 8 * 1024 * 1024,
  maxSegmentBytes: 512 * 1024 * 1024,
};

export interface RetentionViolation {
  /** Stable machine-readable code, e.g. `total_bytes`, `segment_bytes`. */
  code: "total_bytes" | "segment_bytes" | "segment_count" | "op_count";
  /** CRDT type the violation belongs to, or null for whole-log totals. */
  type: CrdtType | null;
  /** Segment day, when the violation is segment-scoped. */
  day: string | null;
  observed: number;
  limit: number;
}

export interface RetentionReport {
  totalBytes: number;
  /** Segment file count per CRDT type. */
  segmentCounts: Record<CrdtType, number>;
  /** Oldest / newest segment day seen across all types (`null` when empty). */
  oldestDay: string | null;
  newestDay: string | null;
  violations: RetentionViolation[];
}

/**
 * Measure the op log against `limits`. Uses `stat` only — it must never read
 * segment contents, or the health check becomes the very read amplification it
 * is meant to detect (that was F3).
 */
export function inspectRetention(oplog: OpLog, limits: CrdtLimits = CRDT_LIMITS): RetentionReport {
  const violations: RetentionViolation[] = [];
  const segmentCounts = { lww: 0, gset: 0, orset: 0 } as Record<CrdtType, number>;
  let totalBytes = 0;
  let oldestDay: string | null = null;
  let newestDay: string | null = null;

  for (const type of TYPES) {
    const sizes = oplog.segmentSizes(type);
    segmentCounts[type] = sizes.length;
    if (sizes.length > limits.warnSegmentCount) {
      violations.push({
        code: "segment_count",
        type,
        day: null,
        observed: sizes.length,
        limit: limits.warnSegmentCount,
      });
    }
    for (const { day, bytes } of sizes) {
      totalBytes += bytes;
      if (oldestDay === null || day < oldestDay) oldestDay = day;
      if (newestDay === null || day > newestDay) newestDay = day;
      if (bytes > limits.warnSegmentBytes) {
        violations.push({
          code: "segment_bytes",
          type,
          day,
          observed: bytes,
          limit: limits.warnSegmentBytes,
        });
      }
    }
  }

  if (totalBytes > limits.warnTotalBytes) {
    violations.push({
      code: "total_bytes",
      type: null,
      day: null,
      observed: totalBytes,
      limit: limits.warnTotalBytes,
    });
  }

  return { totalBytes, segmentCounts, oldestDay, newestDay, violations };
}

/**
 * Fold in-memory op counts (from a hydrate) so an oversized REPLAY is caught
 * even when the on-disk bytes are under threshold. Mutates and returns
 * `report` so the caller can pass it straight to {@link warnRetention}.
 */
export function addOpCountViolations(
  report: RetentionReport,
  counts: Record<CrdtType, number>,
  limits: CrdtLimits = CRDT_LIMITS,
): RetentionReport {
  for (const type of TYPES) {
    const observed = counts[type];
    if (observed > limits.warnOpCount) {
      report.violations.push({
        code: "op_count",
        type,
        day: null,
        observed,
        limit: limits.warnOpCount,
      });
    }
  }
  return report;
}

/**
 * Emit one `crdt_retention:` line per violation on stderr. Same channel and
 * shape as `crdt_log:truncated_torn_write` in `oplog.ts` — the op log has no
 * logger injected and adding one would change the constructor signature other
 * lanes call. Returns the number of lines written so callers/tests can assert
 * that the warning actually fired (a silent bound is not a bound).
 */
export function warnRetention(
  report: RetentionReport,
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): number {
  for (const v of report.violations) {
    write(
      `crdt_retention:limit_exceeded code=${v.code}` +
        ` type=${v.type ?? "-"} day=${v.day ?? "-"}` +
        ` observed=${v.observed} limit=${v.limit}` +
        ` total_bytes=${report.totalBytes}` +
        ` oldest_day=${report.oldestDay ?? "-"} newest_day=${report.newestDay ?? "-"}` +
        ` action=the CRDT op log is append-only and never pruned;` +
        ` see docs — this daemon will keep growing until the cause is fixed\n`,
    );
  }
  return report.violations.length;
}
