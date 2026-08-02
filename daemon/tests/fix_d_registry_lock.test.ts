/**
 * The registry read → modify → write must be atomic ACROSS PROCESSES, and its
 * publish step must keep both of its stated guarantees.
 *
 * `writeRegistry` has always made the PUBLISH atomic (unique tmp + rename), but
 * nothing made the SEQUENCE atomic. Measured before the lock: 24 processes each
 * registering a distinct repo concurrently left 14 of 24 entries on disk — 10
 * registrations silently lost, every process exiting 0, nothing on stderr. The
 * real trigger is `plugin/scripts/ensure-daemon.sh`, which backgrounds
 * `hayven daemon start` on every SessionStart, so two editors opening two repos
 * at the same moment both prune and both register.
 *
 * These tests use REAL child processes. Concurrent promises inside one process
 * would prove nothing: every mutation here is synchronous, so a single process
 * cannot interleave with itself and would pass with the lock deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readRegistry, registryFile, writeRegistry } from "../src/daemon/registry.ts";

const REGISTRY_SRC = join(dirname(import.meta.dir), "src", "daemon", "registry.ts");

let home: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-lock-home-")));
  process.env["HAYVEN_HOME"] = home;
  mkdirSync(join(home, ".hayven"), { recursive: true });
  if (!registryFile().startsWith(home)) {
    throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${home}`);
  }
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  rmSync(home, { recursive: true, force: true });
});

describe("registerProject under genuine process concurrency", () => {
  const WORKERS = 24;

  /**
   * Each worker parks until a shared wall-clock instant before writing, so all
   * of them are inside the read → modify → write at the same time. Without the
   * barrier, Bun's ~30ms startup jitter serializes them and the race never
   * fires — the test would pass with the lock deleted.
   */
  const WORKER_SRC = `
import { registerProject } from ${JSON.stringify(REGISTRY_SRC)};
const goAt = Number(process.env.GO_AT);
while (Date.now() < goAt) { /* spin to the barrier */ }
registerProject(process.env.REPO);
`;

  it("keeps EVERY registration when 24 processes register at once", async () => {
    const worker = join(home, "worker.ts");
    writeFileSync(worker, WORKER_SRC);
    const repos = Array.from({ length: WORKERS }, (_, i) => {
      const root = join(home, `repo-${i}`);
      mkdirSync(join(root, ".hayven"), { recursive: true });
      return root;
    });

    const goAt = Date.now() + 1500;
    const procs = repos.map((repo) =>
      Bun.spawn(["bun", worker], {
        env: { ...process.env, HAYVEN_HOME: home, REPO: repo, GO_AT: String(goAt) },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));

    expect(codes).toEqual(Array.from({ length: WORKERS }, () => 0));
    const roots = new Set(readRegistry().map((e) => e.root));
    // The exact failure this pins: entries present in the process's own write
    // but absent from the file, because a sibling read the pre-write copy and
    // published it back over the top.
    const missing = repos.filter((r) => !roots.has(r));
    expect(missing).toEqual([]);
    expect(roots.size).toBe(WORKERS);
  }, 30_000);

  it("leaves no lockfile behind", () => {
    // Pins the RELEASE step only (it fails if the unlink is removed). It does
    // not, on its own, prove a lock was ever taken — "held lock blocks…" below
    // is what proves that.
    writeRegistry([{ alias: "a", root: join(home, "a") }]);
    expect(readdirSync(join(home, ".hayven")).filter((f) => f.endsWith(".lock"))).toEqual([]);
  });

  it("a HELD lock actually blocks another writer until it goes stale", () => {
    // The load-bearing test for "the lock is real". A lockfile is planted and
    // kept FRESH (never backdated), so the writer cannot proceed until it has
    // watched the file sit unchanged for the stale window. With no locking at
    // all — or with staleness misjudged — the write returns immediately.
    const lock = `${registryFile()}.lock`;
    writeFileSync(lock, "someone-else\n");

    const started = Date.now();
    writeRegistry([{ alias: "waited", root: join(home, "waited") }]);
    const waited = Date.now() - started;

    expect(readRegistry().map((e) => e.alias)).toEqual(["waited"]);
    expect(waited).toBeGreaterThan(2_000);
  }, 30_000);

  it("recovers from a lockfile whose holder died without unlinking it", () => {
    // A crash between create and unlink must not wedge every future registry
    // write on the machine. An already-old, unchanging lock is reclaimed on the
    // first stale window rather than after the full acquire budget.
    const lock = `${registryFile()}.lock`;
    writeFileSync(lock, "999999 stale\n");
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    writeRegistry([{ alias: "after-crash", root: join(home, "after-crash") }]);

    expect(readRegistry().map((e) => e.alias)).toEqual(["after-crash"]);
    // The stale lock was REPLACED, not merely waited out: nothing of the dead
    // holder's file survives.
    expect(readdirSync(join(home, ".hayven")).filter((f) => f.endsWith(".lock"))).toEqual([]);
  }, 30_000);

  // NOT covered here: release-by-token refusing to unlink a SUCCESSOR's lock
  // (the case where our own critical section outlived the stale window and was
  // reclaimed underneath us). Reaching it needs a critical section artificially
  // stretched past LOCK_STALE_MS, which there is no seam for without exporting
  // the lock internals purely for the test. The code path is a plain
  // `readLockToken(path) === token` guard in `releaseRegistryLock`.
});

describe("writeRegistry publish guarantees", () => {
  it("does NOT use a fixed `${file}.tmp` scratch path", () => {
    // Probes the guarantee directly and deterministically: with the old fixed
    // name, two concurrent writers shared one scratch file and a shorter body
    // left trailing bytes from a longer one, which the rename then published
    // perfectly atomically as a torn file. Occupying that exact path with a
    // DIRECTORY makes a fixed-name implementation fail with EISDIR while a
    // unique-name one is unaffected. The multi-process test above covers the
    // same guarantee behaviorally; this one cannot go flaky.
    mkdirSync(`${registryFile()}.tmp`, { recursive: true });
    expect(() => writeRegistry([{ alias: "a", root: join(home, "a") }])).not.toThrow();
    expect(readRegistry().map((e) => e.alias)).toEqual(["a"]);
  });

  it("cleans up the scratch file when the publish fails", () => {
    // Make the rename fail by turning the TARGET into a directory (rename(2)
    // returns EISDIR when `new` is a directory and `old` is not). Without the
    // catch-and-rm, every failed publish leaves a stray `projects.json.*.tmp`
    // in the user's global dir forever.
    rmSync(registryFile(), { force: true });
    mkdirSync(registryFile(), { recursive: true });

    expect(() => writeRegistry([{ alias: "a", root: join(home, "a") }])).toThrow();

    const leftovers = readdirSync(join(home, ".hayven")).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("PRECONDITION: a normal write really does publish through this path", () => {
    // Guards the two tests above from going vacuous if `writeRegistry` ever
    // stops writing at all.
    writeRegistry([{ alias: "control", root: join(home, "control") }]);
    expect(JSON.parse(readFileSync(registryFile(), "utf8")).projects).toHaveLength(1);
  });
});
