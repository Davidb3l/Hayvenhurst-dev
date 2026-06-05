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
import { openWireBridge, type WireBridge, type WireOp } from "./wire.ts";

export type CrdtType = "lww" | "gset" | "orset";

export interface OpLogOptions {
  /** Default: 32 writes between fdatasync. */
  flushEveryWrites?: number;
  /** Default: 250 ms. */
  flushEveryMs?: number;
  /** Inject a clock for tests. Returns Unix milliseconds. */
  now?: () => number;
  /** Inject a wire bridge for tests; default opens the subprocess one. */
  bridge?: WireBridge;
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

  constructor(private readonly crdtRoot: string, opts: OpLogOptions = {}) {
    this.bridge = opts.bridge ?? openWireBridge();
    this.now = opts.now ?? Date.now;
    this.flushEveryWrites = opts.flushEveryWrites ?? 32;
    this.flushEveryMs = opts.flushEveryMs ?? 250;
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
    const batch = this.bridge.encode(ops);
    return this.appendBatchBytes(type, date, batch, /* cached */ true);
  }

  /**
   * Append a pre-encoded §13 batch to the segment for `date` (a `YYYY-MM-DD`
   * string). Used by the sync push path: the puller already knows the peer
   * segment's day, and we must write to THAT day, not today, or cross-day
   * sync never converges. Opens the target file directly so it doesn't
   * disturb the cached fd used for local same-day writes.
   */
  appendRawBatchToDate(type: CrdtType, date: string, batch: Uint8Array): number {
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
        writeSync(fd, buf, 0, buf.length);
        fdatasyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return buf.length;
    }

    const seg = this.ensureOpenSegment(type, date);
    writeSync(seg.fd, buf, 0, buf.length);
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
    return buf.length;
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

  /** Raw bytes of a segment file (for the sync `/api/sync/batch` transport). */
  readSegmentBytes(type: CrdtType, day: string): Uint8Array | null {
    const path = this.segmentPath(type, day);
    if (!existsSync(path)) return null;
    return new Uint8Array(readFileSync(path));
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

  /** Diagnostic: total bytes on disk under `crdt/`. */
  diskUsage(): number {
    let total = 0;
    for (const t of TYPES) {
      const dir = join(this.crdtRoot, t);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".log")) continue;
        total += readFileSync(join(dir, f)).byteLength;
      }
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
