// Wire-format bridge to the Rust serializer in hayven-native.
// ARCHITECTURE.md §13.5.
//
// We try `bun:ffi` against the cdylib first; if dlopen fails (e.g., dev
// mode where only the binary was built) we fall back to spawning the
// `hayven-native serialize encode|decode` subcommand. The wire bytes are
// identical either way — the spec lives in the Rust module, not here.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FFIType,
  type dlopen,
  type Pointer,
  type ptr,
  type toArrayBuffer,
} from "bun:ffi";

// `bun:ffi` is statically importable under Bun (the only runtime the daemon
// targets). We capture the runtime functions behind a guarded reference so a
// non-Bun runtime — or a Bun build without FFI — degrades to the subprocess
// path instead of crashing at module load. `tryOpenFfi` treats `undefined`
// here as "FFI unavailable → fall back."
const bunFfi: { dlopen: typeof dlopen; ptr: typeof ptr; toArrayBuffer: typeof toArrayBuffer } | null =
  (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("bun:ffi") as {
        dlopen: typeof dlopen;
        ptr: typeof ptr;
        toArrayBuffer: typeof toArrayBuffer;
      };
      return { dlopen: mod.dlopen, ptr: mod.ptr, toArrayBuffer: mod.toArrayBuffer };
    } catch {
      return null;
    }
  })();

import { decodeHlc, encodeHlc, type Hlc, type WriterId } from "./hlc.ts";
import type { LwwOp } from "./lww.ts";
import type { GsetOp } from "./gset.ts";
import type { OrOp } from "./orset.ts";
import { EXPECTED_NATIVE_MAJOR } from "../version.ts";

export type WireOp =
  | { kind: "lww"; entity_id: string; content_hash: number[]; body: number[]; hlc: WireHlc; writer: number[] }
  | { kind: "gset_observe"; src: string; dst: string; ts_bucket: number; observed: number; weight: number; hlc: WireHlc; writer: number[] }
  | { kind: "or_add"; claim_id: string; agent: string; payload_cbor: number[]; hlc: WireHlc; writer: number[] }
  | { kind: "or_remove"; claim_id: string; observed_tags: number[]; hlc: WireHlc; writer: number[] };

interface WireHlc {
  wall_ms: number;
  counter: number;
}

// ─── Converters: logical ops ⇄ wire ops ─────────────────────────────────────

function hlcToWire(h: Hlc): WireHlc {
  return { wall_ms: h.wallMs, counter: h.counter };
}

function bytesToArray(b: Uint8Array): number[] {
  return Array.from(b);
}

export function lwwToWire<T>(op: LwwOp<T>): WireOp {
  const body = typeof op.value === "string"
    ? new TextEncoder().encode(op.value)
    : new TextEncoder().encode(JSON.stringify(op.value));
  return {
    kind: "lww",
    entity_id: op.entityId,
    content_hash: bytesToArray(op.contentHash),
    body: bytesToArray(body),
    hlc: hlcToWire(op.hlc),
    writer: bytesToArray(op.writer),
  };
}

export function gsetToWire(op: GsetOp): WireOp {
  return {
    kind: "gset_observe",
    src: op.src,
    dst: op.dst,
    ts_bucket: op.tsBucket,
    observed: op.observed,
    weight: op.weight,
    hlc: hlcToWire(op.hlc),
    writer: bytesToArray(op.writer),
  };
}

export function orToWire(op: OrOp): WireOp {
  if (op.kind === "add") {
    // Minimal canonical CBOR for the payload (3-element map). We hand-roll
    // it to avoid a CBOR dependency — the daemon-style preference for thin
    // dependencies. The exact encoding doesn't matter for correctness;
    // round-tripping through Rust treats `payload_cbor` as an opaque blob.
    const payloadJson = new TextEncoder().encode(JSON.stringify(op.payload));
    return {
      kind: "or_add",
      claim_id: op.claimId,
      agent: op.agent,
      payload_cbor: Array.from(payloadJson),
      hlc: hlcToWire(op.hlc),
      writer: bytesToArray(op.writer),
    };
  }
  const tagBytes: number[] = [];
  for (const tag of op.observedTags) {
    if (tag.length !== 56) throw new Error(`tag must be 56-hex chars, got ${tag.length}`);
    for (let i = 0; i < 28; i++) {
      tagBytes.push(parseInt(tag.slice(i * 2, i * 2 + 2), 16));
    }
  }
  return {
    kind: "or_remove",
    claim_id: op.claimId,
    observed_tags: tagBytes,
    hlc: hlcToWire(op.hlc),
    writer: bytesToArray(op.writer),
  };
}

// Wire op → logical Hlc (used by the convergence-on-FFI tests).
export function wireHlc(w: WireHlc): Hlc {
  return { wallMs: w.wall_ms, counter: w.counter };
}

// ─── Encoder/decoder entry points ───────────────────────────────────────────

export interface WireBridge {
  encode(ops: WireOp[]): Uint8Array;
  decode(bytes: Uint8Array): WireOp[];
  /**
   * BL-11: decode a whole §14.2 segment (a concatenation of length-prefixed
   * §13 batches) in ONE call, returning every op flattened in file order.
   * Lets the segment-decode hot path (`OpLog.segmentCompositeKeys`,
   * `merkle.ts`) spend one subprocess spawn per segment instead of one per
   * batch. Tolerant of a torn trailing batch, exactly like the per-batch
   * reader loop it replaces. `segmentBytes` is the raw segment-file contents.
   */
  decodeSegment(segmentBytes: Uint8Array): WireOp[];
  /** "ffi" or "subprocess" — exposed for diagnostics + tests. */
  readonly transport: "ffi" | "subprocess";
}

/**
 * Open the FFI bridge, falling back to subprocess. Caller decides which one
 * to keep alive — typical usage is one bridge per daemon process.
 *
 * The FFI path is OPT-IN behind `HAYVEN_FFI` and SELF-DISABLING: any failure
 * to load the cdylib, resolve a symbol, or match the ABI major version makes
 * `tryOpenFfi` return null and the daemon transparently uses the subprocess
 * transport (the stable production default). The wire bytes are byte-identical
 * either way — both paths drive the SAME Rust `OpRecord` serde codec; FFI just
 * skips the per-call process spawn. The env override `HAYVEN_FFI_LIB` forces a
 * specific cdylib path (mainly for the per-platform CI matrix and tests).
 */
export function openWireBridge(opts: { cdylibPath?: string; binaryPath?: string } = {}): WireBridge {
  if (ffiEnabled()) {
    const ffi = tryOpenFfi(opts.cdylibPath);
    if (ffi !== null) return ffi;
  }
  return openSubprocessBridge(opts.binaryPath);
}

/** FFI is opt-in: off unless `HAYVEN_FFI` is a truthy ("1"/"true"/"yes") flag. */
function ffiEnabled(): boolean {
  const v = (process.env["HAYVEN_FFI"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// The four C ABI codec/handshake symbols (ARCHITECTURE.md §13.5). Encode,
// decode, and decode-segment all share the same (in_ptr, in_len, *out_ptr,
// *out_len) -> i32 shape; `free` reclaims a returned buffer; `abi_major`
// returns the cdylib's crate major version for the version handshake.
const FFI_SYMBOLS = {
  hayven_crdt_encode_batch: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  hayven_crdt_decode_batch: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  hayven_crdt_decode_segment: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  hayven_crdt_free: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.void,
  },
  hayven_crdt_abi_major: {
    args: [],
    returns: FFIType.u32,
  },
} as const;

// C ABI status codes, mirrored from native/src/serialize/ffi.rs.
const FFI_OK = 0;

/**
 * Try to open the cdylib via `bun:ffi` and return an FFI-backed `WireBridge`.
 * Returns null (→ subprocess fallback) on ANY failure: bun:ffi unavailable,
 * library not found, a missing/renamed symbol, or an ABI major-version skew.
 * It NEVER throws — a broken FFI environment must not break a CRDT round-trip.
 */
function tryOpenFfi(cdylibPath?: string): WireBridge | null {
  // `bun:ffi` may be unavailable (non-Bun runtime / no-FFI build); degrade to
  // the subprocess path rather than crash.
  if (!bunFfi) return null;
  const { dlopen: dlopenFn, ptr: ptrFn, toArrayBuffer: toArrayBufferFn } = bunFfi;
  if (!dlopenFn || !ptrFn || !toArrayBufferFn) return null;

  const libPath = resolveCdylibPath(cdylibPath);
  if (libPath === null) return null;

  const lib = (() => {
    try {
      return dlopenFn(libPath, FFI_SYMBOLS);
    } catch {
      // dlopen failure or a missing/renamed symbol — fall back silently.
      return null;
    }
  })();
  if (lib === null) return null;
  const symbols = lib.symbols;
  const close = (): void => {
    try {
      lib.close();
    } catch {
      /* ignore */
    }
  };

  // Version handshake: refuse a major-skewed cdylib, exactly as the subprocess
  // transport refuses a major-skewed `version` NDJSON record (§16.4). On any
  // surprise we close the lib and fall back rather than risk garbage bytes.
  try {
    const major = Number(symbols.hayven_crdt_abi_major());
    if (!Number.isFinite(major) || major !== EXPECTED_NATIVE_MAJOR) {
      close();
      return null;
    }
  } catch {
    close();
    return null;
  }

  // `out` holds the two return-by-pointer values the C ABI writes: a pointer
  // (`*mut u8`, slot 0) and a length (`usize`, slot 1). We pass `ptr(out)` and
  // `ptr(out) + 8` as the two out-arg pointers. 64-bit slots keep the layout
  // identical on 32/64-bit pointer + usize targets we ship.
  type CodecFn = (
    inPtr: Pointer,
    inLen: number | bigint,
    outPtr: Pointer,
    outLenPtr: Pointer,
  ) => number;
  const callCodec = (fn: CodecFn, input: Uint8Array): Uint8Array => {
    const out = new BigUint64Array(2); // [out_ptr, out_len]
    const outPtr = ptrFn(out);
    // `ptr(input)` is invalid for a zero-length view; pass a 1-byte scratch so
    // the pointer is non-null and Rust sees in_len === 0 (an allowed empty
    // input). Rust's `from_raw_parts(ptr, 0)` never dereferences it.
    const inForPtr = input.byteLength === 0 ? EMPTY_SCRATCH : input;
    const inPtr = ptrFn(inForPtr);
    // bun pointers are JS numbers (a branded `Pointer`); the second out-arg
    // pointer is the same backing buffer advanced by 8 bytes (one u64 slot).
    const outPtrNum = outPtr as unknown as number;
    const rc = fn(
      inPtr,
      input.byteLength,
      outPtr,
      (outPtrNum + 8) as unknown as Pointer,
    );
    if (rc !== FFI_OK) {
      throw new Error(`hayven_crdt FFI call failed with status ${rc}`);
    }
    const retPtrNum = Number(out[0]!); // *out_ptr
    const retLen = Number(out[1]!); // *out_len
    if (retPtrNum === 0 || retLen === 0) {
      // (null, 0) sentinel — a legitimately empty result (e.g. decode of an
      // empty op array). Nothing was allocated, nothing to free.
      return new Uint8Array(0);
    }
    const retPtr = retPtrNum as unknown as Pointer;
    try {
      // Rust owns this buffer until we free it. Copy the bytes into a
      // JS-owned Uint8Array, THEN hand the memory back — never retain a view
      // into freed Rust memory.
      const view = new Uint8Array(toArrayBufferFn(retPtr, 0, retLen));
      const copy = new Uint8Array(retLen);
      copy.set(view);
      return copy;
    } finally {
      symbols.hayven_crdt_free(retPtr, retLen);
    }
  };

  return {
    transport: "ffi",
    encode(ops: WireOp[]): Uint8Array {
      const input = new TextEncoder().encode(JSON.stringify(ops));
      return callCodec(symbols.hayven_crdt_encode_batch as unknown as CodecFn, input);
    },
    decode(bytes: Uint8Array): WireOp[] {
      const json = callCodec(symbols.hayven_crdt_decode_batch as unknown as CodecFn, bytes);
      if (json.byteLength === 0) return [];
      return JSON.parse(new TextDecoder().decode(json)) as WireOp[];
    },
    decodeSegment(segmentBytes: Uint8Array): WireOp[] {
      // BL-11 over FFI: the cdylib exports a dedicated segment decoder
      // (`hayven_crdt_decode_segment`), so the whole §14.2 segment is decoded
      // in ONE FFI call — no subprocess, byte-identical flat op list.
      const json = callCodec(symbols.hayven_crdt_decode_segment as unknown as CodecFn, segmentBytes);
      if (json.byteLength === 0) return [];
      return JSON.parse(new TextDecoder().decode(json)) as WireOp[];
    },
  };
}

/** 1-byte non-empty scratch so `ptr()` of a zero-length input is still valid. */
const EMPTY_SCRATCH = new Uint8Array(1);

/**
 * Resolve the cdylib path: explicit arg → `HAYVEN_FFI_LIB` env → the platform
 * artifact under the native target dir (release then debug). Returns null if
 * none exists, so `tryOpenFfi` falls back to subprocess.
 */
function resolveCdylibPath(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const envLib = process.env["HAYVEN_FFI_LIB"];
  if (envLib) return existsSync(envLib) ? envLib : null;
  const here = typeof import.meta.url === "string"
    ? dirname(fileURLToPath(import.meta.url))
    : process.cwd();
  const name = cdylibFileName();
  if (name === null) return null;
  const candidates = [
    join(here, "../../../native/target/release", name),
    join(here, "../../../native/target/debug", name),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Platform-specific cdylib filename for the `hayven_native` crate. */
function cdylibFileName(): string | null {
  switch (process.platform) {
    case "darwin":
      return "libhayven_native.dylib";
    case "win32":
      return "hayven_native.dll";
    default:
      return "libhayven_native.so"; // linux + other unixes
  }
}

function openSubprocessBridge(binaryPath?: string): WireBridge {
  const bin = binaryPath ?? defaultBinaryPath();
  // §16.4: the serialize subcommand emits its `version` record on STDERR
  // (stdout is the binary payload). We check it once per bridge — a
  // major-skewed binary would otherwise silently produce garbage wire bytes.
  let versionChecked = false;
  const checkVersionOnce = (stderr: Buffer | Uint8Array | null): void => {
    if (versionChecked) return;
    versionChecked = true;
    assertSerializeVersion(stderr);
  };
  return {
    transport: "subprocess",
    encode(ops: WireOp[]): Uint8Array {
      const input = JSON.stringify(ops);
      // Default encoding is `null` → stdout/stderr are returned as Buffers,
      // which is what we want for the raw binary envelope.
      const res = spawnSync(bin, ["serialize", "encode"], { input });
      if (res.status !== 0) {
        const err = res.stderr ? Buffer.from(res.stderr).toString("utf8") : "<no stderr>";
        throw new Error(`hayven-native serialize encode failed (${res.status}): ${err}`);
      }
      checkVersionOnce(res.stderr);
      return new Uint8Array(res.stdout);
    },
    decode(bytes: Uint8Array): WireOp[] {
      const res = spawnSync(bin, ["serialize", "decode"], {
        input: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      });
      if (res.status !== 0) {
        const err = res.stderr ? Buffer.from(res.stderr).toString("utf8") : "<no stderr>";
        throw new Error(`hayven-native serialize decode failed (${res.status}): ${err}`);
      }
      checkVersionOnce(res.stderr);
      return JSON.parse(Buffer.from(res.stdout).toString("utf8")) as WireOp[];
    },
    decodeSegment(segmentBytes: Uint8Array): WireOp[] {
      // BL-11: ONE spawn for the whole segment. The native `decode-segment`
      // subcommand reads the length-prefixed §14.2 frames itself and returns
      // every op as a single flat JSON array — the same shape `decode` emits
      // per batch, concatenated in file order.
      const res = spawnSync(bin, ["serialize", "decode-segment"], {
        input: Buffer.from(
          segmentBytes.buffer,
          segmentBytes.byteOffset,
          segmentBytes.byteLength,
        ),
      });
      if (res.status !== 0) {
        const err = res.stderr ? Buffer.from(res.stderr).toString("utf8") : "<no stderr>";
        throw new Error(`hayven-native serialize decode-segment failed (${res.status}): ${err}`);
      }
      checkVersionOnce(res.stderr);
      return JSON.parse(Buffer.from(res.stdout).toString("utf8")) as WireOp[];
    },
  };
}

/**
 * Validate the `version` NDJSON record the serialize subcommand prints on its
 * first stderr line. Throws on a major-version mismatch (§16.4). A missing or
 * unparseable line is tolerated — old 0.0.1 binaries didn't emit one, and the
 * encode/decode round-trip would fail loudly anyway if the format diverged.
 */
function assertSerializeVersion(stderr: Buffer | Uint8Array | null): void {
  if (!stderr || stderr.length === 0) return;
  const firstLine = Buffer.from(stderr).toString("utf8").split("\n", 1)[0] ?? "";
  let rec: { type?: unknown; major?: unknown };
  try {
    rec = JSON.parse(firstLine);
  } catch {
    return; // not a version line (old binary / unexpected noise) — tolerate
  }
  if (rec.type !== "version" || typeof rec.major !== "number") return;
  if (rec.major !== EXPECTED_NATIVE_MAJOR) {
    throw new Error(
      `hayven-native serialize version skew: daemon expects ${EXPECTED_NATIVE_MAJOR}.x, ` +
        `native reports major ${rec.major} — refusing to use a mismatched serializer. ` +
        `Fix: run \`hayven doctor\` or reinstall the matched pair.`,
    );
  }
}

function defaultBinaryPath(): string {
  const envBin = process.env["HAYVEN_NATIVE_BIN"];
  if (envBin && existsSync(envBin)) return envBin;
  const here = typeof import.meta.url === "string"
    ? dirname(fileURLToPath(import.meta.url))
    : process.cwd();
  const candidates = [
    join(here, "../../../native/target/release/hayven-native"),
    join(here, "../../../native/target/debug/hayven-native"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "hayven-native";
}

// ─── HLC encode helper re-export ────────────────────────────────────────────
// Convenience for callers building wire HLCs by hand (mostly tests).
export { encodeHlc, decodeHlc };
