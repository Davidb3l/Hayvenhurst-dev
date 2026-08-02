// Append-only segmented CRDT op log. ARCHITECTURE.md §14.
//
// One directory per CRDT type (`lww/`, `gset/`, `orset/`) under
// `.hayven/crdt/`. One segment file per UTC day, name `YYYY-MM-DD.log`.
// Inside each segment: a concatenation of length-prefixed §13 wire batches.
//
// Writers always append, fdatasync every N writes or M milliseconds.
// Readers stream the whole directory in lexicographic order on daemon
// start. Torn writes (EOF mid-batch) truncate to the last complete batch
// and emit a `crdt_log:truncated_torn_write` warning.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fdatasyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { encodeHlc, type WriterId } from "./hlc.ts";
import {
  CRDT_LIMITS,
  inspectRetention,
  RETENTION_RECHECK_INTERVAL_MS,
  warnRetention,
  type CrdtLimits,
} from "./retention.ts";
import { openWireBridge, type WireBridge, type WireOp } from "./wire.ts";

export type CrdtType = "lww" | "gset" | "orset";

/**
 * How far into the future an INBOUND segment day may be (F4). The sync push
 * and live-sync paths both write to a day chosen by the remote peer (the op's
 * HLC day), and `isSafeSegmentName` only checked that the date was on the
 * calendar — `9999-12-31` passed. Since segments are never pruned, a peer with
 * a broken or hostile clock can mint ~2.9 million distinct future segment
 * files that every subsequent `hydrate()`, `diskUsage()` and Merkle pass must
 * walk. Seven days is far more skew than any real machine has; beyond it we
 * reject LOUDLY rather than silently absorbing a clock we cannot trust.
 */
export const MAX_FUTURE_SEGMENT_DAYS = 7;

/** Earliest inbound segment day we accept. Before the Unix epoch there is no
 *  legitimate HLC (`wall_ms` is unsigned ms since epoch), so anything earlier
 *  is corrupt or forged. */
export const MIN_SEGMENT_DAY = "1970-01-01";

/** Thrown when an inbound (peer-controlled) append is refused. Callers on the
 *  HTTP/WS sync paths turn this into a 4xx instead of a 500 — the point is
 *  that the peer learns its data was refused, rather than us silently
 *  accepting unbounded growth. */
export class SegmentRejectedError extends Error {
  override readonly name = "SegmentRejectedError";
  /** `"day"` = the segment name is outside the acceptance window (a client
   *  VALIDATION failure → 400). `"size"` = the payload or the resulting
   *  segment is too large (→ 413). Without this discriminator the same
   *  rejection surfaced as 400 from the route's pre-check and 413 from the
   *  op-log backstop, which is confusing to a peer trying to react. */
  constructor(message: string, readonly kind: "day" | "size") {
    super(message);
  }
}

/**
 * Validate a peer-supplied segment day against the acceptance window.
 * Throws {@link SegmentRejectedError} with an actionable message.
 *
 * Deliberately NOT applied to the local append path: our own ops are trusted,
 * and tests inject fake clocks that legitimately produce 1970 days.
 */
export function assertAcceptableSegmentDay(day: string, nowMs: number): void {
  if (day < MIN_SEGMENT_DAY) {
    throw new SegmentRejectedError(
      `segment day ${day} predates ${MIN_SEGMENT_DAY} — refusing (corrupt or forged HLC)`,
      "day",
    );
  }
  const horizon = utcDate(nowMs + MAX_FUTURE_SEGMENT_DAYS * 86_400_000);
  if (day > horizon) {
    throw new SegmentRejectedError(
      `segment day ${day} is more than ${MAX_FUTURE_SEGMENT_DAYS} days in the future ` +
        `(horizon ${horizon}) — refusing; check the peer's clock`,
      "day",
    );
  }
}

export interface OpLogOptions {
  /** Default: 32 writes between fdatasync. */
  flushEveryWrites?: number;
  /** Default: 250 ms. */
  flushEveryMs?: number;
  /** Inject a clock for tests. Returns Unix milliseconds. */
  now?: () => number;
  /** Inject a wire bridge for tests; default opens the subprocess one. */
  bridge?: WireBridge;
  /** Growth bounds for the periodic self-check. Defaults to {@link CRDT_LIMITS}. */
  limits?: CrdtLimits;
  /** How often the periodic self-check may run. Defaults to
   *  {@link RETENTION_RECHECK_INTERVAL_MS}; `0` disables it entirely. */
  retentionCheckIntervalMs?: number;
}

interface SegmentHandle {
  /** UTC date string `YYYY-MM-DD`. */
  date: string;
  /** Absolute path. */
  path: string;
  /** Open `fd` if currently held; `-1` otherwise. */
  fd: number;
  /** Writes since last fdatasync. */
  pendingWrites: number;
  /** Wall-clock ms of last fdatasync. */
  lastFlushMs: number;
}

export class OpLog {
  private readonly bridge: WireBridge;
  private readonly now: () => number;
  private readonly flushEveryWrites: number;
  private readonly flushEveryMs: number;
  private readonly segments = new Map<CrdtType, SegmentHandle>();
  private readonly limits: CrdtLimits;
  private readonly retentionCheckIntervalMs: number;
  /** Wall-clock ms of the last periodic retention check. Seeded at CONSTRUCTION
   *  so the first check is one interval away, not on the first append — the
   *  hydrate-time check has just run and a second identical burst of warnings
   *  on daemon start would be noise. */
  private lastRetentionCheckMs: number;

  constructor(private readonly crdtRoot: string, opts: OpLogOptions = {}) {
    this.bridge = opts.bridge ?? openWireBridge();
    this.now = opts.now ?? Date.now;
    this.flushEveryWrites = opts.flushEveryWrites ?? 32;
    this.flushEveryMs = opts.flushEveryMs ?? 250;
    this.limits = opts.limits ?? CRDT_LIMITS;
    this.retentionCheckIntervalMs =
      opts.retentionCheckIntervalMs ?? RETENTION_RECHECK_INTERVAL_MS;
    this.lastRetentionCheckMs = this.now();
    for (const t of TYPES) mkdirSync(join(this.crdtRoot, t), { recursive: true });
  }

  /**
   * Append `ops` as one §13 batch. The segment file is named by the batch's
   * **HLC day** (the first op's `wall_ms`), NOT the writer's wall clock.
   * This is load-bearing for sync convergence: the same op carries the same
   * HLC on every replica, so it always lands in the same-named segment, so
   * two peers that hold the same op-set produce the same Merkle leaf
   * (ARCHITECTURE.md §15.1). Bucketing by `now()` would put the same op in
   * differently-named files on different machines and they could never
   * converge. Returns bytes written.
   */
  appendOps(type: CrdtType, ops: WireOp[]): number {
    if (ops.length === 0) return 0;
    const date = utcDate(ops[0]!.hlc.wall_ms);
    // Our own ops are never REJECTED — losing local data to a clock problem
    // would be worse than the clock problem. But a local day outside the
    // inbound acceptance window means every peer will refuse these bytes
    // forever (they hit the same guard on their side), so this must not pass
    // silently: that is a permanent, invisible divergence, exactly the class
    // of failure this pass exists to remove.
    this.warnIfLocalDayOutOfWindow(type, date);
    const batch = this.bridge.encode(ops);
    return this.appendBatchBytes(type, date, batch, /* cached */ true);
  }

  /**
   * Append a pre-encoded §13 batch to the segment for `date` (a `YYYY-MM-DD`
   * string). Used by the sync push path: the puller already knows the peer
   * segment's day, and we must write to THAT day, not today, or cross-day
   * sync never converges. Opens the target file directly so it doesn't
   * disturb the cached fd used for local same-day writes.
   *
   * F4: this is the ONLY path an untrusted peer can grow our disk through
   * (`POST /api/sync/push` and the `/ws/sync` frame handler both land here),
   * so the inbound bounds are enforced HERE rather than in each route — a
   * future caller cannot forget them. Three guards, all throwing
   * {@link SegmentRejectedError}:
   *   1. batch size    — one §13 batch is normally tens of bytes; 8 MiB is
   *                      ~100,000x headroom and still bounds a single call.
   *   2. segment day   — must be inside the acceptance window, or a bad clock
   *                      mints unprunable far-future segments forever.
   *   3. segment total — refuse the append that would push one day's segment
   *                      past the hard cap, because `hydrate` and
   *                      `segmentCompositeKeys` both materialize a whole
   *                      segment in memory and nothing ever prunes it.
   */
  appendRawBatchToDate(type: CrdtType, date: string, batch: Uint8Array): number {
    if (batch.length > CRDT_LIMITS.maxPushBatchBytes) {
      throw new SegmentRejectedError(
        `inbound §13 batch is ${batch.length} bytes, over the ` +
          `${CRDT_LIMITS.maxPushBatchBytes}-byte cap — refusing`,
        "size",
      );
    }
    assertAcceptableSegmentDay(date, this.now());
    const path = join(this.crdtRoot, type, `${date}.log`);
    const existingBytes = existsSync(path) ? statSync(path).size : 0;
    if (existingBytes + batch.length > CRDT_LIMITS.maxSegmentBytes) {
      throw new SegmentRejectedError(
        `appending ${batch.length} bytes would grow segment ${type}/${date} past the ` +
          `${CRDT_LIMITS.maxSegmentBytes}-byte cap (currently ${existingBytes}) — refusing; ` +
          `the op log is never pruned, so this segment would be re-read in full on every start`,
        "size",
      );
    }
    return this.appendBatchBytes(type, date, batch, /* cached */ false);
  }

  /**
   * Core append. `cached=true` reuses the per-type open fd (hot local-write
   * path); `cached=false` opens/append/sync/close the target day's file
   * standalone (sync push path). Both frame the batch with a single varint
   * length prefix — callers must pass ONE §13 batch, never a whole segment.
   */
  private appendBatchBytes(
    type: CrdtType,
    date: string,
    batch: Uint8Array,
    cached: boolean,
  ): number {
    const header = encodeVarint(batch.length);
    const buf = new Uint8Array(header.length + batch.length);
    buf.set(header, 0);
    buf.set(batch, header.length);

    if (!cached) {
      const path = join(this.crdtRoot, type, `${date}.log`);
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, "a");
      try {
        writeFully(fd, buf);
        fdatasyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.maybeCheckRetention();
      return buf.length;
    }

    const seg = this.ensureOpenSegment(type, date);
    writeFully(seg.fd, buf);
    seg.pendingWrites += 1;
    const nowMs = this.now();
    if (
      seg.pendingWrites >= this.flushEveryWrites ||
      nowMs - seg.lastFlushMs >= this.flushEveryMs
    ) {
      fdatasyncSync(seg.fd);
      seg.pendingWrites = 0;
      seg.lastFlushMs = nowMs;
    }
    this.maybeCheckRetention();
    return buf.length;
  }

  /**
   * Periodic growth self-check, run from the append chokepoint.
   *
   * WHY THIS EXISTS (T6). The retention bounds added in F2 were measured ONLY
   * in `CrdtState.hydrate()` — i.e. at daemon start. That is precisely the
   * moment the log is smallest, and a daemon that runs for days never calls it
   * again. The original incident ran for SIX HOURS in one process: a log that
   * grows from nothing to gigabytes inside a single session would have crossed
   * every threshold and reported none of them, because the only thing that
   * could report was the code path that had already finished running. A bound
   * nobody re-evaluates is a bound that fires once, on the wrong data.
   *
   * Cheap by construction: `inspectRetention` is `stat`-only (never reads a
   * segment — reading them would BE the read amplification it detects), and the
   * interval gate means the cost is one directory stat pass per interval no
   * matter how hot the write path is. Failures are swallowed: a diagnostic must
   * never be able to fail a CRDT write.
   */
  private maybeCheckRetention(): void {
    if (this.retentionCheckIntervalMs <= 0) return;
    const nowMs = this.now();
    // `<` not `<=` on a zero-elapsed fake clock: tests that pin `now` to a
    // constant must not re-stat on every single append.
    if (nowMs - this.lastRetentionCheckMs < this.retentionCheckIntervalMs) return;
    this.lastRetentionCheckMs = nowMs;
    try {
      warnRetention(inspectRetention(this, this.limits));
    } catch {
      // Never let a diagnostic break an append.
    }
  }

  /** One `crdt_retention:local_day_out_of_window` line per (type, day), not
   *  one per append — a skewed clock would otherwise write a line per op. */
  private readonly warnedLocalDays = new Set<string>();

  private warnIfLocalDayOutOfWindow(type: CrdtType, date: string): void {
    const key = `${type}/${date}`;
    if (this.warnedLocalDays.has(key)) return;
    try {
      assertAcceptableSegmentDay(date, this.now());
      return;
    } catch (err) {
      if (!(err instanceof SegmentRejectedError)) throw err;
      this.warnedLocalDays.add(key);
      process.stderr.write(
        `crdt_retention:local_day_out_of_window type=${type} day=${date} ` +
          `reason=${err.message} ` +
          `action=ops written here are accepted locally but every PEER will refuse them; ` +
          `fix this machine's clock\n`,
      );
    }
  }

  /** Force-flush every open segment. Idempotent. */
  flushAll(): void {
    for (const seg of this.segments.values()) {
      if (seg.fd >= 0 && seg.pendingWrites > 0) {
        fdatasyncSync(seg.fd);
        seg.pendingWrites = 0;
        seg.lastFlushMs = this.now();
      }
    }
  }

  /** Close every open segment. Safe to call multiple times. */
  close(): void {
    for (const seg of this.segments.values()) {
      if (seg.fd >= 0) {
        try {
          if (seg.pendingWrites > 0) fdatasyncSync(seg.fd);
        } catch {
          // best-effort: a flush failure on close still warrants closing the fd.
        }
        closeSync(seg.fd);
        seg.fd = -1;
      }
    }
    this.segments.clear();
  }

  /**
   * Stream every batch for `type` in segment-date order, oldest first. Used
   * by hydrate-on-start. Yields decoded wire ops; the caller is responsible
   * for materializing them into a CRDT state.
   */
  *hydrate(type: CrdtType): IterableIterator<WireOp> {
    const dir = join(this.crdtRoot, type);
    if (!existsSync(dir)) return;
    const segments = readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .sort();
    for (const file of segments) {
      const path = join(dir, file);
      const bytes = readFileSync(path);
      let offset = 0;
      let lastGoodEnd = 0;
      while (offset < bytes.length) {
        const lenRead = readVarint(bytes, offset);
        if (lenRead === null) break; // torn write inside the length varint
        const [batchLen, after] = lenRead;
        if (after + batchLen > bytes.length) break; // torn write inside the batch
        const batchBytes = bytes.subarray(after, after + batchLen);
        let decoded: WireOp[];
        try {
          decoded = this.bridge.decode(new Uint8Array(batchBytes));
        } catch {
          // Stop at the first un-decodable batch — treat the same as a torn
          // write, truncate to the previous good end.
          break;
        }
        for (const op of decoded) yield op;
        offset = after + batchLen;
        lastGoodEnd = offset;
      }
      if (lastGoodEnd !== bytes.length) {
        truncateAndWarn(path, lastGoodEnd, bytes.length);
      }
    }
  }

  /** Absolute path to the `.hayven/crdt/` root this log writes under. */
  get root(): string {
    return this.crdtRoot;
  }

  /** Segment day-names (`YYYY-MM-DD`) for a type, sorted ascending. */
  listSegmentDays(type: CrdtType): string[] {
    const dir = join(this.crdtRoot, type);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => f.replace(/\.log$/, ""))
      .sort();
  }

  /** Absolute path to a segment file. */
  segmentPath(type: CrdtType, day: string): string {
    return join(this.crdtRoot, type, `${day}.log`);
  }

  /**
   * The set of op composite keys (28-byte `[hlc][writer]`, hex) in a segment,
   * sorted and de-duplicated. This is the order-independent identity of the
   * segment's op-set — the basis for an order-independent Merkle leaf
   * (ARCHITECTURE.md §15.1).
   *
   * BL-11: this is the `/api/sync/merkle` hot path — `merkle.ts` calls it for
   * every changed segment on every sync, and today's segment re-decodes on
   * every sync. It used to spawn `hayven-native serialize decode` ONCE PER
   * BATCH (N spawns per segment). It now hands the whole segment to the native
   * `decode-segment` subcommand in a SINGLE spawn, which reads the §14.2
   * length-prefixed frames itself and returns every op flattened. Same
   * torn-trailing-batch tolerance (the native side stops cleanly at the torn
   * tail), same op-key set out — just one process instead of N.
   */
  segmentCompositeKeys(type: CrdtType, day: string): string[] {
    const path = this.segmentPath(type, day);
    if (!existsSync(path)) return [];
    const bytes = readFileSync(path);
    let decoded: WireOp[];
    try {
      decoded = this.bridge.decodeSegment(new Uint8Array(bytes));
    } catch {
      // A whole-segment decode failure (corrupt, non-torn bytes) yields no
      // keys — the same end state the old per-batch loop reached when its
      // FIRST batch failed to decode. A torn TRAILING batch is not an error:
      // the native reader returns every complete batch and stops at the tear.
      return [];
    }
    const keys = new Set<string>();
    for (const op of decoded) keys.add(compositeKeyHex(op));
    return [...keys].sort();
  }

  /** Decode a single §13 wire batch via the op-log's bridge. Throws on
   *  malformed bytes — used by the sync push path to validate untrusted
   *  input before persisting. */
  decodeBatch(bytes: Uint8Array): WireOp[] {
    return this.bridge.decode(bytes);
  }

  /**
   * Raw bytes of a WHOLE segment file. Only for callers that genuinely need
   * every byte at once — today that is the `hayven sync` CLI's push direction,
   * which immediately splits the segment into batches. Ranged readers MUST use
   * {@link readSegmentRange} instead; see F1 there.
   */
  readSegmentBytes(type: CrdtType, day: string): Uint8Array | null {
    const path = this.segmentPath(type, day);
    if (!existsSync(path)) return null;
    return new Uint8Array(readFileSync(path));
  }

  /**
   * Read at most `maxBytes` of a segment starting at `offset`, reading ONLY
   * that window off disk.
   *
   * F1: `POST /api/sync/batch` is an unauthenticated local endpoint whose
   * whole job is paginating a segment. It used to call
   * {@link readSegmentBytes} and slice the result, so a peer walking a 500 MB
   * segment at the default 1 MiB page performed 500 full 500 MB reads — about
   * 250 GB of read I/O and 500 half-gigabyte allocations for 500 MB of actual
   * payload. That is precisely the "read 195 GB" shape of the incident this
   * pass exists to prevent, reachable from a local socket.
   *
   * Returns `null` when the segment does not exist. `size` is the segment's
   * full length (from the same `stat`) so the caller can set its EOF header
   * without a second syscall. A short read (the file was truncated under us)
   * yields fewer bytes rather than a torn buffer of zeros.
   */
  readSegmentRange(
    type: CrdtType,
    day: string,
    offset: number,
    maxBytes: number,
  ): { bytes: Uint8Array; size: number } | null {
    const path = this.segmentPath(type, day);
    if (!existsSync(path)) return null;
    const size = statSync(path).size;
    if (offset >= size || maxBytes <= 0) return { bytes: new Uint8Array(0), size };
    const want = Math.min(maxBytes, size - offset);
    // `allocUnsafeSlow`, not `allocUnsafe`: a small allocation from the pooled
    // path would return a VIEW into Node's shared 8 KiB pool, and we hand that
    // view straight to the HTTP layer as a response body. A later allocation
    // reusing the pool could then overwrite bytes we have not serialized yet.
    // Own memory, no aliasing.
    const buf = Buffer.allocUnsafeSlow(want);
    const fd = openSync(path, "r");
    let filled = 0;
    try {
      while (filled < want) {
        const n = readSync(fd, buf, filled, want - filled, offset + filled);
        if (n <= 0) break; // EOF early: the segment shrank between stat and read.
        filled += n;
      }
    } finally {
      closeSync(fd);
    }
    return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, filled), size };
  }

  /**
   * mtime + size + a cheap content discriminator for the Merkle leaf cache.
   *
   * BL-3: keying the cache on `(mtimeMs, size)` alone is unsafe on filesystems
   * with second-resolution mtime — a same-second overwrite that happens to land
   * the SAME byte length would re-serve a stale leaf hash, and two divergent
   * peers could then report equal Merkle roots and wrongly skip sync. We add
   * the segment's last (up to) 16 bytes as a content discriminator: an append
   * or torn-write rewrite changes the file tail with overwhelming probability,
   * even when mtime and size collide. This is a one tiny tail read on top of
   * the stat we already do — cheap relative to decoding the segment.
   */
  segmentStat(type: CrdtType, day: string): { mtimeMs: number; size: number; tailHex: string } | null {
    const path = this.segmentPath(type, day);
    if (!existsSync(path)) return null;
    const s = statSync(path);
    const tailLen = Math.min(16, s.size);
    let tailHex = "";
    if (tailLen > 0) {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.allocUnsafe(tailLen);
        readSync(fd, buf, 0, tailLen, s.size - tailLen);
        tailHex = buf.toString("hex");
      } finally {
        closeSync(fd);
      }
    }
    return { mtimeMs: s.mtimeMs, size: s.size, tailHex };
  }

  /**
   * Per-segment byte sizes for one CRDT type, sorted by day ascending.
   * `stat` only — never reads segment contents. Unreadable entries are
   * skipped rather than throwing: this feeds diagnostics, and a health
   * check must not be able to take the daemon down.
   */
  segmentSizes(type: CrdtType): { day: string; bytes: number }[] {
    const dir = join(this.crdtRoot, type);
    if (!existsSync(dir)) return [];
    const out: { day: string; bytes: number }[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".log")) continue;
      try {
        out.push({ day: f.replace(/\.log$/, ""), bytes: statSync(join(dir, f)).size });
      } catch {
        continue;
      }
    }
    out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return out;
  }

  /**
   * Diagnostic: total bytes on disk under `crdt/`.
   *
   * F3: this used to `readFileSync` EVERY segment just to sum `byteLength`,
   * and it runs once per project at daemon start purely to populate a log
   * field — so a daemon with a large op history read its entire CRDT history
   * off disk, at every start, for a number the inode already holds. `stat`.
   */
  diskUsage(): number {
    let total = 0;
    for (const t of TYPES) {
      for (const seg of this.segmentSizes(t)) total += seg.bytes;
    }
    return total;
  }

  private ensureOpenSegment(type: CrdtType, date: string): SegmentHandle {
    const existing = this.segments.get(type);
    if (existing && existing.date === date && existing.fd >= 0) return existing;
    if (existing && existing.fd >= 0) {
      // Date rollover: flush + close the old day's fd before opening today's.
      if (existing.pendingWrites > 0) fdatasyncSync(existing.fd);
      closeSync(existing.fd);
    }
    const path = join(this.crdtRoot, type, `${date}.log`);
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "a");
    const handle: SegmentHandle = {
      date,
      path,
      fd,
      pendingWrites: 0,
      lastFlushMs: this.now(),
    };
    this.segments.set(type, handle);
    return handle;
  }
}

const TYPES: readonly CrdtType[] = ["lww", "gset", "orset"];

/** Format a unix-ms timestamp as a UTC `YYYY-MM-DD` string. */
export function utcDate(unixMs: number): string {
  const d = new Date(unixMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * Split a segment's raw bytes into its constituent §13 batches. The sync
 * push contract is "one batch per call" — a puller that pulled a whole
 * segment must split it here before pushing, or the receiver double-frames
 * it (a single varint prefix wrapping many batches → corrupt → truncated).
 * Stops at a torn trailing batch.
 */
export function splitSegmentBatches(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const lenRead = readVarint(bytes, offset);
    if (lenRead === null) break;
    const [batchLen, after] = lenRead;
    if (after + batchLen > bytes.length) break;
    out.push(bytes.subarray(after, after + batchLen));
    offset = after + batchLen;
  }
  return out;
}

/** 28-byte `[hlc][writer]` composite key of a wire op, as lowercase hex. */
function compositeKeyHex(op: WireOp): string {
  const hlcBytes = encodeHlc({ wallMs: op.hlc.wall_ms, counter: op.hlc.counter });
  const writer: WriterId = new Uint8Array(op.writer);
  const out = new Uint8Array(hlcBytes.length + writer.length);
  out.set(hlcBytes, 0);
  out.set(writer, hlcBytes.length);
  let s = "";
  for (let i = 0; i < out.length; i++) s += (out[i] as number).toString(16).padStart(2, "0");
  return s;
}

/** LEB128 unsigned varint. */
function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`varint must be a non-negative integer, got ${value}`);
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return new Uint8Array(out);
}

/** Max value a §13 length/count varint may carry: unsigned 32-bit (2^32 − 1).
 *  Contract: must match the Rust side and ARCHITECTURE.md §13 (BL-7). */
const VARINT_U32_MAX = 4_294_967_295;

/**
 * Returns `[value, nextOffset]` or `null` if the varint is truncated (a torn
 * write — callers treat that as end-of-good-data and stop).
 *
 * BL-7: a value that exceeds u32 range is NOT a torn write — it's a malformed
 * length/count that the previous code silently truncated via `>>> 0` (so e.g.
 * 2^32 decoded as 0, then framed a bogus batch). We now THROW a clean Error
 * instead of coercing. We accumulate with arithmetic (not `<<`, which is 32-bit
 * and signed in JS) so the cap check is exact across the full u32 range.
 */
function readVarint(bytes: Uint8Array, offset: number): [number, number] | null {
  let result = 0;
  let mul = 1;
  let shift = 0;
  let i = offset;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    result += (b & 0x7f) * mul;
    i += 1;
    if ((b & 0x80) === 0) {
      if (result > VARINT_U32_MAX) {
        throw new Error(
          `varint exceeds u32 range (${result} > ${VARINT_U32_MAX}) — corrupt §13 length`,
        );
      }
      return [result, i];
    }
    mul *= 128;
    shift += 7;
    // A u32 needs at most 5 varint bytes (35 bits). A 6th continuation byte
    // can only describe a value beyond u32 → reject rather than coerce.
    if (shift >= 35) {
      throw new Error(
        `varint exceeds u32 range (more than 5 bytes) — corrupt §13 length`,
      );
    }
  }
  return null;
}

/**
 * `writeSync` may write FEWER bytes than requested (a signal, a full disk that
 * partially succeeds). A short write here leaves a torn §13 batch on disk while
 * the caller goes on to apply every op in memory — disk and memory then
 * disagree until the next hydrate truncates the tail. Loop until the buffer is
 * fully written, or throw.
 */
function writeFully(fd: number, buf: Uint8Array): void {
  let written = 0;
  while (written < buf.length) {
    const n = writeSync(fd, buf, written, buf.length - written);
    if (n <= 0) {
      throw new Error(
        `short write on CRDT segment: wrote ${written} of ${buf.length} bytes`,
      );
    }
    written += n;
  }
}

function truncateAndWarn(path: string, goodEnd: number, fileLen: number): void {
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, goodEnd);
  } finally {
    closeSync(fd);
  }
  process.stderr.write(
    `crdt_log:truncated_torn_write path=${path} dropped_bytes=${fileLen - goodEnd}\n`,
  );
}

/** Internal §13 varint framing helpers, exposed for the BL-7 cap test only.
 *  Not part of the public sync API. */
export const __varintInternals = { readVarint, encodeVarint, VARINT_U32_MAX };
