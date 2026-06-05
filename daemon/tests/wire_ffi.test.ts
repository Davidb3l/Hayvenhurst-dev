// Bun FFI direct-dlopen transport for the CRDT wire bridge.
//
// The subprocess transport (`hayven-native serialize encode|decode`) is the
// stable production default; the FFI transport is opt-in behind `HAYVEN_FFI`
// and must be BYTE-IDENTICAL to it. These tests prove three things:
//
//   1. With `HAYVEN_FFI=1` and a loadable cdylib, the bridge selects the FFI
//      transport AND produces output byte-identical to the subprocess bridge
//      for encode, decode, and decodeSegment (BL-11).
//   2. With FFI off (the default) — or a missing library — the bridge falls
//      back to the subprocess transport and still works.
//   3. A forced dlopen failure (bad `HAYVEN_FFI_LIB`) falls back cleanly.
//
// Skipped entirely if neither the native binary nor the cdylib is built; CI
// builds both on every push.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { encodeHlc, type Hlc } from "../src/crdt/hlc.ts";
import { bucketize, type GsetOp } from "../src/crdt/gset.ts";
import type { LwwOp } from "../src/crdt/lww.ts";
import type { OrAddOp, OrRemoveOp } from "../src/crdt/orset.ts";
import {
  gsetToWire,
  lwwToWire,
  openWireBridge,
  orToWire,
  type WireOp,
} from "../src/crdt/wire.ts";

const here = import.meta.dir;

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  const candidates = [
    join(here, "../../native/target/release/hayven-native"),
    join(here, "../../native/target/debug/hayven-native"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function cdylibName(): string {
  switch (process.platform) {
    case "darwin":
      return "libhayven_native.dylib";
    case "win32":
      return "hayven_native.dll";
    default:
      return "libhayven_native.so";
  }
}

function findCdylib(): string | null {
  const env = process.env["HAYVEN_FFI_LIB"];
  if (env && existsSync(env)) return env;
  const name = cdylibName();
  const candidates = [
    join(here, "../../native/target/release", name),
    join(here, "../../native/target/debug", name),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

const bin = findBinary();
const lib = findCdylib();

// We need BOTH transports to compare them. If either artifact is missing, skip.
const canRun = bin !== null && lib !== null;
const maybeDescribe = canRun ? describe : describe.skip;

const W = (n: number) => {
  const w = new Uint8Array(16);
  w.fill(n);
  return w;
};
const H = (wallMs: number, counter = 0): Hlc => ({ wallMs, counter });

// A representative mixed batch exercising every op kind + the string table.
function sampleOps(): WireOp[] {
  const gset: GsetOp[] = [
    {
      kind: "observe",
      src: "auth/login_handler",
      dst: "auth/validate_session",
      tsBucket: bucketize(1_700_000_000),
      observed: 5,
      weight: 500,
      hlc: H(1_700_000_000_001, 0),
      writer: W(0x42),
    },
    {
      kind: "observe",
      src: "auth/login_handler",
      dst: "auth/log_audit",
      tsBucket: bucketize(1_700_000_000),
      observed: 1,
      weight: 100,
      hlc: H(1_700_000_000_002, 0),
      writer: W(0x42),
    },
  ];
  const lww: LwwOp<string> = {
    kind: "lww",
    entityId: "auth/login",
    value: "# auth/login\n\nrefactored summary",
    contentHash: new Uint8Array(32).fill(0xaa),
    hlc: H(2_000_000, 3),
    writer: W(0x11),
  };
  const addOp: OrAddOp = {
    kind: "add",
    claimId: "c1",
    agent: "agent-x",
    payload: {
      intent: "refactor",
      scope: ["auth/login"],
      fingerprint: "abc",
      createdMs: 1,
      ttlMs: 600_000,
    },
    hlc: H(10),
    writer: W(0x33),
  };
  const removeOp: OrRemoveOp = {
    kind: "remove",
    claimId: "c1",
    observedTags: ["00".repeat(28), "ff".repeat(28)],
    hlc: H(11),
    writer: W(0x33),
  };
  return [
    ...gset.map(gsetToWire),
    lwwToWire(lww),
    orToWire(addOp),
    orToWire(removeOp),
  ];
}

/** A varint length prefix, matching `OpLog.appendBatchBytes` framing (§14.2). */
function writeVarint(out: number[], v: number): void {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/** Frame several encoded batches into one segment (§14.2 layout). */
function frameSegment(batches: Uint8Array[]): Uint8Array {
  const out: number[] = [];
  for (const b of batches) {
    writeVarint(out, b.byteLength);
    for (const byte of b) out.push(byte);
  }
  return new Uint8Array(out);
}

// Env scrubbing: every test sets the env it needs and restores afterward, so
// the suite never leaks `HAYVEN_FFI` into the other (default-subprocess) suites.
let savedFfi: string | undefined;
let savedLib: string | undefined;
beforeEach(() => {
  savedFfi = process.env["HAYVEN_FFI"];
  savedLib = process.env["HAYVEN_FFI_LIB"];
});
afterEach(() => {
  if (savedFfi === undefined) delete process.env["HAYVEN_FFI"];
  else process.env["HAYVEN_FFI"] = savedFfi;
  if (savedLib === undefined) delete process.env["HAYVEN_FFI_LIB"];
  else process.env["HAYVEN_FFI_LIB"] = savedLib;
});

maybeDescribe("CRDT wire bridge: FFI transport vs. subprocess", () => {
  test("HAYVEN_FFI=1 + loadable cdylib selects the FFI transport", () => {
    process.env["HAYVEN_FFI"] = "1";
    const bridge = openWireBridge({ cdylibPath: lib!, binaryPath: bin! });
    expect(bridge.transport).toBe("ffi");
  });

  test("FFI off (default) selects the subprocess transport", () => {
    delete process.env["HAYVEN_FFI"];
    const bridge = openWireBridge({ cdylibPath: lib!, binaryPath: bin! });
    expect(bridge.transport).toBe("subprocess");
  });

  test("encode is byte-identical across FFI and subprocess", () => {
    process.env["HAYVEN_FFI"] = "1";
    const ffi = openWireBridge({ cdylibPath: lib!, binaryPath: bin! });
    delete process.env["HAYVEN_FFI"];
    const sub = openWireBridge({ binaryPath: bin! });
    expect(ffi.transport).toBe("ffi");
    expect(sub.transport).toBe("subprocess");

    const ops = sampleOps();
    const ffiBytes = ffi.encode(ops);
    const subBytes = sub.encode(ops);
    // The serializer lives in Rust; both transports drive the SAME codec, so
    // the produced envelope must be byte-for-byte identical.
    expect(Array.from(ffiBytes)).toEqual(Array.from(subBytes));
  });

  test("decode is identical across FFI and subprocess", () => {
    process.env["HAYVEN_FFI"] = "1";
    const ffi = openWireBridge({ cdylibPath: lib!, binaryPath: bin! });
    delete process.env["HAYVEN_FFI"];
    const sub = openWireBridge({ binaryPath: bin! });

    const ops = sampleOps();
    const bytes = sub.encode(ops);
    const ffiOut = ffi.decode(bytes);
    const subOut = sub.decode(bytes);
    expect(ffiOut).toEqual(subOut);
    // And the decode round-trips back to the original logical ops.
    expect(ffiOut).toEqual(ops);
  });

  test("decodeSegment (BL-11) is identical across FFI and subprocess", () => {
    process.env["HAYVEN_FFI"] = "1";
    const ffi = openWireBridge({ cdylibPath: lib!, binaryPath: bin! });
    delete process.env["HAYVEN_FFI"];
    const sub = openWireBridge({ binaryPath: bin! });
    expect(ffi.transport).toBe("ffi");

    // Three distinct batches, each its own envelope + string table, framed
    // into one segment exactly like a day's append-only log.
    const batch1 = sampleOps().slice(0, 2);
    const batch2 = sampleOps().slice(2, 3);
    const batch3 = sampleOps().slice(3);
    const segment = frameSegment([
      sub.encode(batch1),
      sub.encode(batch2),
      sub.encode(batch3),
    ]);

    const ffiOut = ffi.decodeSegment(segment);
    const subOut = sub.decodeSegment(segment);
    expect(ffiOut).toEqual(subOut);
    // Flat op list in file order == concatenation of the three batches.
    expect(ffiOut).toEqual([...batch1, ...batch2, ...batch3]);
  });

  test("decodeSegment tolerates a torn trailing batch identically", () => {
    process.env["HAYVEN_FFI"] = "1";
    const ffi = openWireBridge({ cdylibPath: lib!, binaryPath: bin! });
    delete process.env["HAYVEN_FFI"];
    const sub = openWireBridge({ binaryPath: bin! });

    const good = sampleOps().slice(0, 2);
    const torn = sampleOps().slice(0, 1);
    const full = frameSegment([sub.encode(good), sub.encode(torn)]);
    // Chop the last 3 bytes — simulate an fdatasync that landed mid-write.
    const segment = full.slice(0, full.byteLength - 3);

    const ffiOut = ffi.decodeSegment(segment);
    const subOut = sub.decodeSegment(segment);
    expect(ffiOut).toEqual(subOut);
    expect(ffiOut).toEqual(good); // only the complete batch survives
  });

  test("empty batch round-trips identically across transports", () => {
    process.env["HAYVEN_FFI"] = "1";
    const ffi = openWireBridge({ cdylibPath: lib!, binaryPath: bin! });
    delete process.env["HAYVEN_FFI"];
    const sub = openWireBridge({ binaryPath: bin! });

    const ffiBytes = ffi.encode([]);
    const subBytes = sub.encode([]);
    expect(Array.from(ffiBytes)).toEqual(Array.from(subBytes));
    expect(ffi.decode(ffiBytes)).toEqual([]);
    expect(sub.decode(subBytes)).toEqual([]);
  });

  test("a forced dlopen failure (bad HAYVEN_FFI_LIB) falls back cleanly", () => {
    process.env["HAYVEN_FFI"] = "1";
    // Point at a path that does not exist → resolveCdylibPath returns null →
    // tryOpenFfi returns null → subprocess fallback. Must not throw.
    const bogus = join(here, "does-not-exist-libhayven_native.dylib");
    const bridge = openWireBridge({ cdylibPath: bogus, binaryPath: bin! });
    expect(bridge.transport).toBe("subprocess");
    // And it still works end-to-end.
    const ops = sampleOps();
    expect(bridge.decode(bridge.encode(ops))).toEqual(ops);
  });

  test("HLC reserved bytes encode as zero (TS encoder conformance)", () => {
    const hlcBytes = encodeHlc({ wallMs: 1_700_000_000_000, counter: 12345 });
    expect(hlcBytes[10]).toBe(0);
    expect(hlcBytes[11]).toBe(0);
  });
});
