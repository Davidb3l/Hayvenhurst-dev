// Hybrid Logical Clock and writer-ID primitives. Single source of truth for
// the byte layout and comparison rules described in ARCHITECTURE.md §11.
//
// Both types are byte-comparable in big-endian unsigned order, which means
// the 28-byte composite key `[hlc(12)][writer(16)]` sorts correctly with a
// single `Buffer.compare`. The wire serializer in hayven-native depends on
// that property.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const HLC_BYTES = 12;
export const WRITER_BYTES = 16;
export const COMPOSITE_BYTES = HLC_BYTES + WRITER_BYTES;

const COUNTER_MAX = 0xffff;

export interface Hlc {
  readonly wallMs: number;
  readonly counter: number;
}

export type WriterId = Uint8Array;

export class HlcError extends Error {
  override readonly name = "HlcError";
}

/** Build a 12-byte HLC encoding. Throws on out-of-range inputs. */
export function encodeHlc(hlc: Hlc): Uint8Array {
  if (!Number.isInteger(hlc.wallMs) || hlc.wallMs < 0 || hlc.wallMs > Number.MAX_SAFE_INTEGER) {
    throw new HlcError(`wallMs out of range: ${hlc.wallMs}`);
  }
  if (!Number.isInteger(hlc.counter) || hlc.counter < 0 || hlc.counter > COUNTER_MAX) {
    throw new HlcError(`counter out of range: ${hlc.counter}`);
  }
  const buf = new Uint8Array(HLC_BYTES);
  const view = new DataView(buf.buffer);
  // `wallMs` fits in 53 bits (MAX_SAFE_INTEGER), well under uint64 range.
  // Encode by splitting into hi/lo 32-bit halves to avoid BigInt overhead.
  const hi = Math.floor(hlc.wallMs / 0x1_0000_0000);
  const lo = hlc.wallMs >>> 0;
  view.setUint32(0, hi, false);
  view.setUint32(4, lo, false);
  view.setUint16(8, hlc.counter, false);
  // Bytes 10-11 are reserved and MUST be zero.
  return buf;
}

/** Parse a 12-byte HLC encoding. Throws on length mismatch or non-zero reserved bytes. */
export function decodeHlc(bytes: Uint8Array): Hlc {
  if (bytes.length !== HLC_BYTES) {
    throw new HlcError(`hlc must be ${HLC_BYTES} bytes, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hi = view.getUint32(0, false);
  const lo = view.getUint32(4, false);
  const wallMs = hi * 0x1_0000_0000 + lo;
  const counter = view.getUint16(8, false);
  const reserved = view.getUint16(10, false);
  if (reserved !== 0) {
    throw new HlcError(`reserved HLC bytes must be zero, got 0x${reserved.toString(16)}`);
  }
  return { wallMs, counter };
}

/** Big-endian unsigned compare on two HLC values. -1 | 0 | 1. */
export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1 {
  if (a.wallMs !== b.wallMs) return a.wallMs < b.wallMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return 0;
}

/** Unsigned big-endian byte compare on two writer IDs. -1 | 0 | 1. */
export function compareWriter(a: WriterId, b: WriterId): -1 | 0 | 1 {
  if (a.length !== WRITER_BYTES || b.length !== WRITER_BYTES) {
    throw new HlcError(`writer id must be ${WRITER_BYTES} bytes`);
  }
  for (let i = 0; i < WRITER_BYTES; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/** Total order: HLC first, writer ID as tiebreaker. -1 | 0 | 1. */
export function compareComposite(
  ah: Hlc,
  aw: WriterId,
  bh: Hlc,
  bw: WriterId,
): -1 | 0 | 1 {
  const h = compareHlc(ah, bh);
  if (h !== 0) return h;
  return compareWriter(aw, bw);
}

/** 28-byte composite key `[hlc][writer]`. Big-endian-compare-friendly. */
export function encodeComposite(hlc: Hlc, writer: WriterId): Uint8Array {
  if (writer.length !== WRITER_BYTES) {
    throw new HlcError(`writer id must be ${WRITER_BYTES} bytes`);
  }
  const out = new Uint8Array(COMPOSITE_BYTES);
  out.set(encodeHlc(hlc), 0);
  out.set(writer, HLC_BYTES);
  return out;
}

/**
 * HLC generator. Monotonic per replica: emitted HLCs never decrease over the
 * lifetime of the instance, even when the wall clock jumps backwards or a
 * remote HLC has already advanced past us.
 */
export class HlcGenerator {
  private last: Hlc;
  private readonly now: () => number;

  constructor(opts: { now?: () => number; seed?: Hlc } = {}) {
    this.now = opts.now ?? Date.now;
    this.last = opts.seed ?? { wallMs: 0, counter: 0 };
  }

  /** Emit a fresh HLC. */
  tick(): Hlc {
    const wall = this.now();
    if (wall > this.last.wallMs) {
      this.last = { wallMs: wall, counter: 0 };
      return this.last;
    }
    // Same or behind the wall clock: bump the counter. On counter overflow,
    // advance the logical wall_ms by 1 rather than throwing. This keeps the
    // clock monotonic without a hard failure and, crucially, absorbs the
    // case where `observe()` adopted a remote HLC at counter=0xffff — a
    // single remote value must not be able to wedge a replica (M2). True
    // 65535-ticks-in-a-ms saturation just nudges logical time forward 1 ms.
    if (this.last.counter >= COUNTER_MAX) {
      this.last = { wallMs: this.last.wallMs + 1, counter: 0 };
      return this.last;
    }
    this.last = { wallMs: this.last.wallMs, counter: this.last.counter + 1 };
    return this.last;
  }

  /**
   * Update the local clock after receiving a remote HLC. Per the §11.4 skew
   * absorption rule, the local clock advances to max(local, remote) so the
   * next `tick()` is guaranteed to dominate everything we have ever seen.
   */
  observe(remote: Hlc): void {
    if (compareHlc(remote, this.last) === 1) {
      // Keep our counter at the remote counter so the next local tick is
      // strictly greater than the observed remote — this is the standard
      // HLC merge rule and the one that absorbs forward skew correctly.
      this.last = { wallMs: remote.wallMs, counter: remote.counter };
    }
  }

  /** Read-only view of the last emitted/observed HLC. */
  peek(): Hlc {
    return this.last;
  }
}

// ─── Writer ID ───────────────────────────────────────────────────────────────

/** Generate a fresh 16-byte writer ID using `crypto.getRandomValues`. */
export function generateWriterId(): WriterId {
  const out = new Uint8Array(WRITER_BYTES);
  crypto.getRandomValues(out);
  return out;
}

/** 32-char lowercase hex string. The canonical persistence form. */
export function writerIdToHex(id: WriterId): string {
  if (id.length !== WRITER_BYTES) throw new HlcError(`writer id must be ${WRITER_BYTES} bytes`);
  let s = "";
  for (let i = 0; i < WRITER_BYTES; i++) {
    s += (id[i] as number).toString(16).padStart(2, "0");
  }
  return s;
}

export function writerIdFromHex(hex: string): WriterId {
  if (typeof hex !== "string" || hex.length !== WRITER_BYTES * 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new HlcError(`writer id hex must be ${WRITER_BYTES * 2} lowercase hex chars`);
  }
  const out = new Uint8Array(WRITER_BYTES);
  for (let i = 0; i < WRITER_BYTES; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Load the per-daemon writer ID from `.hayven/config.json`, generating and
 * persisting a fresh one on first call. Idempotent across processes — the
 * read/write is small enough that we accept the (vanishingly small) race
 * window during initial daemon startup.
 */
export function loadOrCreateWriterId(configFile: string): WriterId {
  let cfg: Record<string, unknown> = {};
  if (existsSync(configFile)) {
    try {
      const parsed = JSON.parse(readFileSync(configFile, "utf8"));
      if (parsed && typeof parsed === "object") cfg = parsed as Record<string, unknown>;
    } catch {
      // Tolerate a malformed config: we fall through to write a fresh one.
      cfg = {};
    }
  }
  const existing = cfg["writer_id"];
  if (typeof existing === "string" && existing.length === WRITER_BYTES * 2) {
    try {
      return writerIdFromHex(existing);
    } catch {
      // Bad hex — regenerate. The user-supplied config is otherwise preserved.
    }
  }
  const fresh = generateWriterId();
  cfg["writer_id"] = writerIdToHex(fresh);
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return fresh;
}
