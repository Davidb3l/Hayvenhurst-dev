// LANE F — CRDT unbounded-growth / unbounded-I/O regression guards.
//
//   F1  `/api/sync/batch` read the WHOLE segment for every ranged request.
//   F2  the op log and G-Set grow forever with no bound and no signal.
//   F3  `OpLog.diskUsage` read every segment in full to sum byte lengths.
//   F4  `/api/sync/push` had no size cap and accepted far-future segment days.
//
// HOW THE I/O BOUNDS ARE PROVEN (this is the anti-vacuous-test bit). A test
// that merely checks "the right bytes came back" passes for BOTH the fixed and
// the broken implementation — reading 8 GiB and slicing 1 KiB out of it returns
// the same 1 KiB. So the fixtures here use a SPARSE 8 GiB segment file
// (`ftruncate`, zero blocks on disk, created in milliseconds). A whole-file
// read of it fails immediately with ENOMEM, while a ranged read of the first
// KiB succeeds. That makes "did you read the whole file?" directly observable:
// revert the fix and the test throws instead of passing.
//
// No test here binds a port or touches global state; `app.handle` drives the
// routes in-process, so the real daemon on :7777 is irrelevant to all of them.
import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { CrdtState } from "../src/crdt/state.ts";
import {
  MAX_FUTURE_SEGMENT_DAYS,
  OpLog,
  SegmentRejectedError,
  utcDate,
} from "../src/crdt/oplog.ts";
import {
  CRDT_LIMITS,
  addOpCountViolations,
  inspectRetention,
  warnRetention,
  type CrdtLimits,
} from "../src/crdt/retention.ts";
import { bucketize } from "../src/crdt/gset.ts";
import { gsetToWire, openWireBridge, type WireBridge } from "../src/crdt/wire.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

/** 8 GiB. Past this a whole-file read fails with ENOMEM on every platform we
 *  target, which is exactly the signal these tests need. Sparse, so it costs
 *  zero disk blocks and no measurable time to create. */
const HUGE = 8 * 1024 * 1024 * 1024;

/** The op log's constructor opens a wire bridge. These tests never encode or
 *  decode anything (they write raw bytes and read raw ranges), so a stub keeps
 *  them independent of whether `hayven-native` happens to be built. */
const stubBridge: WireBridge = {
  transport: "subprocess",
  encode: () => new Uint8Array(0),
  decode: () => [],
  decodeSegment: () => [],
};

const NOW_MS = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15
const TODAY = utcDate(NOW_MS);

/** The one test below that needs a REAL §13 batch has to encode one, which
 *  goes through `hayven-native`. Skip it (loudly, by name) when the binary is
 *  not built rather than silently passing for the wrong reason. */
function nativeBinaryPresent(): boolean {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return true;
  return [
    join(import.meta.dir, "../../native/target/release/hayven-native"),
    join(import.meta.dir, "../../native/target/debug/hayven-native"),
  ].some((c) => existsSync(c));
}

describe("LANE F — CRDT growth and I/O bounds", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    cleanups.length = 0;
  });

  function newRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "hayven-fixf-"));
    cleanups.push(dir);
    return dir;
  }

  function newLog(root = newRoot()): OpLog {
    return new OpLog(root, { bridge: stubBridge, now: () => NOW_MS });
  }

  /** Create a sparse segment of `size` bytes whose first `head` bytes are the
   *  given marker, so a ranged read has something recognizable to return. */
  function sparseSegment(root: string, type: string, day: string, size: number, head?: Uint8Array) {
    const dir = join(root, type);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${day}.log`);
    const fd = openSync(path, "w");
    try {
      ftruncateSync(fd, size);
    } finally {
      closeSync(fd);
    }
    if (head && head.length > 0) {
      const fd2 = openSync(path, "r+");
      try {
        writeSync(fd2, head, 0, head.length, 0);
      } finally {
        closeSync(fd2);
      }
    }
    return path;
  }

  // ── F1 ────────────────────────────────────────────────────────────────────

  test("F1: readSegmentRange reads ONLY the window — an 8 GiB segment pages fine", () => {
    const root = newRoot();
    const head = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    sparseSegment(root, "gset", TODAY, HUGE, head);
    const log = newLog(root);

    // A whole-file read of this segment is not survivable; the ranged read is.
    // Reverting readSegmentRange to "readFileSync then slice" makes this throw
    // ENOMEM instead of returning.
    const chunk = log.readSegmentRange("gset", TODAY, 0, 1024);
    expect(chunk).not.toBeNull();
    expect(chunk!.size).toBe(HUGE);
    expect(chunk!.bytes.length).toBe(1024);
    expect(Array.from(chunk!.bytes.subarray(0, 8))).toEqual(Array.from(head));
    log.close();
  });

  test("F1: paging with readSegmentRange reassembles the exact segment bytes", () => {
    const root = newRoot();
    const payload = new Uint8Array(5000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
    mkdirSync(join(root, "lww"), { recursive: true });
    writeFileSync(join(root, "lww", `${TODAY}.log`), payload);
    const log = newLog(root);

    const out: number[] = [];
    let offset = 0;
    let guard = 0;
    for (;;) {
      const chunk = log.readSegmentRange("lww", TODAY, offset, 512);
      expect(chunk).not.toBeNull();
      if (chunk!.bytes.length === 0) break;
      out.push(...chunk!.bytes);
      offset += chunk!.bytes.length;
      if (++guard > 100) throw new Error("paging did not terminate");
    }
    expect(out.length).toBe(payload.length);
    expect(out).toEqual(Array.from(payload));
    expect(log.readSegmentRange("lww", "2026-07-14", 0, 10)).toBeNull();
    log.close();
  });

  test("F1: POST /api/sync/batch serves a window of an 8 GiB segment", async () => {
    const { app, crdtRoot } = makeApp();
    sparseSegment(crdtRoot, "gset", TODAY, HUGE, Uint8Array.from([9, 9, 9, 9]));

    const res = await app.handle(
      new Request("http://localhost/api/sync/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "gset", path: TODAY, offset: 0, max_bytes: 4096 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-segment-size")).toBe(String(HUGE));
    expect(res.headers.get("x-segment-eof")).toBe("0");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(4096);
    expect(Array.from(body.subarray(0, 4))).toEqual([9, 9, 9, 9]);
  });

  test("F1: an absurd max_bytes is clamped, not honored", async () => {
    const { app, crdtRoot } = makeApp();
    sparseSegment(crdtRoot, "gset", TODAY, HUGE);

    const res = await app.handle(
      new Request("http://localhost/api/sync/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // What a hostile (or just careless) peer asks for: the whole segment.
        body: JSON.stringify({ type: "gset", path: TODAY, offset: 0, max_bytes: 2 ** 31 - 1 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(8 * 1024 * 1024); // MAX_BATCH_RESPONSE_BYTES
  });

  // ── F3 ────────────────────────────────────────────────────────────────────

  test("F3: diskUsage stats segments instead of reading them", () => {
    const root = newRoot();
    sparseSegment(root, "gset", TODAY, HUGE);
    sparseSegment(root, "lww", TODAY, 1234);
    const log = newLog(root);

    // Reverting diskUsage to readFileSync makes this throw ENOMEM.
    expect(log.diskUsage()).toBe(HUGE + 1234);
    log.close();
  });

  test("F3: segmentSizes reports per-day sizes sorted ascending", () => {
    const root = newRoot();
    sparseSegment(root, "orset", "2026-07-02", 20);
    sparseSegment(root, "orset", "2026-07-01", 10);
    const log = newLog(root);
    expect(log.segmentSizes("orset")).toEqual([
      { day: "2026-07-01", bytes: 10 },
      { day: "2026-07-02", bytes: 20 },
    ]);
    expect(log.segmentSizes("lww")).toEqual([]);
    log.close();
  });

  // ── F2 ────────────────────────────────────────────────────────────────────

  test("F2: a log past the DEFAULT bounds is flagged and warned about", () => {
    const root = newRoot();
    // One day's segment over warnSegmentBytes (64 MiB) and, with a sibling,
    // over warnTotalBytes (512 MiB). Sparse: no real disk consumed.
    sparseSegment(root, "gset", "2026-07-01", 400 * 1024 * 1024);
    sparseSegment(root, "gset", "2026-07-02", 200 * 1024 * 1024);
    const log = newLog(root);

    const report = inspectRetention(log);
    expect(report.totalBytes).toBe(600 * 1024 * 1024);
    expect(report.oldestDay).toBe("2026-07-01");
    expect(report.newestDay).toBe("2026-07-02");
    const codes = report.violations.map((v) => v.code).sort();
    expect(codes).toEqual(["segment_bytes", "segment_bytes", "total_bytes"]);

    const lines: string[] = [];
    expect(warnRetention(report, (l) => lines.push(l))).toBe(3);
    for (const l of lines) expect(l).toContain("crdt_retention:limit_exceeded");
    expect(lines.join("")).toContain("code=total_bytes");
    log.close();
  });

  test("F2: a healthy log produces no violations and no warning lines", () => {
    const root = newRoot();
    sparseSegment(root, "gset", TODAY, 4096);
    const log = newLog(root);
    const report = inspectRetention(log);
    expect(report.violations).toEqual([]);
    const lines: string[] = [];
    expect(warnRetention(report, (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual([]);
    log.close();
  });

  test("F2: too many segments is a violation even when every segment is small", () => {
    const root = newRoot();
    const log = newLog(root);
    const tiny: CrdtLimits = { ...CRDT_LIMITS, warnSegmentCount: 1 };
    sparseSegment(root, "lww", "2026-07-01", 8);
    sparseSegment(root, "lww", "2026-07-02", 8);
    const report = inspectRetention(log, tiny);
    expect(report.violations.map((v) => v.code)).toEqual(["segment_count"]);
    expect(report.segmentCounts.lww).toBe(2);
    log.close();
  });

  test("F2: an oversized in-memory replay is a violation", () => {
    const root = newRoot();
    const log = newLog(root);
    const tiny: CrdtLimits = { ...CRDT_LIMITS, warnOpCount: 10 };
    const report = addOpCountViolations(
      inspectRetention(log, tiny),
      { lww: 1, gset: 11, orset: 0 },
      tiny,
    );
    expect(report.violations).toEqual([
      { code: "op_count", type: "gset", day: null, observed: 11, limit: 10 },
    ]);
    log.close();
  });

  test("F2: CrdtState.hydrate() actually emits the warning on stderr", () => {
    const dir = newRoot();
    const paths = hayvenPathsFor(dir);
    // One EMPTY segment file: enough to be counted, and hydrate reads it
    // without needing the native bridge (zero bytes => zero batches).
    mkdirSync(join(paths.crdtDir, "gset"), { recursive: true });
    writeFileSync(join(paths.crdtDir, "gset", `${TODAY}.log`), new Uint8Array(0));

    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      written.push(String(s));
      return true;
    };
    try {
      // skipHydrate is false: this is the daemon-start path.
      new CrdtState({
        crdtRoot: paths.crdtDir,
        configFile: paths.configFile,
        limits: { ...CRDT_LIMITS, warnSegmentCount: 0 },
      });
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    const joined = written.join("");
    expect(joined).toContain("crdt_retention:limit_exceeded");
    expect(joined).toContain("code=segment_count");
  });

  // ── F4 ────────────────────────────────────────────────────────────────────

  test("F4: appendRawBatchToDate refuses a far-future segment day", () => {
    const root = newRoot();
    const log = newLog(root);
    const batch = Uint8Array.from([1, 2, 3]);

    expect(() => log.appendRawBatchToDate("gset", "9999-12-31", batch)).toThrow(
      SegmentRejectedError,
    );
    expect(existsSync(join(root, "gset", "9999-12-31.log"))).toBe(false);

    // Just inside the window is accepted; just outside is not.
    const inside = utcDate(NOW_MS + (MAX_FUTURE_SEGMENT_DAYS - 1) * 86_400_000);
    const outside = utcDate(NOW_MS + (MAX_FUTURE_SEGMENT_DAYS + 1) * 86_400_000);
    expect(log.appendRawBatchToDate("gset", inside, batch)).toBeGreaterThan(0);
    expect(() => log.appendRawBatchToDate("gset", outside, batch)).toThrow(SegmentRejectedError);

    // Ordinary past days (real peers syncing old history) still work.
    expect(log.appendRawBatchToDate("gset", "1999-01-01", batch)).toBeGreaterThan(0);
    expect(() => log.appendRawBatchToDate("gset", "1969-12-31", batch)).toThrow(
      SegmentRejectedError,
    );
    log.close();
  });

  test("F4: appendRawBatchToDate refuses an oversized batch", () => {
    const log = newLog();
    const tooBig = new Uint8Array(CRDT_LIMITS.maxPushBatchBytes + 1);
    expect(() => log.appendRawBatchToDate("lww", TODAY, tooBig)).toThrow(SegmentRejectedError);
    // One byte under the cap is fine.
    const okSize = new Uint8Array(CRDT_LIMITS.maxPushBatchBytes);
    expect(log.appendRawBatchToDate("lww", TODAY, okSize)).toBeGreaterThan(okSize.length);
    log.close();
  });

  test("F4: appendRawBatchToDate refuses an append past the segment hard cap", () => {
    const root = newRoot();
    sparseSegment(root, "orset", TODAY, CRDT_LIMITS.maxSegmentBytes);
    const log = newLog(root);
    expect(() => log.appendRawBatchToDate("orset", TODAY, Uint8Array.from([7]))).toThrow(
      SegmentRejectedError,
    );
    log.close();
  });

  test("F4: a LOCAL op minted outside the window is written but shouted about", () => {
    // Our own data is never dropped for a clock problem. But peers apply the
    // same acceptance window on their side, so an out-of-window local day means
    // these ops can NEVER sync — a permanent, invisible divergence unless we say
    // so. Warn, do not reject.
    const root = newRoot();
    const log = new OpLog(root, {
      bridge: { ...stubBridge, encode: () => Uint8Array.from([1, 2, 3]) },
      now: () => NOW_MS,
    });
    const far = NOW_MS + (MAX_FUTURE_SEGMENT_DAYS + 30) * 86_400_000;
    const op = {
      kind: "gset_observe",
      hlc: { wall_ms: far, counter: 0 },
      writer: new Uint8Array(16).fill(3),
    } as unknown as Parameters<OpLog["appendOps"]>[1][number];

    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      written.push(String(s));
      return true;
    };
    try {
      expect(log.appendOps("gset", [op])).toBeGreaterThan(0); // NOT rejected
      log.appendOps("gset", [op]); // second append: must not re-warn
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }

    const joined = written.join("");
    expect(joined).toContain("crdt_retention:local_day_out_of_window");
    expect(joined).toContain(utcDate(far));
    expect(
      written.filter((l) => l.includes("local_day_out_of_window")).length,
    ).toBe(1);
    // And the data really is on disk.
    expect(existsSync(join(root, "gset", `${utcDate(far)}.log`))).toBe(true);
    log.close();
  });

  test("F4: POST /api/sync/push rejects a far-future day with 400 and writes nothing", async () => {
    const { app, crdtRoot } = makeApp();
    const res = await app.handle(
      new Request("http://localhost/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "gset", path: "9999-12-31", batch: "AAAA" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("days in the future");
    expect(existsSync(join(crdtRoot, "gset", "9999-12-31.log"))).toBe(false);
  });

  test.skipIf(!nativeBinaryPresent())(
    "F4: a rejected push leaves NO trace — not on disk, not in memory",
    async () => {
      // The handler's contract is persist-then-apply, and a refused append must
      // return BEFORE the apply loop. Proving the memory half needs a batch that
      // actually DECODES, so this one test encodes a real §13 batch. The size
      // cap is the rejection reachable with a well-formed batch — the day check
      // fires earlier, before the decode.
      const { app, crdt, crdtRoot } = makeApp();
      const day = utcDate(Date.now());
      // Pre-grow the target segment to its hard cap so ANY append is refused.
      sparseSegment(crdtRoot, "gset", day, CRDT_LIMITS.maxSegmentBytes);
      const before = crdt.gset.size;

      const batch = openWireBridge().encode([
        gsetToWire({
          kind: "observe",
          src: "a/one",
          dst: "b/two",
          tsBucket: bucketize(Math.floor(Date.now() / 1000)),
          observed: 1,
          weight: 1,
          hlc: { wallMs: Date.now(), counter: 0 },
          writer: new Uint8Array(16).fill(7),
        }),
      ]);

      const res = await app.handle(
        new Request("http://localhost/api/sync/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "gset",
            path: day,
            batch: Buffer.from(batch).toString("base64"),
          }),
        }),
      );
      expect(res.status).toBe(413);
      // Disk: the segment must be byte-for-byte what it was.
      expect(statSync(join(crdtRoot, "gset", `${day}.log`)).size).toBe(
        CRDT_LIMITS.maxSegmentBytes,
      );
      // Memory: the op must NOT have been folded in.
      expect(crdt.gset.size).toBe(before);
    },
  );

  test("F4: POST /api/sync/push rejects an oversized body with 413", async () => {
    const { app } = makeApp();
    const huge = "A".repeat(Math.ceil((CRDT_LIMITS.maxPushBatchBytes * 4) / 3) + 64);
    const res = await app.handle(
      new Request("http://localhost/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "gset", path: utcDate(Date.now()), batch: huge }),
      }),
    );
    expect(res.status).toBe(413);
  });

  // ── harness ───────────────────────────────────────────────────────────────

  function makeApp() {
    const dir = newRoot();
    const paths = hayvenPathsFor(dir);
    const crdt = new CrdtState({
      crdtRoot: paths.crdtDir,
      configFile: paths.configFile,
      skipHydrate: true,
    });
    const db = new Db(":memory:");
    db.migrate();
    const app = buildApp({
      db,
      config: DEFAULT_CONFIG,
      paths,
      logger: createLogger({ toFile: false, toStderr: false }),
      crdt,
      daemonVersion: "test",
      ingest: {
        current: () => null,
        start: async () => {
          throw new Error("not used");
        },
      },
    });
    return { app, crdt, crdtRoot: paths.crdtDir };
  }
});
