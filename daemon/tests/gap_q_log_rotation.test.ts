/**
 * GAP Q8 — log bounds that were not actually bounded.
 *
 *   a) `rotateLogFile` was NOT ATOMIC ACROSS PROCESSES. Several hayven processes
 *      share `~/.hayven/logs` (the daemon, every CLI invocation, each hook-driven
 *      autostart), so two of them can pass the size check on the same file at the
 *      same time and interleave their `.N → .N+1` shifts: A renames `x.log` →
 *      `x.log.1` and starts a fresh `x.log`; B, still mid-sequence, renames that
 *      brand-new `.1` to `.2` and then renames A's live `x.log` on top of `.1`.
 *      One generation is destroyed and a live log is moved out from under its
 *      writer.
 *   b) `daemon.out.log` was rotated ONLY at spawn, because the fd is handed to
 *      the detached child for its whole life — so between two `daemon start`s
 *      (a daemon that runs for weeks) nothing capped it at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { truncateOwnOutLog } from "../src/cli/daemon.ts";
import { createLogger, rotateLogFile } from "../src/util/log.ts";

const HAYVEN_HOME_SANDBOX = mkdtempSync(join(tmpdir(), "hayven-gapq-log-home-"));
process.env["HAYVEN_HOME"] = HAYVEN_HOME_SANDBOX;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "hayven-gapq-log-"));
  dirs.push(d);
  return d;
}

const quietLogger = createLogger({ toFile: false, toStderr: false });

describe("Q8a — rotation is exclusive across processes", () => {
  test("a HELD rotate lock makes rotation skip instead of interleaving", () => {
    const dir = tmp();
    const log = join(dir, "daemon.log");
    writeFileSync(log, "x".repeat(200));
    writeFileSync(`${log}.1`, "PREVIOUS GENERATION");

    // Stand in for the other process: it is mid-rotation and holds the lock.
    const lock = openSync(`${log}.rotating`, "wx");
    try {
      expect(rotateLogFile(log, 100, 3)).toBe(false);
      // Nothing moved: `.1` still holds the previous generation, not our file.
      expect(readFileSync(`${log}.1`, "utf8")).toBe("PREVIOUS GENERATION");
      expect(existsSync(log)).toBe(true);
      expect(statSync(log).size).toBe(200);
    } finally {
      closeSync(lock);
      rmSync(`${log}.rotating`, { force: true });
    }

    // With the lock released, the same call rotates normally.
    expect(rotateLogFile(log, 100, 3)).toBe(true);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(200));
    expect(readFileSync(`${log}.2`, "utf8")).toBe("PREVIOUS GENERATION");
  });

  test("the lock is released after a successful rotation (not leaked)", () => {
    const dir = tmp();
    const log = join(dir, "daemon.log");
    writeFileSync(log, "y".repeat(200));
    expect(rotateLogFile(log, 100, 3)).toBe(true);
    expect(existsSync(`${log}.rotating`)).toBe(false);
    // A second oversized generation still rotates — proof the lock did not stick.
    writeFileSync(log, "z".repeat(200));
    expect(rotateLogFile(log, 100, 3)).toBe(true);
  });

  test("an ABANDONED lock (holder killed mid-rotation) is stolen, not obeyed forever", () => {
    const dir = tmp();
    const log = join(dir, "daemon.log");
    writeFileSync(log, "w".repeat(200));
    const lock = openSync(`${log}.rotating`, "wx");
    closeSync(lock);
    // Age it well past the staleness window.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(`${log}.rotating`, old, old);

    expect(rotateLogFile(log, 100, 3)).toBe(true);
    expect(existsSync(`${log}.rotating`)).toBe(false);
  });

  test("the stale steal is ATOMIC — a concurrent steal cannot end with two holders", () => {
    const dir = tmp();
    const log = join(dir, "daemon.log");
    writeFileSync(log, "v".repeat(200));
    const lock = openSync(`${log}.rotating`, "wx");
    closeSync(lock);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(`${log}.rotating`, old, old);

    // Process A steals and HOLDS. `rm` + `create` would let a second observer
    // unlink A's brand-new lock and create its own, leaving both convinced they
    // hold it and both running the `.N → .N+1` shift. A rename-based steal
    // cannot: only one process can rename a given path.
    expect(rotateLogFile(log, 100, 3)).toBe(true);
    // The generation that was rotated is intact and no lock is left over.
    expect(readFileSync(`${log}.1`, "utf8")).toBe("v".repeat(200));
    expect(existsSync(`${log}.rotating`)).toBe(false);
    // And no `.steal.<pid>` scratch file survived the steal.
    expect(existsSync(`${log}.rotating.steal.${process.pid}`)).toBe(false);
  });

  test("EIGHT concurrent processes stealing one stale lock produce exactly ONE rotation", async () => {
    // The rm+create steal this replaced is racy by construction: two processes
    // that both see the same stale lock both unlink and both create, so A's
    // create succeeds, B's unlink deletes A's brand-new lock, and B's create
    // succeeds too — both then run the `.N → .N+1` shift concurrently. The
    // rename-based steal makes that impossible: only ONE process can rename a
    // given path, and the losers' rename throws.
    //
    // This is SOUND (it can never fail against the rename implementation, which
    // guarantees a single winner) but only PROBABILISTIC against the rm+create
    // one, whose bad window is two syscalls wide. Treat it as supporting
    // evidence for the invariant, not as the proof that the race is closed —
    // that argument is the atomicity of `rename(2)`.
    const dir = tmp();
    const log = join(dir, "daemon.log");
    writeFileSync(log, "c".repeat(400));
    const lock = openSync(`${log}.rotating`, "wx");
    closeSync(lock);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(`${log}.rotating`, old, old);

    const runner = join(dir, "steal.ts");
    const logModule = join(import.meta.dir, "..", "src", "util", "log.ts");
    writeFileSync(
      runner,
      `import { rotateLogFile } from ${JSON.stringify(logModule)};
` +
        `process.stdout.write(String(rotateLogFile(${JSON.stringify(log)}, 100, 3)));
`,
    );

    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const proc = Bun.spawn({ cmd: [process.execPath, "run", runner], stdout: "pipe" });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        return out.trim();
      }),
    );

    expect(results.filter((r) => r === "true").length).toBe(1);
    // Exactly one generation moved: `.2` would mean a second shift ran.
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(existsSync(`${log}.2`)).toBe(false);
    expect(readFileSync(`${log}.1`, "utf8")).toBe("c".repeat(400));
  }, 30_000);

  test("a FRESH lock is never stolen, however oversized the file", () => {
    const dir = tmp();
    const log = join(dir, "daemon.log");
    writeFileSync(log, "u".repeat(5000));
    const lock = openSync(`${log}.rotating`, "wx");
    try {
      expect(rotateLogFile(log, 10, 3)).toBe(false);
      expect(existsSync(`${log}.1`)).toBe(false);
    } finally {
      closeSync(lock);
      rmSync(`${log}.rotating`, { force: true });
    }
  });

  test("an under-cap file is still a no-op and leaves no lock behind", () => {
    const dir = tmp();
    const log = join(dir, "daemon.log");
    writeFileSync(log, "small");
    expect(rotateLogFile(log, 1_000, 3)).toBe(false);
    expect(existsSync(`${log}.rotating`)).toBe(false);
  });
});

describe("Q8b — daemon.out.log is bounded WITHIN a process lifetime", () => {
  test("truncates in place when our own stdout is that exact file", () => {
    const dir = tmp();
    const log = join(dir, "daemon.out.log");
    writeFileSync(log, "L".repeat(500));
    // Stand in for the inherited append fd the detached daemon holds.
    const fd = openSync(log, "a");
    try {
      expect(truncateOwnOutLog(quietLogger, { logPath: log, maxBytes: 100, stdoutFd: fd })).toBe(true);
      expect(statSync(log).size).toBe(0);
      // In place, so the writer keeps its fd: appends still land in the file.
      writeFileSync(log, "after", { flag: "a" });
      expect(readFileSync(log, "utf8")).toBe("after");
    } finally {
      closeSync(fd);
    }
  });

  test("REFUSES to touch the file when stdout is something else (a --foreground daemon)", () => {
    const dir = tmp();
    const log = join(dir, "daemon.out.log");
    const other = join(dir, "elsewhere");
    writeFileSync(log, "L".repeat(500));
    writeFileSync(other, "");
    const fd = openSync(other, "a");
    try {
      expect(truncateOwnOutLog(quietLogger, { logPath: log, maxBytes: 100, stdoutFd: fd })).toBe(false);
      expect(statSync(log).size).toBe(500);
    } finally {
      closeSync(fd);
    }
  });

  test("under the cap it does nothing", () => {
    const dir = tmp();
    const log = join(dir, "daemon.out.log");
    writeFileSync(log, "short");
    const fd = openSync(log, "a");
    try {
      expect(truncateOwnOutLog(quietLogger, { logPath: log, maxBytes: 1_000, stdoutFd: fd })).toBe(false);
      expect(statSync(log).size).toBe(5);
    } finally {
      closeSync(fd);
    }
  });

  test("a missing file is not an error", () => {
    const dir = tmp();
    expect(
      truncateOwnOutLog(quietLogger, { logPath: join(dir, "nope.log"), maxBytes: 1 }),
    ).toBe(false);
  });
});

describe("Q8c — the hook-driven autostart log is rotated by `daemon start`", () => {
  test("cli/daemon.ts rotates autostart.log alongside daemon.out.log", () => {
    // `plugin/scripts/ensure-daemon.sh` appends to `~/.hayven/logs/autostart.log`
    // on every session start and can never rotate it itself (it holds the append
    // fd for its own lifetime). The `hayven daemon start` it invokes is the only
    // process positioned to do it. The rotation lives inside `startDetachedDaemon`,
    // which spawns a real detached process, so this asserts the wiring.
    const source = readFileSync(join(import.meta.dir, "..", "src", "cli", "daemon.ts"), "utf8");
    expect(source).toContain('rotateLogFile(join(globalLogsDir(), "autostart.log"))');
  });
});
