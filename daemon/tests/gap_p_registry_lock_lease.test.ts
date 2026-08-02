/**
 * P3 — the registry lockfile had no heartbeat.
 *
 * `LOCK_STALE_MS` is 5s of WALL time and the holder never touched the file
 * after creating it, so ANY critical section outliving 5s of wall clock — a
 * stalled NFS/SMB `statSync`, a laptop sleeping mid-section, SIGSTOP, a
 * contended nested acquire — got reclaimed underneath its live holder and both
 * writers proceeded. `releaseRegistryLock`'s token check made the loser's
 * UNLINK a no-op but did nothing about its WRITE, so the late finisher's
 * `writeRegistry` clobbered the winner's registry: a silently lost
 * registration, which is the exact failure the lock was added to prevent.
 *
 * Two halves are pinned separately because Bun does not let a test intercept a
 * named `node:fs` import, so a touch cannot be observed from inside a real
 * critical section:
 *   1. the LEASE PRIMITIVE (`refreshLockFile`) — a live holder's lockfile mtime
 *      moves forward, a stolen one is detected, and a vanished one is never
 *      resurrected; and
 *   2. the WIRING — a section that loses its lease before publishing is re-run
 *      under a fresh lock instead of renaming over the reclaimer's work.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readRegistryRaw,
  refreshLockFile,
  registerProject,
  registryFile,
  writeRegistry,
  type ProjectEntry,
} from "../src/daemon/registry.ts";

// MUST sandbox via $HAYVEN_HOME, not $HOME: Bun resolves `os.homedir()` once per
// process, so mutating HOME here would rewrite the developer's real registry.
let home: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-gapp-lock-")));
  process.env["HAYVEN_HOME"] = home;
  mkdirSync(join(home, ".hayven"), { recursive: true });
  // Tripwire copied from registry.test.ts.
  if (!registryFile().startsWith(home)) {
    throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${home}`);
  }
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  rmSync(home, { recursive: true, force: true });
});

const lockPath = (): string => `${registryFile()}.lock`;

function makeRepo(name: string): string {
  const root = join(home, name);
  mkdirSync(join(root, ".hayven"), { recursive: true });
  return root;
}

/** Capture stderr for the duration of `fn`. */
function captureStderr(fn: () => void): string {
  const out: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (s: unknown) => (out.push(String(s)), true);
  try {
    fn();
  } finally {
    (process.stderr as { write: unknown }).write = orig;
  }
  return out.join("");
}

describe("the lease primitive", () => {
  it("THE HEARTBEAT: refreshing a lock we hold moves its mtime forward", () => {
    const path = lockPath();
    writeFileSync(path, "mine.1.abcdef\n");
    // Back-date it well past LOCK_STALE_MS — this is what "our section has been
    // blocked in a cold NFS stat for a minute" looks like on disk. A waiter
    // seeing this mtime stay put for 5s of its own elapsed time reclaims it.
    const aged = new Date(Date.now() - 60_000);
    utimesSync(path, aged, aged);
    expect(statSync(path).mtimeMs).toBeLessThan(Date.now() - 30_000);

    expect(refreshLockFile(path, "mine.1.abcdef")).toBe(true);

    // The whole point: the file is no longer old, so no waiter can conclude the
    // holder died. Before the fix nothing ever touched the file after creation.
    expect(statSync(path).mtimeMs).toBeGreaterThan(Date.now() - 5_000);
  });

  it("reports LOST when a reclaimer already replaced the token", () => {
    const path = lockPath();
    writeFileSync(path, "someone-else.9.zzzz\n");
    expect(refreshLockFile(path, "mine.1.abcdef")).toBe(false);
    // ...and it did not touch a lock it does not own.
    expect(readFileSync(path, "utf8").trim()).toBe("someone-else.9.zzzz");
  });

  it("reports LOST for a vanished lock and does NOT recreate it", () => {
    // `utimesSync` and not a rewrite, precisely so this holds: resurrecting the
    // file with our token would look like a live lock to every other writer
    // while nobody actually holds it.
    const path = lockPath();
    expect(existsSync(path)).toBe(false);
    expect(refreshLockFile(path, "mine.1.abcdef")).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});

describe("a section that loses its lease is re-run, not published blind", () => {
  /**
   * Build an `entries` array whose first element steals the lock the FIRST time
   * it is serialized.
   *
   * `JSON.stringify` runs inside `writeRegistryUnlocked`, between taking the
   * lock and the publishing `rename` — i.e. exactly where a real reclaim lands.
   * The thief writes a foreign token (a reclaimer's create), publishes its own
   * registry, and then removes the lockfile (a reclaimer's release), so our
   * retry can re-acquire immediately instead of waiting out LOCK_STALE_MS.
   */
  function thievingEntries(
    mine: string,
    theirs: string,
    onSteal: () => void,
  ): { entries: ProjectEntry[]; serializations: () => number } {
    let reads = 0;
    const entry = {
      get alias(): string {
        reads++;
        if (reads === 1) {
          writeFileSync(lockPath(), "reclaimer.999.deadbeef\n");
          writeFileSync(
            registryFile(),
            JSON.stringify({ version: 1, projects: [{ alias: "theirs", root: theirs }] }, null, 2) + "\n",
          );
          rmSync(lockPath(), { force: true });
          onSteal();
        }
        return "mine";
      },
      root: mine,
    };
    return { entries: [entry as unknown as ProjectEntry], serializations: () => reads };
  }

  it("re-runs the critical section and warns instead of renaming over the reclaimer", () => {
    const mine = makeRepo("mine");
    const theirs = makeRepo("theirs");
    let stole = 0;
    const { entries, serializations } = thievingEntries(mine, theirs, () => stole++);

    const stderr = captureStderr(() => writeRegistry(entries));

    expect(stole).toBe(1); // precondition: the steal actually happened
    // THE FIX: the section ran a SECOND time. Before it, the first attempt's
    // `rename` published straight over the reclaimer with nothing on stderr.
    expect(serializations()).toBe(2);
    expect(stderr).toMatch(/was reclaimed while this process held it/);
    expect(stderr).toMatch(/retrying the write/);
  });

  it("the retry publishes the RE-RUN section's output, not the aborted attempt's", () => {
    // A `writeRegistry(entries)` has nothing to re-read, so this pins the
    // property that generalizes: whatever the re-run produces is what lands.
    // For the read → modify → write callers (`registerProject`,
    // `pruneStaleProjects`, `unregisterProjectDetailed`) the re-run re-reads the
    // file the reclaimer published, which is what preserves both writes.
    const mine = makeRepo("mine");
    let pass = 0;
    const entry = {
      get alias(): string {
        pass++;
        if (pass === 1) {
          writeFileSync(lockPath(), "reclaimer.999.deadbeef\n");
          rmSync(lockPath(), { force: true });
        }
        return pass === 1 ? "first-attempt" : "second-attempt";
      },
      root: mine,
    };

    captureStderr(() => writeRegistry([entry as unknown as ProjectEntry]));

    expect(readRegistryRaw().map((e) => e.alias)).toEqual(["second-attempt"]);
  });

  it("positive control: an untouched lock publishes on the FIRST pass", () => {
    // Same shape, no steal. Proves the re-run above was caused by the lost
    // lease and not by `writeRegistry` serializing twice as a matter of course.
    const mine = makeRepo("untouched");
    let reads = 0;
    const entry = {
      get alias(): string {
        reads++;
        return "untouched";
      },
      root: mine,
    };
    const stderr = captureStderr(() => writeRegistry([entry as unknown as ProjectEntry]));
    expect(reads).toBe(1);
    expect(stderr).toBe("");
    expect(readRegistryRaw()).toEqual([{ alias: "untouched", root: mine }]);
  });

  it("never wedges: a lock stolen on every pass still publishes, loudly", () => {
    // Degradation must stay one-directional. `daemon start` prunes and
    // registers on every start; throwing out of it over a pathologically
    // contended lockfile would be worse than one warned-about write.
    const mine = makeRepo("always-stolen");
    let reads = 0;
    const entry = {
      get alias(): string {
        reads++;
        writeFileSync(lockPath(), `reclaimer.${reads}.deadbeef\n`);
        rmSync(lockPath(), { force: true });
        return "always-stolen";
      },
      root: mine,
    };

    const stderr = captureStderr(() => writeRegistry([entry as unknown as ProjectEntry]));

    expect(readRegistryRaw()).toEqual([{ alias: "always-stolen", root: mine }]);
    expect(stderr).toMatch(/retrying the write/);
    // Bounded: it does not spin forever trying to win a lock it keeps losing.
    expect(reads).toBeLessThanOrEqual(5);
  });

  it("the lockfile is still released cleanly after all of this", () => {
    registerProject(makeRepo("after"));
    expect(existsSync(lockPath())).toBe(false);
  });
});
