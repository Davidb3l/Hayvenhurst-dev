// Unit tests for the HLC + writer-ID primitives. ARCHITECTURE.md §11.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";

import {
  compareComposite,
  compareHlc,
  compareWriter,
  decodeHlc,
  encodeComposite,
  encodeHlc,
  generateWriterId,
  HLC_BYTES,
  HlcError,
  HlcGenerator,
  loadOrCreateWriterId,
  WRITER_BYTES,
  writerIdFromHex,
  writerIdToHex,
} from "../src/crdt/hlc.ts";

describe("HLC encoding", () => {
  test("round-trips arbitrary (wallMs, counter) pairs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: 0xffff }),
        (wallMs, counter) => {
          const enc = encodeHlc({ wallMs, counter });
          expect(enc.length).toBe(HLC_BYTES);
          const dec = decodeHlc(enc);
          expect(dec.wallMs).toBe(wallMs);
          expect(dec.counter).toBe(counter);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("rejects encoded HLCs with non-zero reserved bytes", () => {
    const enc = encodeHlc({ wallMs: 123, counter: 4 });
    enc[10] = 0xff;
    expect(() => decodeHlc(enc)).toThrow(HlcError);
  });

  test("encoded bytes sort the same as comparHlc", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: 0xffff }),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: 0xffff }),
        (aw, ac, bw, bc) => {
          const a = { wallMs: aw, counter: ac };
          const b = { wallMs: bw, counter: bc };
          const logical = compareHlc(a, b);
          const bytesA = encodeHlc(a);
          const bytesB = encodeHlc(b);
          const lex = byteCompare(bytesA, bytesB);
          expect(Math.sign(lex)).toBe(logical);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("HlcGenerator", () => {
  test("ticks monotonically even when wall clock stalls", () => {
    const gen = new HlcGenerator({ now: () => 1000 });
    const ticks = Array.from({ length: 100 }, () => gen.tick());
    for (let i = 1; i < ticks.length; i++) {
      const prev = ticks[i - 1]!;
      const cur = ticks[i]!;
      expect(compareHlc(prev, cur)).toBe(-1);
    }
  });

  test("ticks monotonically when wall clock jumps backwards", () => {
    let t = 2000;
    const gen = new HlcGenerator({ now: () => t });
    const first = gen.tick();
    t = 500; // clock jumps back 1.5 seconds
    const second = gen.tick();
    expect(compareHlc(first, second)).toBe(-1);
    expect(second.wallMs).toBe(2000);
    expect(second.counter).toBe(1);
  });

  test("observe() absorbs a remote HLC ahead of local", () => {
    const gen = new HlcGenerator({ now: () => 100 });
    gen.observe({ wallMs: 999999, counter: 5 });
    const next = gen.tick();
    expect(next.wallMs).toBe(999999);
    expect(next.counter).toBe(6);
  });

  test("counter overflow advances logical wall_ms instead of throwing", () => {
    const gen = new HlcGenerator({ now: () => 1, seed: { wallMs: 1, counter: 0xffff } });
    const next = gen.tick();
    expect(next.wallMs).toBe(2); // wall bumped by 1
    expect(next.counter).toBe(0);
  });

  test("a single remote HLC at counter=0xffff does not wedge tick() (M2)", () => {
    // Regression: adopting a remote counter=0xffff used to poison the next
    // tick into a fatal saturation error even though this replica had
    // emitted zero ticks at that ms.
    const gen = new HlcGenerator({ now: () => 100 });
    gen.observe({ wallMs: 999_999, counter: 0xffff });
    const a = gen.tick();
    expect(a.wallMs).toBe(1_000_000); // bumped past the poisoned ms
    expect(a.counter).toBe(0);
    // And it stays monotonic afterwards.
    const b = gen.tick();
    expect(compareHlc(a, b)).toBe(-1);
  });
});

describe("Writer ID", () => {
  test("generateWriterId produces 16 random bytes", () => {
    const a = generateWriterId();
    const b = generateWriterId();
    expect(a.length).toBe(WRITER_BYTES);
    expect(b.length).toBe(WRITER_BYTES);
    expect(byteCompare(a, b)).not.toBe(0);
  });

  test("hex round-trip is stable", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: WRITER_BYTES, maxLength: WRITER_BYTES }), (raw) => {
        const hex = writerIdToHex(raw);
        expect(hex.length).toBe(WRITER_BYTES * 2);
        const back = writerIdFromHex(hex);
        expect(byteCompare(raw, back)).toBe(0);
      }),
    );
  });

  test("rejects malformed hex", () => {
    expect(() => writerIdFromHex("zz")).toThrow();
    expect(() => writerIdFromHex("abc")).toThrow();
  });

  test("compareWriter agrees with byteCompare", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: WRITER_BYTES, maxLength: WRITER_BYTES }),
        fc.uint8Array({ minLength: WRITER_BYTES, maxLength: WRITER_BYTES }),
        (a, b) => {
          expect(Math.sign(byteCompare(a, b))).toBe(compareWriter(a, b));
        },
      ),
    );
  });

  test("loadOrCreateWriterId persists and rehydrates the same ID", () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-writer-"));
    const cfg = join(dir, "config.json");
    const first = loadOrCreateWriterId(cfg);
    const second = loadOrCreateWriterId(cfg);
    expect(byteCompare(first, second)).toBe(0);
    const onDisk = JSON.parse(readFileSync(cfg, "utf8"));
    expect(onDisk.writer_id).toBe(writerIdToHex(first));
  });

  test("loadOrCreateWriterId preserves unrelated config keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-writer-"));
    const cfg = join(dir, "config.json");
    Bun.write(cfg, JSON.stringify({ daemon_port: 9999 }));
    loadOrCreateWriterId(cfg);
    const onDisk = JSON.parse(readFileSync(cfg, "utf8"));
    expect(onDisk.daemon_port).toBe(9999);
    expect(typeof onDisk.writer_id).toBe("string");
  });
});

describe("composite key", () => {
  test("28 bytes, HLC then writer", () => {
    const w = generateWriterId();
    const enc = encodeComposite({ wallMs: 7, counter: 2 }, w);
    expect(enc.length).toBe(28);
    expect(byteCompare(enc.subarray(12), w)).toBe(0);
  });

  test("compareComposite agrees with bytewise sort", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.integer({ min: 0, max: 0xffff }),
        fc.uint8Array({ minLength: WRITER_BYTES, maxLength: WRITER_BYTES }),
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.integer({ min: 0, max: 0xffff }),
        fc.uint8Array({ minLength: WRITER_BYTES, maxLength: WRITER_BYTES }),
        (aw, ac, awid, bw, bc, bwid) => {
          const ah = { wallMs: aw, counter: ac };
          const bh = { wallMs: bw, counter: bc };
          const cmp = compareComposite(ah, awid, bh, bwid);
          const lex = byteCompare(encodeComposite(ah, awid), encodeComposite(bh, bwid));
          expect(Math.sign(lex)).toBe(cmp);
        },
      ),
    );
  });
});

function byteCompare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av !== bv) return av - bv;
  }
  return a.length - b.length;
}
