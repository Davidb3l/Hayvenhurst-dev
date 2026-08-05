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
// results", so this module is deliberately observe-and-shout only.
//
// ── VERDICT: PRUNING WILL NOT BE BUILT. SEE docs/RFC-001. ───────────────────
//
// An earlier revision of this note (the "T5 verdict") sketched an
// acknowledgement protocol in full: peers exchange `oldest_retained_day` in the
// Merkle handshake, `diffSnapshots` floors at `max(mine, theirs)`, and a peer
// prunes a day only once EVERY KNOWN PEER has acknowledged it. It concluded the
// design was blocked on missing substrate — no peer identity, no ack store —
// and estimated the cost of building it.
//
// **That framing is superseded. Do not implement it, and do not cost it.**
// `docs/RFC-001-peer-sync-and-retention.md` is the current decision.
//
// WHAT CHANGED: the premise was finally MEASURED instead of assumed. On a real
// install with five registered projects and two months of daily use, the
// largest CRDT directory was 12 KB and the total across every log was 2,098
// bytes — a projected ~12 KB/year, or roughly 42,600 years to reach the 512 MiB
// `warnTotalBytes` threshold below. A user generating a HUNDRED TIMES more CRDT
// traffic still needs about four centuries to trip that warning.
//
// So the growth is unbounded in the formal sense and irrelevant in every
// practical one. Pruning carries a permanent-data-loss risk — operations are
// the durable record of graph history, and a peer that prunes a day nobody else
// kept has destroyed it irrecoverably — and that risk requires a proportionate
// benefit, which does not exist at 12 KB/year. `KNOWN_ISSUES` #3 is closed as
// "will not fix", with the measurement recorded so the next reader does not
// redesign this from the same stale premise. This note is that record: the
// reasoning error was that a written-down design read as an established
// requirement, and the solution was re-derived without ever re-testing the
// problem.
//
// IF GROWTH EVER DOES BECOME REAL (RFC-001 §3), the options in ascending order
// of risk are: (1) fix the LOADING strategy, not the data — lazy/streamed
// hydrate, no coordination and nothing destroyed; (2) compress cold segments in
// place, still Merkle-comparable after decompression; (3) snapshot plus tail;
// and only then (4) actual deletion with peer acknowledgement. Three
// non-destructive options exist and none of them were considered before a
// destructive protocol was designed. RFC-001 §5 records the one condition that
// would reopen this: a measurement, from a genuinely heavy multi-agent
// workload, that differs by orders of magnitude. An assumption will not do.
//
// WHAT WAS BUILT INSTEAD: the one genuinely useful thing that surfaced —
// PEER IDENTITY (RFC-001 §4, `crdt/peers.ts`). It stands entirely on its own
// and has no relationship to pruning: `config.sync_peers` was dead
// configuration and a daemon could not answer "who am I synced with?". It now
// can. Note what it deliberately is NOT: there is no `acked_through_day`, no
// retention horizon, and no policy of any kind. It records who has synced. Do
// not grow an ack protocol back out of it.
//
// What IS enforced here is the hard inbound cap in `oplog.ts`
// (`maxPushBatchBytes` / `maxSegmentBytes` / the segment-day window), which
// bounds what an untrusted peer can make us store in the first place — plus,
// as of T6, a PERIODIC re-measurement so the warnings are reachable during a
// long-running session and not only at daemon start.

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

/**
 * How often the op log re-measures itself while a daemon is RUNNING
 * (`OpLog.maybeCheckRetention`). Five minutes.
 *
 * WHY (T6): the F2 bounds were evaluated in exactly one place —
 * `CrdtState.hydrate()`, i.e. daemon start — which is the moment the log is
 * smallest. The incident's daemon ran for six hours in a single process and
 * would have crossed every threshold in this file without emitting one line,
 * because the only code that could emit had already finished. Five minutes is
 * short enough that a runaway producer is named while it is still running, and
 * long enough that the cost (one `stat` pass over the segment directories, no
 * segment contents read) is irrelevant next to the writes it rides along with.
 */
export const RETENTION_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

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
