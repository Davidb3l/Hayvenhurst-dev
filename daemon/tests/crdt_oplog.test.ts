// Tests for the §14 append-only segmented op log. Skipped when the native
// binary isn't built (op encode/decode goes through hayven-native).
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bucketize, type GsetOp } from "../src/crdt/gset.ts";
import { OpLog, utcDate, type CrdtType } from "../src/crdt/oplog.ts";
import { gsetToWire, type WireOp } from "../src/crdt/wire.ts";
import type { Hlc } from "../src/crdt/hlc.ts";

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  const here = import.meta.dir;
  const candidates = [
    join(here, "../../native/target/release/hayven-native"),
    join(here, "../../native/target/debug/hayven-native"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const bin = findBinary();
const maybeDescribe = bin === null ? describe.skip : describe;

const W = (n: number) => new Uint8Array(16).fill(n);
const H = (wallMs: number, counter = 0): Hlc => ({ wallMs, counter });

function makeGsetOp(opts: Partial<GsetOp> & { hlc: Hlc; writer: Uint8Array }): GsetOp {
  return {
    kind: "observe",
    src: opts.src ?? "auth/login",
    dst: opts.dst ?? "auth/session",
    tsBucket: opts.tsBucket ?? bucketize(1_700_000_000),
    observed: opts.observed ?? 1,
    weight: opts.weight ?? 100,
    hlc: opts.hlc,
    writer: opts.writer,
  };
}

maybeDescribe("OpLog persistence", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    cleanups.length = 0;
  });

  function newDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "hayven-oplog-"));
    cleanups.push(dir);
    return dir;
  }

  test("appended ops round-trip through hydrate", () => {
    const dir = newDir();
    const log = new OpLog(dir, { now: () => 1_700_000_000_000 });
    const ops: WireOp[] = [
      gsetToWire(makeGsetOp({ hlc: H(1), writer: W(0x11) })),
      gsetToWire(makeGsetOp({ src: "x", dst: "y", hlc: H(2), writer: W(0x11) })),
    ];
    log.appendOps("gset", ops);
    log.close();

    const log2 = new OpLog(dir, { now: () => 1_700_000_000_000 });
    const hydrated = Array.from(log2.hydrate("gset"));
    expect(hydrated).toEqual(ops);
    log2.close();
  });

  test("segment file is named by the op's HLC day, not now()", () => {
    const dir = newDir();
    // now() is a different day from the ops' HLC — the FILE must follow the
    // ops, because that's what makes the same op land in the same-named file
    // on every replica (sync convergence depends on it).
    const dayA = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01
    const dayB = Date.UTC(2026, 0, 2, 12, 0, 0); // 2026-01-02
    const log = new OpLog(dir, { now: () => Date.UTC(2030, 5, 5) });
    log.appendOps("gset", [gsetToWire(makeGsetOp({ hlc: H(dayA), writer: W(0xa) }))]);
    log.appendOps("gset", [gsetToWire(makeGsetOp({ hlc: H(dayB), writer: W(0xb) }))]);
    log.close();
    const files = readdirSync(join(dir, "gset")).sort();
    expect(files).toEqual(["2026-01-01.log", "2026-01-02.log"]);

    const log2 = new OpLog(dir);
    expect(Array.from(log2.hydrate("gset")).length).toBe(2);
    log2.close();
  });

  test("torn write at end of segment is truncated on hydrate", () => {
    const dir = newDir();
    const day = Date.UTC(2026, 0, 3, 12, 0, 0); // 2026-01-03
    const log = new OpLog(dir);
    log.appendOps("gset", [gsetToWire(makeGsetOp({ hlc: H(day), writer: W(0xa) }))]);
    log.appendOps("gset", [gsetToWire(makeGsetOp({ hlc: H(day + 1), writer: W(0xb) }))]);
    log.close();

    const file = join(dir, "gset", `${utcDate(day)}.log`);
    const original = readFileSync(file);
    // Append a junk varint + truncated payload to simulate a torn write.
    const fd = openSync(file, "a");
    try {
      const junk = Uint8Array.from([0x10, 0x00, 0x00, 0x00]); // claims length 16 but no follow-up
      writeSync(fd, junk, 0, junk.length);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(file).byteLength).toBeGreaterThan(original.byteLength);

    const log2 = new OpLog(dir, { now: () => 1_700_000_000_000 });
    const hydrated = Array.from(log2.hydrate("gset"));
    // We still get the two good ops.
    expect(hydrated.length).toBe(2);
    log2.close();
    // And the file is now truncated back to the last good batch.
    expect(readFileSync(file).byteLength).toBe(original.byteLength);
  });

  test("appendRawBatchToDate bytes round-trip identically (sync push path)", () => {
    const dir = newDir();
    const log = new OpLog(dir, { now: () => 1_700_000_000_000 });
    const ops: WireOp[] = [gsetToWire(makeGsetOp({ hlc: H(1), writer: W(0xc) }))];
    // Pretend we received these bytes from a peer's /api/sync/batch reply.
    const fromPeer = log["bridge"].encode(ops); // accessing private bridge for test fidelity
    log.appendRawBatchToDate("gset", "1970-01-01", fromPeer);
    log.close();

    const log2 = new OpLog(dir, { now: () => 1_700_000_000_000 });
    const hydrated = Array.from(log2.hydrate("gset"));
    expect(hydrated).toEqual(ops);
    log2.close();
  });

  test("diskUsage tracks bytes-on-disk for the directory", () => {
    const dir = newDir();
    const log = new OpLog(dir, { now: () => 1_700_000_000_000 });
    expect(log.diskUsage()).toBe(0);
    log.appendOps("gset", [gsetToWire(makeGsetOp({ hlc: H(1), writer: W(0xc) }))]);
    log.close();
    expect(log.diskUsage()).toBeGreaterThan(0);
  });

  test("creates per-type subdirectories on construction", () => {
    const dir = newDir();
    new OpLog(dir).close();
    const types: CrdtType[] = ["lww", "gset", "orset"];
    for (const t of types) {
      expect(existsSync(join(dir, t))).toBe(true);
    }
  });
});
