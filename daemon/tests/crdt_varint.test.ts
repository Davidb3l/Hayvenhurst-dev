// §13 length/count varint cap (BL-7).
//
// CONTRACT: a length/count varint MUST fit unsigned 32-bit range
// (≤ 4_294_967_295 = 2^32 − 1). The old reader capped at 5 bytes and coerced
// the result with `>>> 0`, silently truncating an over-range value (e.g. 2^32
// → 0) and then framing a bogus batch. The reader now THROWS a clean Error on
// any value past u32, while still returning `null` for a genuinely truncated
// (torn-write) varint.
import { describe, expect, test } from "bun:test";

import { __varintInternals } from "../src/crdt/oplog.ts";

const { readVarint, encodeVarint, VARINT_U32_MAX } = __varintInternals;

describe("§13 varint u32 cap", () => {
  test("a value just under the cap round-trips", () => {
    const v = VARINT_U32_MAX; // 2^32 − 1, the largest legal value
    const bytes = encodeVarint(v);
    const read = readVarint(bytes, 0);
    expect(read).not.toBeNull();
    expect(read![0]).toBe(v);
    expect(read![1]).toBe(bytes.length);
  });

  test("a smaller value round-trips", () => {
    for (const v of [0, 1, 127, 128, 16_383, 16_384, 1_000_000]) {
      const read = readVarint(encodeVarint(v), 0);
      expect(read).not.toBeNull();
      expect(read![0]).toBe(v);
    }
  });

  test("a 5-byte varint just OVER u32 throws cleanly", () => {
    // 2^32 = 4_294_967_296, one past the cap. Hand-encode (encodeVarint uses
    // 32-bit ops and can't represent this). LEB128 little-endian groups of 7:
    //   0x100000000 = 0b1_0000...0000 → bytes 80 80 80 80 10.
    const over = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x10]);
    expect(() => readVarint(over, 0)).toThrow(/u32 range/);
  });

  test("a 6th continuation byte throws cleanly (no silent coercion)", () => {
    // Five continuation bytes then a low terminator — describes a value far
    // beyond u32. The old code would have hit `shift >= 35` and returned null
    // (treated as a torn write); now it's correctly rejected as corrupt.
    const sixByte = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
    expect(() => readVarint(sixByte, 0)).toThrow(/u32 range/);
  });

  test("a truncated varint (continuation bit set, stream ends) still returns null", () => {
    // This is a torn write, NOT an over-range value — callers rely on null to
    // stop at the last good batch and truncate.
    const truncated = Uint8Array.from([0x80, 0x80]);
    expect(readVarint(truncated, 0)).toBeNull();
  });
});
