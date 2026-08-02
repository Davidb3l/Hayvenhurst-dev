/**
 * E9 — the daemon log had no rotation, no size cap and no max age.
 *
 * The incident left a 576 MB `daemon.log`, and the bulk of that volume was the
 * SAME handful of `native parse warning` lines for vendored files (torch, scipy)
 * that will never parse cleanly, emitted thousands of times. So there are two
 * bounds here, and de-duplication is worth more than rotation alone:
 *   - rotation caps the on-disk total,
 *   - dedup stops one stuck producer generating the volume in the first place.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLogger,
  LOG_DEDUP_THRESHOLD,
  resetLogDedupState,
  rotateLogFile,
} from "../src/util/log.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hayven-fixe-log-"));
  resetLogDedupState();
});

afterEach(() => {
  resetLogDedupState();
  rmSync(dir, { recursive: true, force: true });
});

/** Read a JSON-lines log file as parsed records. */
function records(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("E9: log rotation", () => {
  it("rotates once the file passes the cap and keeps N generations", () => {
    const file = join(dir, "daemon.log");
    appendFileSync(file, "x".repeat(2048));

    expect(rotateLogFile(file, 1024, 2)).toBe(true);

    // The live file is gone (a new one is created on the next write) and the
    // content moved to generation 1.
    expect(existsSync(file)).toBe(false);
    expect(statSync(`${file}.1`).size).toBe(2048);
  });

  it("does NOT rotate a file under the cap", () => {
    const file = join(dir, "daemon.log");
    appendFileSync(file, "x".repeat(10));
    expect(rotateLogFile(file, 1024, 2)).toBe(false);
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  it("bounds the on-disk total: older generations are DROPPED, not kept forever", () => {
    const file = join(dir, "daemon.log");
    // Three rotations with keep=2 — generation 3 must never exist.
    for (const marker of ["first", "second", "third"]) {
      appendFileSync(file, marker.padEnd(2048, "."));
      expect(rotateLogFile(file, 1024, 2)).toBe(true);
    }
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    // …and the generations shifted in the right direction (newest is .1).
    expect(readFileSync(`${file}.1`, "utf8").startsWith("third")).toBe(true);
    expect(readFileSync(`${file}.2`, "utf8").startsWith("second")).toBe(true);
  });

  it("never throws on a missing file (rotation must not break a start)", () => {
    expect(rotateLogFile(join(dir, "nope.log"), 1, 2)).toBe(false);
  });
});

describe("E9: repeated-line suppression", () => {
  it("collapses the same line repeated thousands of times", () => {
    const file = join(dir, "daemon.log");
    const log = createLogger({ toFile: true, toStderr: false, filePath: file });

    // The incident's actual shape: one unparseable vendored file, over and over.
    for (let i = 0; i < 5000; i++) {
      log.warn("native parse warning", { file: "vendor/torch/_C.pyi", reason: "unsupported syntax" });
    }

    const written = records(file);
    // THE property: the log did not grow with the failure count.
    expect(written.length).toBeLessThanOrEqual(LOG_DEDUP_THRESHOLD);
    expect(written.length).toBeGreaterThan(0);
  });

  it("keeps DISTINCT lines — suppression must never hide real information", () => {
    const file = join(dir, "daemon.log");
    const log = createLogger({ toFile: true, toStderr: false, filePath: file });
    for (let i = 0; i < 50; i++) {
      log.warn("native parse warning", { file: `vendor/pkg/file${i}.py` });
    }
    // 50 different files → 50 different records. Only REPETITION is collapsed.
    expect(records(file).length).toBe(50);
  });

  it("reports how many repeats were dropped, so quiet != nothing happened", async () => {
    const file = join(dir, "daemon.log");
    // A short window so the suppressed count is CARRIED into the next window
    // (rather than reset), which is the behavior being pinned.
    const log = createLogger({ toFile: true, toStderr: false, filePath: file, dedupWindowMs: 30 });
    for (let i = 0; i < 100; i++) log.warn("stuck", { a: 1 });
    await new Promise((r) => setTimeout(r, 50)); // let the window roll over
    log.warn("stuck", { a: 1 });

    const all = records(file);
    const withCount = all.filter((r) => typeof r["suppressed_repeats"] === "number");
    expect(withCount.length).toBe(1);
    expect(withCount[0]!["suppressed_repeats"]).toBe(100 - LOG_DEDUP_THRESHOLD);
  });

  it("can be turned off for callers that need every line", () => {
    const file = join(dir, "daemon.log");
    const log = createLogger({ toFile: true, toStderr: false, filePath: file, dedup: false });
    for (let i = 0; i < 40; i++) log.warn("same", { a: 1 });
    expect(records(file).length).toBe(40);
  });

  it("bounds its own memory: thousands of DISTINCT keys do not grow unbounded", () => {
    const file = join(dir, "daemon.log");
    const log = createLogger({ toFile: true, toStderr: false, filePath: file });
    // A pathological producer emitting a unique message every time must not turn
    // the suppressor itself into the leak.
    for (let i = 0; i < 12000; i++) log.warn(`unique-${i}`, { i });
    expect(records(file).length).toBe(12000);
  });
});

describe("E9: the WRITE PATH rotates, not just the helper", () => {
  it("rotates during ordinary logging, with no direct rotateLogFile call", () => {
    // Every other rotation test calls `rotateLogFile` directly, so making
    // `maybeRotate` — the function `emit()` actually calls — an unconditional
    // no-op left them all GREEN. The helper was tested; the wiring was not.
    const file = join(dir, "daemon.log");
    const log = createLogger({
      toFile: true,
      toStderr: false,
      filePath: file,
      dedup: false, // isolate rotation from suppression
      maxBytes: 64 * 1024, // a real 32 MB cap would make this test take minutes
    });

    // Each record is ~200 bytes, so this is ~800 KB against a 64 KB cap — many
    // rotations, and well past the rotate-check stride so the size check runs.
    for (let i = 0; i < 4000; i++) {
      log.warn(`line ${i}`, { padding: "x".repeat(200), i });
    }

    expect(existsSync(`${file}.1`)).toBe(true);
    // The live file was replaced, so the on-disk total stays bounded instead of
    // growing to the 576 MB the incident produced.
    expect(statSync(file).size).toBeLessThan(64 * 1024);
  });
});

describe("E9: suppression survives changing counters", () => {
  it("collapses repeated lines whose FIELDS carry a counter", () => {
    // Hashing the whole field object defeated dedup 100% on the exact workload
    // it was built for: every line the runaway loop emits carries a counter or
    // duration — `{dropped, sinceMs}`, `{touched, cap}`, `{changed, deleted}` —
    // so no two were ever byte-identical. Probe: 10,000 of 10,000 overflow
    // warnings written. Rotation then caps the disk, which turns that into an
    // EVIDENCE-DESTRUCTION bug: the loop's own churn rotates away the history.
    const file = join(dir, "daemon.log");
    const log = createLogger({ toFile: true, toStderr: false, filePath: file });

    for (let i = 0; i < 10_000; i++) {
      log.warn("watch: overflow — full re-ingest", { dropped: i, sinceMs: Date.now() + i });
    }

    expect(records(file).length).toBeLessThanOrEqual(LOG_DEDUP_THRESHOLD);
  });

  it("still separates lines that differ by a STRING identity field", () => {
    const file = join(dir, "daemon.log");
    const log = createLogger({ toFile: true, toStderr: false, filePath: file });
    for (let i = 0; i < 40; i++) {
      // Same message, different file, and a varying counter alongside it.
      log.warn("native parse warning", { file: `vendor/pkg/f${i}.py`, attempt: i });
    }
    expect(records(file).length).toBe(40);
  });

  it("does not thrash when distinct keys exceed the old 4096 cap", () => {
    // At DEDUP_MAX_KEYS=4096 a repo with ~5,000 unparseable vendored files
    // filled the ledger, cleared it, and wrote every line again — 200,000 of
    // 200,000. The cap is now far higher AND overflow drops the oldest half
    // instead of clearing.
    const file = join(dir, "daemon.log");
    const log = createLogger({ toFile: true, toStderr: false, filePath: file });
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 5_000; i++) {
        log.warn("native parse warning", { file: `vendor/torch/f${i}.pyi` });
      }
    }
    // 5,000 distinct files x 40 rounds = 200,000 attempts. Working suppression
    // writes EXACTLY the per-key threshold once each (5,000 x 5 = 25,000). A
    // thrashing ledger — cleared every time it filled — writes strictly more,
    // because every clear resets the counters. Pre-fix: 200,000 of 200,000.
    expect(records(file).length).toBe(5_000 * LOG_DEDUP_THRESHOLD);
  });
});
