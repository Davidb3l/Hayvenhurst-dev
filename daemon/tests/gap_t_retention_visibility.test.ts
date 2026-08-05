// LANE T / T5+T6 — the CRDT retention bounds are actually REACHABLE.
//
// T5 verdict (see the header of `crdt/retention.ts`): pruning is NOT
// implemented, and deliberately so — the negotiated-horizon design needs a
// durable peer registry and an ack exchange that do not exist (`sync_peers` is
// declared in the config and read by nothing), so "prune once every known peer
// has acked" evaluates over the empty set. That is a release cycle, not a
// patch. What IS in scope is making the WARNING reachable.
//
// The gap this closes: every bound in `retention.ts` was measured in exactly
// one place — `CrdtState.hydrate()`, i.e. daemon START. That is the moment the
// log is smallest. The incident's daemon ran six hours in one process; a log
// that grows to gigabytes inside a single session crossed every threshold and
// reported none, because the only code that could report had already finished.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, openSync, rmSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpLog } from "../src/crdt/oplog.ts";
import {
  CRDT_LIMITS,
  inspectRetention,
  RETENTION_RECHECK_INTERVAL_MS,
  type CrdtLimits,
} from "../src/crdt/retention.ts";
import { renderReport } from "../src/cli/crdt.ts";
import type { WireBridge } from "../src/crdt/wire.ts";

/** The op log's constructor opens a wire bridge. Nothing here encodes or
 *  decodes, so a stub keeps these independent of whether `hayven-native` is
 *  built. */
const stubBridge: WireBridge = {
  transport: "subprocess",
  encode: () => Uint8Array.from([1, 2, 3]),
  decode: () => [],
  decodeSegment: () => [],
};

const NOW_MS = Date.UTC(2026, 6, 15, 12, 0, 0);

/** Limits low enough that any segment at all is a violation. */
const TINY: CrdtLimits = {
  ...CRDT_LIMITS,
  warnTotalBytes: 1,
  warnSegmentBytes: 1,
  warnSegmentCount: 0,
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function newRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "hayven-gapt-ret-"));
  dirs.push(d);
  return d;
}

/** Write a segment directly, bypassing the op log, so `inspectRetention` (which
 *  is `stat`-only) has something to measure. */
function seedSegment(root: string, type: string, day: string, bytes: number): void {
  const dir = join(root, type);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${day}.log`), "w");
  try {
    writeSync(fd, new Uint8Array(bytes));
  } finally {
    closeSync(fd);
  }
}

/** Capture stderr — the channel the retention warnings share with
 *  `crdt_log:truncated_torn_write`. */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (s: string) => {
    lines.push(String(s));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return lines;
}

const gsetOp = (wallMs: number) =>
  ({
    kind: "gset_observe",
    hlc: { wall_ms: wallMs, counter: 0 },
    writer: new Uint8Array(16).fill(3),
  }) as unknown as Parameters<OpLog["appendOps"]>[1][number];

describe("T6 — the op log re-measures itself DURING a session", () => {
  it("warns once the recheck interval has elapsed, not only at start", () => {
    const root = newRoot();
    seedSegment(root, "gset", "2026-07-15", 4096);
    let clock = NOW_MS;
    const log = new OpLog(root, {
      bridge: stubBridge,
      now: () => clock,
      limits: TINY,
      retentionCheckIntervalMs: 60_000,
    });

    // Before the interval elapses: silent. A stat pass on every append would
    // itself be the read amplification these bounds exist to detect.
    const quiet = captureStderr(() => {
      log.appendOps("gset", [gsetOp(NOW_MS)]);
    });
    expect(quiet.filter((l) => l.includes("crdt_retention:")).length).toBe(0);

    // A minute of session time later: the same append shouts.
    clock = NOW_MS + 60_001;
    const loud = captureStderr(() => {
      log.appendOps("gset", [gsetOp(NOW_MS)]);
    });
    const warnings = loud.filter((l) => l.includes("crdt_retention:limit_exceeded"));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join("")).toContain("never pruned");
    log.close();
  });

  it("also fires on the INBOUND (peer push) append path, not just local writes", () => {
    // `appendRawBatchToDate` is the only path an untrusted peer can grow our
    // disk through, so it is the one that most needs to be re-measured.
    const root = newRoot();
    seedSegment(root, "lww", "2026-07-15", 4096);
    let clock = NOW_MS;
    const log = new OpLog(root, {
      bridge: stubBridge,
      now: () => clock,
      limits: TINY,
      retentionCheckIntervalMs: 60_000,
    });
    clock = NOW_MS + 60_001;
    const lines = captureStderr(() => {
      log.appendRawBatchToDate("lww", "2026-07-15", Uint8Array.from([9, 9, 9]));
    });
    expect(lines.filter((l) => l.includes("crdt_retention:limit_exceeded")).length).toBeGreaterThan(0);
    log.close();
  });

  it("an interval of 0 disables the periodic check entirely", () => {
    const root = newRoot();
    seedSegment(root, "gset", "2026-07-15", 4096);
    let clock = NOW_MS;
    const log = new OpLog(root, {
      bridge: stubBridge,
      now: () => clock,
      limits: TINY,
      retentionCheckIntervalMs: 0,
    });
    clock = NOW_MS + 10 * 60_000;
    const lines = captureStderr(() => {
      log.appendOps("gset", [gsetOp(NOW_MS)]);
    });
    expect(lines.filter((l) => l.includes("crdt_retention:")).length).toBe(0);
    log.close();
  });

  it("a healthy log under the real limits stays silent", () => {
    const root = newRoot();
    seedSegment(root, "gset", "2026-07-15", 4096);
    let clock = NOW_MS;
    const log = new OpLog(root, {
      bridge: stubBridge,
      now: () => clock,
      retentionCheckIntervalMs: 60_000,
    });
    clock = NOW_MS + 60_001;
    const lines = captureStderr(() => {
      log.appendOps("gset", [gsetOp(NOW_MS)]);
    });
    expect(lines.filter((l) => l.includes("crdt_retention:")).length).toBe(0);
    log.close();
  });

  it("the default interval is a session-scale number, not a start-up-only one", () => {
    expect(RETENTION_RECHECK_INTERVAL_MS).toBeGreaterThan(0);
    expect(RETENTION_RECHECK_INTERVAL_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe("T6 — `hayven crdt retention` is a PULL surface for the same numbers", () => {
  it("reports the log's size and day range", () => {
    const root = newRoot();
    seedSegment(root, "gset", "2026-01-01", 2048);
    seedSegment(root, "lww", "2026-07-15", 1024);
    const log = new OpLog(root, { bridge: stubBridge, retentionCheckIntervalMs: 0 });
    const out = renderReport(inspectRetention(log, CRDT_LIMITS));
    log.close();

    expect(out).toContain("CRDT op-log retention");
    expect(out).toContain("2026-01-01");
    expect(out).toContain("2026-07-15");
    expect(out).toContain("Within every growth bound.");
    // The uncomfortable part must be said out loud, or a clean report implies
    // the log manages itself.
    expect(out).toContain("append-only");
  });

  it("names each violated bound rather than looking healthy", () => {
    const root = newRoot();
    seedSegment(root, "gset", "2026-07-15", 4096);
    const log = new OpLog(root, { bridge: stubBridge, retentionCheckIntervalMs: 0 });
    const out = renderReport(inspectRetention(log, TINY));
    log.close();

    expect(out).toContain("Over ");
    expect(out).toContain("bound(s)");
    expect(out).toContain("total_bytes");
    expect(out).not.toContain("Within every growth bound.");
  });
});

describe("T5 — pruning is NOT implemented, and the code says so", () => {
  it("nothing in the retention module deletes a segment", () => {
    // A guard against a future well-meaning patch quietly adding a prune.
    //
    // The REASON pruning is refused has changed, and the banner assertion moved
    // with it. It used to be "this needs a peer acknowledgement protocol we do
    // not have". The premise was then measured: the log grows ~12 KB/year, so
    // reaching the warning threshold takes ~42,600 years, and no deletion is
    // warranted at all. See docs/RFC-001. The no-delete assertions below are
    // the load-bearing half and are unchanged — they fail whatever the stated
    // rationale happens to be, which is the point of pinning behaviour rather
    // than prose.
    const src = Bun.file(
      join(import.meta.dir, "../src/crdt/retention.ts"),
    );
    return src.text().then((text) => {
      expect(text).not.toContain("unlinkSync");
      expect(text).not.toContain("rmSync");
      expect(text).toContain("PRUNING WILL NOT BE BUILT");
      expect(text).toContain("RFC-001");
    });
  });
});
