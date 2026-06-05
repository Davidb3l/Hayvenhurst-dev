// Cross-language round-trip tests for the CRDT wire format. The TypeScript
// daemon hands logical ops to the Rust serializer through the wire bridge,
// then asks the same Rust serializer to decode them back. Equivalent to
// "TS encode → Rust decode → TS view" since the encode/decode logic itself
// lives entirely in Rust (per ARCHITECTURE.md §8 component boundaries).
//
// Skipped if the native binary isn't built. CI builds it on every push.
import { describe, expect, test } from "bun:test";
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

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  const here = import.meta.dir;
  const candidates = [
    join(here, "../../native/target/release/hayven-native"),
    join(here, "../../native/target/debug/hayven-native"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

const bin = findBinary();
const maybeDescribe = bin === null ? describe.skip : describe;

const W = (n: number) => {
  const w = new Uint8Array(16);
  w.fill(n);
  return w;
};
const H = (wallMs: number, counter = 0): Hlc => ({ wallMs, counter });

maybeDescribe("CRDT wire round-trip via hayven-native", () => {
  const bridge = openWireBridge({ binaryPath: bin ?? undefined });

  test("transport is subprocess by default, FFI only when opted in", () => {
    // The subprocess transport is the production default. The FFI transport is
    // opt-in behind HAYVEN_FFI and byte-identical (see wire_ffi.test.ts). When
    // the suite runs with HAYVEN_FFI=1 and the cdylib loads, this bridge may be
    // FFI; otherwise it must be subprocess. Either transport satisfies the
    // round-trip assertions below.
    const ffiEnv = (process.env["HAYVEN_FFI"] ?? "").toLowerCase();
    const ffiOptedIn = ["1", "true", "yes", "on"].includes(ffiEnv);
    if (ffiOptedIn) {
      expect(["ffi", "subprocess"]).toContain(bridge.transport);
    } else {
      expect(bridge.transport).toBe("subprocess");
    }
  });

  test("G-Set ops round-trip byte-identically", () => {
    const ops: GsetOp[] = [
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
    const wireIn = ops.map(gsetToWire);
    const bytes = bridge.encode(wireIn);
    const wireOut = bridge.decode(bytes);
    expect(wireOut).toEqual(wireIn);
  });

  test("LWW op round-trips with content hash preserved", () => {
    const op = {
      kind: "lww" as const,
      entityId: "auth/login",
      value: "# auth/login\n\nrefactored summary",
      contentHash: new Uint8Array(32).fill(0xaa),
      hlc: H(2_000_000, 3),
      writer: W(0x11),
    } satisfies LwwOp<string>;
    const wireIn = [lwwToWire(op)];
    const bytes = bridge.encode(wireIn);
    const wireOut = bridge.decode(bytes);
    expect(wireOut).toEqual(wireIn);
  });

  test("OR-Set add + remove round-trip preserves tag list", () => {
    const tagA = "00".repeat(28);
    const tagB = "ff".repeat(28);
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
      observedTags: [tagA, tagB],
      hlc: H(11),
      writer: W(0x33),
    };
    const wireIn = [orToWire(addOp), orToWire(removeOp)];
    const bytes = bridge.encode(wireIn);
    const wireOut = bridge.decode(bytes);
    expect(wireOut).toEqual(wireIn);
  });

  test("HLC reserved bytes round-trip as zero", () => {
    // Encoding any HLC must produce zero reserved bytes per §11.2 — the
    // Rust decoder rejects non-zero reserved (we tested that on the Rust
    // side; here we just confirm our TS encoder produces conformant bytes).
    const hlcBytes = encodeHlc({ wallMs: 1_700_000_000_000, counter: 12345 });
    expect(hlcBytes[10]).toBe(0);
    expect(hlcBytes[11]).toBe(0);
  });

  test("envelope compresses below the JSON baseline (≥30% smaller)", () => {
    // Same metric the Rust unit test checks, exercised end-to-end through
    // the subprocess so we know the daemon really sees the win.
    const ops: WireOp[] = Array.from({ length: 500 }, (_, i) =>
      gsetToWire({
        kind: "observe",
        src: `auth/login_handler_${i % 10}`,
        dst: `auth/validate_session_${i % 7}`,
        tsBucket: bucketize(1_700_000_000 + (i % 60)),
        observed: (i % 9) + 1,
        weight: ((i % 9) + 1) * 100,
        hlc: H(1_700_000_000_000 + i, 0),
        writer: W(i % 4),
      }),
    );
    const wire = bridge.encode(ops);
    const json = new TextEncoder().encode(JSON.stringify(ops));
    const ratio = wire.length / json.length;
    expect(ratio).toBeLessThanOrEqual(0.7);
  });
});
