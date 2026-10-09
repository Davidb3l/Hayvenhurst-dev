/**
 * Multi-project registry.
 *
 * A single running daemon can serve N indexed repositories at once; the viewer
 * and API select one per request via `?project=<alias>`. This module is the
 * source of truth for WHICH repos a daemon serves: a small JSON file at
 * `~/.hayven/projects.json` mapping a short `alias` → absolute repo `root`.
 *
 * The file is intentionally boring and hand-editable:
 *
 *   { "version": 1, "projects": [ { "alias": "myrepo", "root": "/abs/path", "id": "<writer_id>" } ] }
 *
 * `hayven init` auto-registers the project it initializes; `hayven daemon
 * register <path>` adds one explicitly; `hayven daemon projects` lists them;
 * `hayven projects` (cli/projects.ts) renames, relocates, removes and prunes
 * them. The daemon reads this at startup and opens each project's index.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalRoot, globalHayvenDir, hayvenHomeDir, isDirectory } from "../util/paths.ts";

export interface ProjectEntry {
  /** Short, URL-safe handle used in `?project=<alias>` and the viewer switcher. */
  readonly alias: string;
  /**
   * Path to the repo root (the dir holding `.hayven/`). Absolute and
   * symlink-canonical for anything this module WRITES. A hand-edited file may
   * still carry a non-absolute root; {@link readRegistryRaw} preserves such a
   * row verbatim (so an unrelated write cannot delete it) and
   * {@link readRegistry} refuses to serve it. Callers that act on a root must
   * therefore check `isAbsolute` — or use `readRegistry`, which already has.
   */
  readonly root: string;
  /**
   * ISO timestamp of the first daemon start that found `root` missing, cleared
   * as soon as it comes back. Absent for healthy entries. See
   * {@link pruneStaleProjects} for why a single missed stat is not enough.
   */
  readonly missing_since?: string;
  /**
   * The project's IDENTITY: the `writer_id` from `<root>/.hayven/config.json`
   * (32 lowercase hex), recorded whenever the root is present. Optional,
   * because rows written before this field existed have none and it is only
   * ever learned from a root we can read.
   *
   * WHY a path is not enough: the path is WHERE a repo is, not WHICH repo it is.
   * `writer_id` lives inside the repo's own `.hayven/`, so it MOVES WITH THE
   * REPO. Before this field, moving a checkout made the daemon register the new
   * location as `<alias>-2` and keep the old row as a missing ghost, because
   * nothing could tell "the same repo, somewhere else" from "a different repo
   * with the same folder name". See {@link registerProjectDetailed}.
   */
  readonly id?: string;
}

/**
 * Build an entry with a STABLE key order and no `undefined`-valued keys.
 *
 * Both halves matter. `pruneStaleProjects` decides whether to rewrite the file
 * by comparing `JSON.stringify` of before and after, so two spellings of one
 * entry with different key orders would cost a pointless write on every daemon
 * start. And a hand-editor reading the file should see the same shape every
 * time: alias, root, then the optional fields.
 */
function makeEntry(alias: string, root: string, id?: string, missingSince?: string): ProjectEntry {
  return {
    alias,
    root,
    ...(id !== undefined ? { id } : {}),
    ...(missingSince !== undefined ? { missing_since: missingSince } : {}),
  };
}

/**
 * A `writer_id` as `loadOrCreateWriterId` (crdt/hlc.ts) writes it: 16 bytes,
 * hex. Inlined rather than imported from `crdt/peers.ts` so this module, which
 * every CLI start loads, does not pull the CRDT stack in with it.
 */
const IDENTITY_RE = /^[0-9a-f]{32}$/i;

/**
 * The identity of the project at `root`: its `.hayven/config.json` `writer_id`,
 * lowercased, or `undefined` when there is none or anything goes wrong.
 *
 * READ-ONLY BY CONTRACT. It must never fall back to `loadOrCreateWriterId`,
 * which WRITES a fresh id into a config that lacks one: this runs against every
 * registered root (including ones on someone else's mount), and a registry
 * lookup that silently minted identities would also mint a DIFFERENT identity
 * than the daemon later would, defeating the whole point of the field.
 */
export function readProjectIdentity(root: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, ".hayven", "config.json"), "utf8"));
    const id = (parsed as { writer_id?: unknown } | null)?.writer_id;
    return typeof id === "string" && IDENTITY_RE.test(id) ? id.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const REGISTRY_VERSION = 1;

/**
 * How long a root may stay missing before its entry is dropped.
 *
 * NOT zero: "not a directory right now" is very different from "gone forever".
 * An unmounted external drive, a sleeping SMB/NFS share, or an autofs path that
 * has not been touched since boot all read as missing, and evicting on the
 * first miss would cost the user a registration they never removed.
 */
const STALE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A `missing_since` further in the past than this is not believable and is
 * treated as CORRUPT (re-stamped to now) rather than as grounds for eviction.
 *
 * Why: a backward-then-forward clock jump — a dead RTC at boot, then NTP; also
 * a VM snapshot restore — stamps something like `2000-01-01` on the FIRST miss.
 * The next start then computes ~26 years > 7 days and evicts immediately,
 * defeating the entire point of the grace window, which exists so an unmounted
 * external drive survives. The cost of being wrong in the other direction is
 * one extra grace window for a laptop that sat untouched for over a year, so
 * this errs toward preserving the registration.
 */
const IMPLAUSIBLE_MISSING_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/** Absolute path of the registry file (`~/.hayven/projects.json`). */
export function registryFile(): string {
  return join(globalHayvenDir(), "projects.json");
}

/** The advisory lockfile guarding a registry read → modify → write. */
function registryLockFile(): string {
  return `${registryFile()}.lock`;
}

/**
 * How long a lockfile must sit UNCHANGED before the next writer concludes its
 * holder died and reclaims it.
 *
 * Measured as elapsed time on the WAITER'S OWN clock across repeated stats, not
 * as `Date.now() - mtime`. The registry lives under the user's home dir, which
 * may be an NFS/SMB mount whose mtimes come from the server's clock: a future
 * mtime would make the difference negative and the lock immortal (every writer
 * burns the budget and degrades unlocked), and a past-skewed one would make a
 * 1ms-old lock look stale and switch mutual exclusion off entirely. Comparing a
 * value we sampled twice against our own elapsed time has no cross-clock term.
 *
 * Without reclaim at all, ONE process crashing between create and unlink would
 * wedge every future registry write on the machine forever. Every critical
 * section here is a small JSON read plus a rename — the slow stats deliberately
 * happen OUTSIDE the lock (see `pruneStaleProjects`) — so 5s is ~1000x headroom.
 */
const LOCK_STALE_MS = 5_000;

/**
 * Total time a writer will wait for the lock. Deliberately LONGER than
 * {@link LOCK_STALE_MS} so a waiter always outlives a stale lock and reclaims
 * it rather than giving up on it. It is also the worst case for which
 * `sleepSync` blocks the calling thread — including the daemon's event loop on
 * `POST /api/projects` — so it is kept as small as the reclaim rule allows.
 */
const LOCK_ACQUIRE_BUDGET_MS = 6_000;

/**
 * In-process re-entrancy depth. `pruneStaleProjects`/`registerProject` hold the
 * lock across their whole read → modify → write, and the `writeRegistry` they
 * call takes it too; without this counter the nested acquire would deadlock
 * against itself. Everything in this module is synchronous, so there is no
 * in-process interleaving for the counter to get wrong.
 */
let lockDepth = 0;

/**
 * The token of the lock THIS process currently holds, or null when it holds
 * none (not yet acquired, released, degraded-unlocked, or reclaimed out from
 * under us). Read by {@link renewRegistryLock}.
 */
let heldToken: string | null = null;

/**
 * Set once this section's lease is known to be gone. SEPARATE from
 * `heldToken === null`, which also means "we never had one" (the deliberate
 * degraded-unlocked path). Conflating the two made the second renewal in
 * `writeRegistryUnlocked` report SUCCESS right after the first one detected the
 * loss and cleared the token — i.e. the detector disarmed itself and the
 * clobbering rename went ahead exactly as before.
 */
let leaseLost = false;

/**
 * How many times a read → modify → write is re-run after losing its lease.
 *
 * Small on purpose. Each retry is a full re-read + re-write against a lock we
 * just re-acquired, so if we lose the lease three times in a row the machine is
 * pathologically contended and blocking `daemon start` forever is worse than
 * one warned-about write. See {@link withRegistryLock}.
 */
const LOCK_LOST_RETRIES = 3;

/**
 * Thrown by {@link writeRegistryUnlocked} when our lease expired before the
 * publish. Never escapes this module: {@link withRegistryLock} catches it and
 * re-runs the whole critical section under a fresh lock.
 */
class RegistryLockLostError extends Error {
  constructor() {
    super("registry lock was reclaimed mid-section");
    this.name = "RegistryLockLostError";
  }
}

/**
 * Extend our lease on the lockfile, and report whether we still hold it.
 *
 * WHY: `LOCK_STALE_MS` is 5s of WALL time and the holder never touched the file
 * after creating it, so ANY critical section that outlived 5s of wall clock —
 * a stalled NFS/SMB `statSync`, a laptop that slept mid-section, SIGSTOP, a
 * contended nested acquire — was reclaimed underneath its live holder and two
 * writers proceeded at once. `releaseRegistryLock`'s token check made the
 * loser's UNLINK a no-op but did nothing about its WRITE, so the late finisher
 * clobbered the winner's registry: a silently lost registration, which is the
 * exact failure the lock was added to stop.
 *
 * The mechanics live in {@link refreshLockFile}. This wrapper adds the sticky
 * `leaseLost` bit, which is NOT the same as `heldToken === null`: that also
 * means "we never had a lock" (the deliberate degraded-unlocked path), so
 * folding the two together made the second renewal in `writeRegistryUnlocked`
 * report SUCCESS immediately after the first one detected the loss — the
 * detector disarming itself, and the clobbering rename going ahead unchanged.
 */
function renewRegistryLock(): boolean {
  if (leaseLost) return false; // sticky until the next acquire
  if (heldToken === null) return true; // degraded/unlocked — nothing to renew
  if (refreshLockFile(registryLockFile(), heldToken)) return true;
  heldToken = null;
  leaseLost = true;
  return false;
}

/**
 * The lease primitive: bump `path`'s mtime iff it still carries `token`.
 * Returns whether the caller still owns the lock. Exported ONLY so the
 * heartbeat is testable in isolation — Bun does not let a test intercept a
 * named `node:fs` import, so there is no way to observe a touch from inside a
 * real critical section.
 */
export function refreshLockFile(path: string, token: string): boolean {
  try {
    const now = new Date();
    // TOUCH FIRST, then verify. `utimesSync` never CREATES, so a lock a
    // reclaimer already unlinked fails here with ENOENT instead of being
    // resurrected carrying our token — a resurrected file would read as a live
    // lock to every other writer while nobody actually held it.
    utimesSync(path, now, now);
    // The ownership read comes AFTER the touch, and it is the ONLY ownership
    // check, so it cannot be skipped without the function claiming every lock
    // it can stat. Checking BEFORE instead would leave a window: reclaim is
    // unlink-then-create, and a successor's create landing between a
    // pre-check and the touch would have had ITS lease extended by us and left
    // us believing we still held the lock. Bumping a successor's mtime by a few
    // microseconds is harmless — it only makes a live lock look more alive.
    return readLockToken(path) === token;
  } catch {
    // ENOENT (reclaimed and not yet recreated) or an unreadable lock dir.
    // Either way we can no longer prove ownership, so we must not claim it.
    return false;
  }
}

/** Block this thread without spinning a core. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait is unavailable (blocked on a main thread in some hosts).
    // Busy-wait as a last resort; the budget above still bounds it.
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin */
    }
  }
}

/**
 * Run `fn` holding an advisory, CROSS-PROCESS lock on the registry file.
 *
 * Why this exists: `writeRegistry` makes the PUBLISH atomic (unique tmp +
 * rename), but every mutation is a read → modify → write and nothing made the
 * SEQUENCE atomic. Measured before this lock: 24 processes each registering a
 * distinct repo concurrently left 14 of 24 entries on disk — 10 registrations
 * silently lost, every process exiting 0 with nothing on stderr. That is not
 * hypothetical: `plugin/scripts/ensure-daemon.sh` backgrounds `daemon start`
 * on every SessionStart, so two editors opening two repos at once both prune
 * and both register, and `daemon register` writes in the CLI process and then
 * POSTs, making the daemon write again for the same operation.
 *
 * Degradation is deliberate and one-directional: if the lock cannot be created
 * at all (read-only FS, bad perms) or cannot be taken inside the budget, we
 * WARN and proceed unlocked rather than throw. A throw here would take down
 * `daemon start` (which prunes and registers on every start) over a wedged
 * lockfile, and unlocked is exactly the old behavior — bad, but not worse.
 */
function withRegistryLock<T>(fn: () => T): T {
  if (lockDepth > 0) {
    lockDepth++;
    try {
      return fn();
    } finally {
      lockDepth--;
    }
  }
  let token = acquireRegistryLock();
  heldToken = token;
  leaseLost = false;
  lockDepth++;
  try {
    // Re-run the WHOLE read → modify → write when the publish found our lease
    // gone. Retrying is the only outcome that preserves both writes: the
    // reclaimer may have published from a read taken before our change, so our
    // stale in-memory `entries` must be recomputed from what is now on disk.
    // The re-run is safe because every `fn` here is read → compute → write with
    // no side effects of its own.
    for (let attempt = 0; ; attempt++) {
      // `lastChance` disarms the lease check on the final attempt so a
      // pathologically contended machine gets a warned-about write rather than
      // an exception out of `daemon start`, which prunes and registers on every
      // start. Same one-directional degradation as `warnUnlocked`.
      lastChanceWrite = attempt >= LOCK_LOST_RETRIES;
      try {
        return fn();
      } catch (err) {
        if (!(err instanceof RegistryLockLostError)) throw err;
        process.stderr.write(
          `warning: the registry lock at ${registryLockFile()} was reclaimed while this ` +
            `process held it; retrying the write (attempt ${attempt + 2}).\n`,
        );
        token = acquireRegistryLock();
        heldToken = token;
        leaseLost = false;
      }
    }
  } finally {
    lastChanceWrite = false;
    lockDepth--;
    heldToken = null;
    leaseLost = false;
    if (token !== null) releaseRegistryLock(token);
  }
}

/**
 * Set for the final retry only: publish even without a provable lease rather
 * than throwing out of a `daemon start`. See {@link withRegistryLock}.
 */
let lastChanceWrite = false;

/** Say out loud that mutual exclusion is off. Silence here is the bug we are fixing. */
function warnUnlocked(path: string, why: string): void {
  process.stderr.write(
    `warning: proceeding WITHOUT the registry lock at ${path} (${why}) — ` +
      "a concurrent registry write could be lost.\n",
  );
}

/** The lockfile's current contents, or null if it is gone/unreadable. */
function readLockToken(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Take the lockfile, returning the OWNERSHIP TOKEN written into it — or null
 * after degrading loudly (see {@link withRegistryLock}).
 *
 * The token is what makes reclaim safe. `O_EXCL` alone decides who CREATES the
 * file, but a stale-reclaimer can delete a lock that another process is holding
 * (both of them stat, both conclude "stale", both unlink, both create). Writing
 * a unique token and reading it back turns that into a detectable loss: the
 * process whose token is no longer there does NOT run the critical section, and
 * on release nobody deletes a lockfile that is not theirs.
 */
function acquireRegistryLock(): string | null {
  const path = registryLockFile();
  try {
    const dir = globalHayvenDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (err) {
    warnUnlocked(path, `cannot create ${globalHayvenDir()}: ${(err as Error).message}`);
    return null;
  }
  const deadline = Date.now() + LOCK_ACQUIRE_BUDGET_MS;
  // Staleness is "this mtime has not changed for LOCK_STALE_MS of OUR elapsed
  // time", never `Date.now() - mtime` — see LOCK_STALE_MS for why a network
  // home dir's clock must not enter the comparison.
  let watchedMtime: number | null = null;
  let watchedSince = 0;

  for (;;) {
    const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    let created = false;
    try {
      // "wx" is O_CREAT|O_EXCL: the create either wins or fails, atomically,
      // across processes. This is the core mutual-exclusion mechanism.
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, token + "\n");
      } finally {
        closeSync(fd);
      }
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Read-only FS, bad perms, `.hayven` occupied by a file, ENOSPC…
        warnUnlocked(path, (err as Error).message);
        return null;
      }
    }

    if (created) {
      // Confirm nobody's stale-reclaim deleted our brand-new lock in between.
      if (readLockToken(path) === token) return token;
      watchedMtime = null; // lost the race — retry, do NOT enter the section
    } else {
      const mtime = lockMtime(path);
      if (mtime === null) {
        watchedMtime = null; // vanished under us — retry immediately
      } else if (watchedMtime !== mtime) {
        watchedMtime = mtime; // first sighting, or the holder touched it
        watchedSince = Date.now();
      } else if (Date.now() - watchedSince >= LOCK_STALE_MS) {
        reclaimStaleLock(path, mtime);
        watchedMtime = null;
      }
    }

    if (Date.now() >= deadline) {
      warnUnlocked(path, `not acquired within ${LOCK_ACQUIRE_BUDGET_MS}ms; delete that file if it persists`);
      return null;
    }
    // Jitter so N waiters do not retry in lockstep and starve each other.
    sleepSync(5 + Math.floor(Math.random() * 15));
  }
}

/** Modification time of the lockfile in ms, or null if it is gone. */
function lockMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Remove a lockfile whose holder is evidently gone.
 *
 * Re-stats first and bails if the mtime moved: the holder came back to life (or
 * a different process already reclaimed and re-created it) between our decision
 * and this call, and deleting THAT lock would hand mutual exclusion to two
 * processes at once. Staleness is deliberately not a pid check — pid reuse
 * would break a live lock, and the holder may not even be on this host.
 */
function reclaimStaleLock(path: string, expectedMtime: number): void {
  try {
    if (statSync(path).mtimeMs !== expectedMtime) return;
    rmSync(path, { force: true });
  } catch {
    /* already gone, or not ours to remove — the retry loop handles both */
  }
}

/**
 * Release the lock, but ONLY if it is still ours.
 *
 * A critical section that outlives LOCK_STALE_MS can be reclaimed underneath
 * us; unlinking by path alone would then delete a SUCCESSOR's lock and let a
 * third writer straight in. The token check makes that a no-op instead.
 */
function releaseRegistryLock(token: string): void {
  try {
    const path = registryLockFile();
    if (readLockToken(path) === token) rmSync(path, { force: true });
  } catch {
    /* ignore — a leftover lock is reclaimed by age, never a permanent wedge */
  }
}

/** Sanitize a candidate alias to a short, URL-safe, lowercase handle. */
function sanitizeAlias(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "project";
}

/**
 * EVERY structurally usable entry on disk, including roots that must never be
 * served (`$HOME`). This is what MUTATIONS must read.
 *
 * Why the split: every writer does read → modify → write. If the read silently
 * dropped entries, an unrelated `unregisterProject("x")` would also erase every
 * dropped entry as a side effect — permanently, and with no message. The file
 * is documented above as hand-editable, so a duplicated alias is a plausible
 * user typo; losing a whole repo registration to it is not an acceptable
 * outcome. Duplicate aliases are REPAIRED (suffixed) rather than discarded.
 *
 * A non-absolute root is NOT dropped either. It used to be, and because every
 * mutation rewrites from this list, the next unrelated write erased it from
 * disk permanently. A leading `~` is REPAIRED (it is the single most likely
 * hand-edit mistake — every docstring in this module spells global paths that
 * way); anything else non-absolute is preserved VERBATIM and simply never
 * served. Only a missing/blank alias or root is dropped, since there is nothing
 * left to preserve.
 */
export function readRegistryRaw(): ProjectEntry[] {
  const file = registryFile();
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = (parsed as { projects?: unknown })?.projects;
  if (!Array.isArray(list)) return [];
  const out: ProjectEntry[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const alias = typeof raw?.alias === "string" ? raw.alias : "";
    const stored = typeof raw?.root === "string" ? raw.root : "";
    if (!alias || !stored) continue;
    const root = expandHomePrefix(stored);
    // Dedupe on the CANONICAL form, not on the exact string. `/repo`, `/repo/`,
    // `/repo/.` and a symlinked spelling are ONE repo; treating them as
    // separate rows registers the same repo under several aliases, and
    // `cli/daemon.ts` then starts one runtime per alias — two watchers, two
    // ingest pipelines and two `Db` handles on a single `.hayven/index.sqlite`
    // WAL, which is corruption (see `canonicalRoot` in util/paths.ts).
    const key = isAbsolute(root) ? canonicalRoot(root) : `unresolvable:${root}`;
    if (seen.has(key)) continue; // duplicate row for one repo: keep the first
    seen.add(key);
    const unique = out.some((e) => e.alias === alias) ? deriveAlias(root, alias, out) : alias;
    const missing = typeof raw?.missing_since === "string" && raw.missing_since ? raw.missing_since : undefined;
    // A malformed `id` is DROPPED, not preserved: it is only ever a hint for
    // relocation, and a garbage value could only ever produce a wrong match.
    const id = typeof raw?.id === "string" && IDENTITY_RE.test(raw.id) ? raw.id.toLowerCase() : undefined;
    out.push(makeEntry(unique, root, id, missing));
  }
  return out;
}

/**
 * Expand a leading `~` against the user's home dir. `~` is what a hand-editor
 * types, and a relative root is unserveable, so repairing it here is the
 * difference between a working registration and a row that is preserved but
 * inert. Resolved against `homedir()` rather than `hayvenHomeDir()`: `~` means
 * the shell's home, and a user who relocated global state did not thereby move
 * their repos.
 */
function expandHomePrefix(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * The entries a daemon should SERVE: {@link readRegistryRaw} minus roots that
 * must never be treated as a project.
 *
 * `$HOME` is filtered on READ, not only rejected on write, because installs
 * that registered home before `assertRegistrableRoot` existed already carry the
 * bad entry on disk and must not serve it even once more. Filtering here is
 * side-effect free — the entry stays in the FILE until `pruneStaleProjects`
 * removes it deliberately and says so.
 *
 * The `isAbsolute` test is load-bearing, not belt-and-braces: `readRegistryRaw`
 * now PRESERVES an unrepairable hand-edited root like `code/myrepo`, and
 * `isRegistrableRoot` would `resolve()` it against whatever cwd the daemon
 * happens to have started in — serving an arbitrary directory.
 */
export function readRegistry(): ProjectEntry[] {
  return readRegistryRaw().filter((e) => isAbsolute(e.root) && isRegistrableRoot(e.root));
}

/**
 * True when two roots name the SAME repo.
 *
 * Use this instead of `a === b` anywhere a registry root is compared against a
 * root that came from somewhere else. `registerProject` stores the canonical
 * (realpath'd) spelling, while `detectRepoRoot` returns a `resolve`d but NOT
 * realpath'd one, so on any path with a symlinked component (`/tmp` →
 * `/private/tmp` on macOS, autofs/NFS homes) the two strings differ for one
 * repo. A raw `===` there loads that repo twice — two watchers and two `Db`
 * handles on one `.hayven/index.sqlite` WAL.
 */
export function sameProjectRoot(a: string, b: string): boolean {
  return canonicalRoot(a) === canonicalRoot(b);
}

/** Non-throwing form of `assertRegistrableRoot`. */
export function isRegistrableRoot(root: string, opts: { homeDir?: string } = {}): boolean {
  try {
    assertRegistrableRoot(root, opts);
    return true;
  } catch {
    return false;
  }
}

/** Atomically persist the registry (creates `~/.hayven/` if needed). */
export function writeRegistry(entries: ProjectEntry[]): void {
  // Take the lock here too, not only in the read → modify → write callers, so a
  // direct write is still mutually exclusive with a concurrent `registerProject`
  // in another process. Re-entrant, so the nested acquire from those callers is
  // a no-op rather than a self-deadlock.
  withRegistryLock(() => writeRegistryUnlocked(entries));
}

function writeRegistryUnlocked(entries: ProjectEntry[]): void {
  const dir = globalHayvenDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ version: REGISTRY_VERSION, projects: entries }, null, 2) + "\n";
  const file = registryFile();
  // UNIQUE tmp name, not a fixed `${file}.tmp`. `writeFileSync` is not atomic,
  // so two concurrent writers (a `daemon start` prune racing a `hayven init` or
  // `daemon register` in another shell) sharing one tmp path can interleave —
  // a shorter body leaves trailing bytes from a longer one, and the rename then
  // publishes that mixed file perfectly atomically. Same directory as the
  // target, so the rename is always within one filesystem (never EXDEV).
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    // Extend the lease BEFORE the write, so a slow `writeFileSync` (a big
    // registry on a cold network home) cannot itself age the lock past
    // LOCK_STALE_MS and invite a reclaim.
    renewRegistryLock();
    writeFileSync(tmp, body);
    // LAST CHANCE: prove we still hold the lock immediately before publishing.
    // If it was reclaimed while this section was blocked, the reclaimer's writer
    // may already have published from a read that predates our change, and this
    // rename would silently clobber it — the lost registration the lock exists
    // to prevent. Bail instead; `withRegistryLock` re-acquires and re-runs the
    // whole read → modify → write.
    if (!renewRegistryLock() && !lastChanceWrite) throw new RegistryLockLostError();
    // Rename is atomic within a filesystem; avoids a torn read by a concurrent
    // daemon. (This used to `writeFileSync(file, body)` directly — non-atomic
    // despite the comment, and it left a stray `projects.json.tmp` behind.)
    renameSync(tmp, file);
  } catch (err) {
    // Never leave the scratch file behind on a failed write.
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Derive a unique alias for `root`: start from an explicit `preferred` (or the
 * repo's directory name) and append `-2`, `-3`, … if that handle is already
 * taken by a DIFFERENT root.
 */
export function deriveAlias(root: string, preferred: string | undefined, taken: ProjectEntry[]): string {
  const base = sanitizeAlias(preferred && preferred.length > 0 ? preferred : basename(root));
  const byAlias = new Map(taken.map((e) => [e.alias, e.root]));
  // If the base alias is free, or already points at THIS root, use it.
  //
  // RAW string comparison, deliberately, and re-checked as part of the
  // canonical-form sweep: the `=== root` arm is unreachable in both callers.
  // `registerProject` filters every same-repo entry into `others` before
  // calling, and `readRegistryRaw`'s repair loop has already deduped rows by
  // CANONICAL key, so no member of `taken` can be a symlink-equivalent spelling
  // of `root`. Canonicalizing here instead would mean a `realpathSync` per
  // candidate inside the repair loop — O(n²) syscalls on exactly the pathology
  // that loop exists for (measured at 1,200 rows sharing one alias).
  const existing = byAlias.get(base);
  if (existing === undefined || existing === root) return base;
  // Unbounded loop, deliberately: it terminates by pigeonhole. `taken` holds at
  // most `taken.length` distinct aliases, so among the `taken.length + 1`
  // candidates `base-2 … base-(taken.length+2)` at least one is free.
  //
  // The old version gave up after 999 tries and fell back to
  // `${base}-${Date.now()}` — which is NOT unique: `readRegistryRaw`'s repair
  // loop calls this once per duplicate row and easily makes several calls
  // within one millisecond. Measured on 1,200 rows sharing an alias: only
  // 1,018 distinct aliases came back, i.e. it emitted duplicates despite
  // uniqueness being the entire reason the repair exists — and
  // `cli/daemon.ts`'s `runtimes.set(alias, …)` then silently drops a project
  // per collision.
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    const owner = byAlias.get(candidate);
    if (owner === undefined || owner === root) return candidate;
  }
}

/**
 * Roots that must NEVER enter the registry.
 *
 * `$HOME` is the dangerous one. `~/.hayven` is the GLOBAL config dir, so any
 * "is this a Hayvenhurst project?" check shaped like `[ -d .hayven ]` answers
 * YES when the cwd happens to be the home dir. `detectRepoRoot` already refuses
 * to call home a `hayven`/`git` root, but it still falls through to
 * `cwd-fallback` — which returns `$HOME` itself. A daemon started from `~` then
 * registered home as a project and indexed the user's ENTIRE tree
 * (site-packages, caches, every repo at once), pegging a core and re-ingesting
 * in a watcher-overflow → full-reingest → parse-timeout loop.
 *
 * This is the chokepoint for PERSISTENCE — the single place a root becomes
 * durable, so a bad root caught here cannot survive a restart. It is NOT the
 * chokepoint for the CPU/disk damage: the daemonless commands walk and index a
 * tree without ever touching the registry, so `requireProject` in
 * `cli/_shared.ts` and `hayven init` guard separately. Keep all three in step.
 */
export function assertRegistrableRoot(root: string, opts: { homeDir?: string } = {}): void {
  const abs = resolve(root);
  // Compare CANONICAL forms, not raw paths. `homedir()` returns the passwd
  // string with symlinks intact, but every caller feeds this a realpath'd root
  // (`canonicalRoot`, or `process.cwd()`, which is already physical). On a host
  // where `$HOME` has a symlinked component — `/home/x` → `/mnt/…`, autofs/NFS
  // homes, a relocated macOS home — the two spellings differ and a raw `===`
  // compares unequal, letting the ORIGINAL bug straight through. Check both
  // spellings so neither direction escapes.
  //
  // Guard `homedir()` AND `hayvenHomeDir()`: they are different things.
  // `$HAYVEN_HOME` says where global state lives; it does NOT make the user's
  // real home safe to index. Someone who relocates state must not lose the
  // guard on their actual home dir.
  const homes =
    opts.homeDir !== undefined ? [opts.homeDir] : [homedir(), hayvenHomeDir()];
  for (const home of homes) {
    if (sameDir(abs, home)) {
      throw new Error(
        `refusing to register the home directory (${abs}) as a project — ` +
          "`~/.hayven` is the global config dir, not a project marker. " +
          "cd into a repository and run the command there.",
      );
    }
  }
  if (abs === dirname(abs) || canonicalRoot(abs) === dirname(canonicalRoot(abs))) {
    throw new Error(`refusing to register the filesystem root (${abs}) as a project.`);
  }
}

/** True when two paths name the same directory, comparing symlink-resolved forms. */
function sameDir(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  return canonicalRoot(a) === canonicalRoot(b);
}

/**
 * Registry hygiene, run at daemon start. Removes:
 *   - roots that must never be served (a `$HOME` entry from a pre-guard install)
 *   - roots that have been missing for longer than {@link STALE_GRACE_MS}
 *
 * Ephemeral roots (a test's `mktemp -d`, a deleted or renamed checkout) would
 * otherwise accumulate forever: nothing ever removed them, so every daemon
 * start re-read a registry that had grown to hundreds of dead `/tmp` paths.
 *
 * A currently-missing root inside the grace window is NOT removed; it is
 * stamped with `missing_since` and kept, and the stamp is cleared the moment it
 * comes back. That is what makes an unmounted drive survive.
 *
 * Every entry is stat'd EXACTLY ONCE. An earlier version stat'd twice — once to
 * build the keep-list, once to build the removed-list — so a directory that
 * reappeared between the two passes was deleted from the file while being
 * reported as removed by nobody, destroying an entry with no user-visible
 * trace. Returns what was removed so the caller can name it.
 */
export function pruneStaleProjects(nowMs: number = Date.now()): ProjectEntry[] {
  // Stat every root BEFORE taking the lock. `isDirectory` on an unmounted
  // SMB/NFS share or a cold autofs path — exactly the case the grace window
  // exists to protect — blocks for tens of seconds, and holding the lock across
  // that would age it past LOCK_STALE_MS and let another writer reclaim it
  // mid-critical-section. The locked part below is then only a JSON read and a
  // rename.
  const present = new Map<string, boolean>();
  // IDENTITY BACKFILL, in the same pre-lock pass and for the same reason: the
  // config read is another filesystem round trip on a possibly-slow mount. This
  // is what makes auto-relocation work for repos registered before `id`
  // existed: every daemon start records the identity of each root it can still
  // see, so by the time a repo is MOVED its old row already knows who it was.
  // A row that went missing before any upgraded daemon ever saw it has no id,
  // and `registerProjectDetailed` deliberately refuses to guess for it.
  const identities = new Map<string, string | undefined>();
  for (const entry of readRegistryRaw()) {
    if (isAbsolute(entry.root) && !present.has(entry.root)) {
      const isDir = isDirectory(entry.root);
      present.set(entry.root, isDir);
      if (isDir) identities.set(entry.root, readProjectIdentity(entry.root));
    }
  }
  return withRegistryLock(() => {
    const entries = readRegistryRaw();
    const keep: ProjectEntry[] = [];
    const removed: ProjectEntry[] = [];

    for (const entry of entries) {
      // HEARTBEAT. The pre-lock pass covers most roots, but the
      // `?? isDirectory(entry.root)` fallback below still stats INSIDE the lock
      // for any row that appeared between the two reads — and one cold
      // SMB/autofs stat there is tens of seconds, i.e. several times
      // LOCK_STALE_MS. Touching the lockfile each iteration is what stops a
      // live holder being reclaimed halfway through its own prune.
      renewRegistryLock();
      // A preserved hand-edited row (non-absolute root) is untouchable: we can
      // neither serve it nor stat it, and `isRegistrableRoot`/`isDirectory`
      // below would `resolve()` it against the daemon's cwd and then evict it
      // for being "missing". Carry it through unchanged. MUST stay first.
      if (!isAbsolute(entry.root)) {
        keep.push(entry);
        continue;
      }
      if (!isRegistrableRoot(entry.root)) {
        removed.push(entry);
        continue;
      }
      // Re-read INSIDE the lock, so a concurrent write is not clobbered; the
      // presence answer comes from the pre-lock pass, with a stat fallback for
      // a root that only appeared in the file between the two reads.
      if (present.get(entry.root) ?? isDirectory(entry.root)) {
        // Present: clear any stale-eviction countdown, and record the identity
        // we read before the lock. REFRESHED, not only filled in when absent:
        // the id describes whatever repo lives at `root` NOW (a deleted and
        // re-`init`ed `.hayven/` mints a new writer_id), and a stale id would
        // let a later move fail to match. An unreadable identity, or a row that
        // only appeared between the two reads, keeps what it had.
        keep.push(makeEntry(entry.alias, entry.root, identities.get(entry.root) ?? entry.id));
        continue;
      }
      const since = graceStartMs(entry.missing_since, nowMs);
      if (since !== null && nowMs - since > STALE_GRACE_MS) {
        removed.push(entry);
        continue;
      }
      keep.push(
        makeEntry(
          entry.alias,
          entry.root,
          entry.id,
          since !== null ? entry.missing_since : new Date(nowMs).toISOString(),
        ),
      );
    }

    // Compare against the raw entries so a cleared/added `missing_since` is
    // persisted too, not just outright removals.
    if (JSON.stringify(keep) !== JSON.stringify(entries)) writeRegistry(keep);
    return removed;
  });
}

/**
 * The instant a missing root's grace window started, or `null` when the stamp
 * cannot be trusted and the caller should re-stamp to now.
 *
 * Clock skew breaks the window in BOTH directions, and both were reproduced:
 *   - A stamp in the FUTURE (clock set back after stamping, VM snapshot) keeps
 *     `nowMs - since` negative forever, so the entry is NEVER evicted.
 *   - A wildly PAST stamp (dead RTC at boot, then an NTP correction) makes the
 *     first miss look ~26 years old and evicts immediately — exactly what the
 *     grace window exists to prevent.
 * Both resolve to "re-stamp and require a real observed absence", which is the
 * data-preserving direction: the worst case is one extra grace window.
 */
function graceStartMs(stamp: string | undefined, nowMs: number): number | null {
  if (stamp === undefined) return null;
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return null;
  if (parsed > nowMs) return null;
  if (nowMs - parsed > IMPLAUSIBLE_MISSING_AGE_MS) return null;
  return parsed;
}

/** What {@link registerProjectDetailed} did, so a caller can SAY it. */
export interface RegisterOutcome {
  /** The entry now on disk for this root. */
  readonly entry: ProjectEntry;
  /**
   * Set when an existing row was RE-POINTED here instead of a new one being
   * minted: the root that row used to name. The alias was kept.
   */
  readonly relocatedFrom?: string;
  /**
   * Set when this looks like a moved repo but the registry cannot prove it: the
   * alias this root would naturally get is held by a row whose root is missing
   * and whose identity is unknown or different (or several missing rows share
   * this identity). The root was registered normally — usually as `<alias>-N`
   * — and the caller should print the exact `hayven projects relocate` command.
   */
  readonly ambiguousWith?: ProjectEntry;
}

/**
 * Register `root` (resolved to absolute). Idempotent by root: re-registering an
 * already-known root returns its existing entry unchanged unless `alias` asks
 * to rename it. Returns the resulting entry.
 *
 * Throws for roots that must never be registered (see `assertRegistrableRoot`).
 * Thin wrapper over {@link registerProjectDetailed}, kept so every existing
 * caller that only needs the entry is untouched.
 */
export function registerProject(root: string, alias?: string): ProjectEntry {
  return registerProjectDetailed(root, alias).entry;
}

/**
 * {@link registerProject}, plus AUTO-RELOCATION of a moved repo.
 *
 * THE BUG (reproduced on the owner's machine): `mv ~/code/lydgr ~/work/lydgr`,
 * then any daemon start from the new location registered it as `lydgr-2`,
 * kept `lydgr` as a missing ghost for the 7-day grace window, and the only fix
 * was hand-editing `projects.json`. Every tool that had learned the alias
 * `lydgr` (viewer bookmarks, `?project=lydgr`, agents' `x-hayven-project`)
 * silently stopped resolving.
 *
 * THE RULE: for a root that is NOT already registered, if exactly ONE row has
 * an absolute root that is missing right now AND carries the same identity
 * (`writer_id`, which moved with the repo) as the new root, that row is
 * RE-POINTED here: same alias (unless the caller asked for one), same id,
 * `missing_since` cleared. Every condition is load-bearing:
 *   - "not already registered": a root that has its own row is never merged
 *     into another; that would be a rename nobody asked for.
 *   - "missing right now": a PRESENT row with the same id is a COPY of the
 *     repo (`cp -r` copies `.hayven/config.json` too). Both are real; stealing
 *     the original's alias for the copy would be wrong.
 *   - "exactly one": two missing rows with one identity means the history is
 *     already tangled. Picking either is a guess, and a wrong guess silently
 *     re-points somebody's alias, so we register normally and report it.
 *   - "same identity": a missing row that merely shares the FOLDER NAME (or has
 *     no id, because it went missing before any upgraded daemon saw it) is not
 *     evidence. It is reported as `ambiguousWith` so the caller can print the
 *     one-line `hayven projects relocate` fix, never acted on.
 *
 * Stats are kept OUTSIDE the lock and to the minimum, for the reasons spelled
 * out on `pruneStaleProjects`: this also runs inside the daemon's event loop on
 * `POST /api/projects`, so only rows that are actual candidates (same identity,
 * or holding the alias we would pick) are ever stat'd, never the whole file.
 */
export function registerProjectDetailed(root: string, alias?: string): RegisterOutcome {
  // CANONICALIZE on the way in — do not store the caller's spelling. An
  // already-absolute path used to be stored verbatim, so `registerProject(r)`
  // followed by `registerProject(r + "/")` produced TWO entries (`myrepo` and
  // `myrepo-2`) for one repo, both served. `detectRepoRoot` output is
  // `resolve()`d but never realpath'd, so a symlinked checkout did the same.
  const abs = canonicalRoot(isAbsolute(root) ? root : resolve(process.cwd(), root));
  assertRegistrableRoot(abs);
  const identity = readProjectIdentity(abs);
  const baseAlias = sanitizeAlias(alias && alias.length > 0 ? alias : basename(abs));
  const isCandidate = (e: ProjectEntry): boolean =>
    isAbsolute(e.root) && ((identity !== undefined && e.id === identity) || e.alias === baseAlias);
  const present = new Map<string, boolean>();
  for (const e of readRegistryRaw()) {
    if (isCandidate(e) && !present.has(e.root)) present.set(e.root, isDirectory(e.root));
  }
  return withRegistryLock(() => {
    // RAW, not the filtered view: this is a read → modify → write, and rewriting
    // from a filtered list would silently delete whatever the filter hid.
    const entries = readRegistryRaw();
    const isSameRepo = (e: ProjectEntry): boolean =>
      isAbsolute(e.root) && canonicalRoot(e.root) === abs;
    const existing = entries.find(isSameRepo);
    if (existing) {
      // BACKFILL/REFRESH the identity of an already-registered root. Same
      // reasoning as in `pruneStaleProjects`; doing it here too means a repo
      // registered by `hayven init` gets its id on the very next register,
      // rather than waiting for a daemon restart.
      const id = identity ?? existing.id;
      if (!alias && id === existing.id) return { entry: existing };
      const others = entries.filter((e) => !isSameRepo(e));
      const finalAlias = alias ? deriveAlias(abs, alias, others) : existing.alias;
      // Carry `missing_since` across a rename. Rebuilding the entry from scratch
      // dropped it, so renaming the alias of a currently-missing root silently
      // restarted its 7-day eviction countdown.
      const entry = makeEntry(finalAlias, abs, id, existing.missing_since);
      writeRegistry([...others, entry].sort((a, b) => a.alias.localeCompare(b.alias)));
      return { entry };
    }

    // A row is "missing" only on an observed absence. The fallback stat covers
    // a candidate that appeared between the pre-lock read and this one.
    const isMissing = (e: ProjectEntry): boolean =>
      isAbsolute(e.root) && !(present.get(e.root) ?? isDirectory(e.root));
    const sameIdentity =
      identity === undefined ? [] : entries.filter((e) => e.id === identity && isMissing(e));

    if (sameIdentity.length === 1) {
      const moved = sameIdentity[0]!;
      const others = entries.filter((e) => e !== moved);
      // The moved row's alias is unique already (it held it), so it needs no
      // `deriveAlias`. An explicit alias is honored exactly as a plain register
      // would honor it.
      const finalAlias = alias ? deriveAlias(abs, alias, others) : moved.alias;
      const entry = makeEntry(finalAlias, abs, identity);
      writeRegistry([...others, entry].sort((a, b) => a.alias.localeCompare(b.alias)));
      return { entry, relocatedFrom: moved.root };
    }

    const holder = entries.find((e) => e.alias === baseAlias);
    const ambiguousWith =
      holder !== undefined && isMissing(holder) ? holder : sameIdentity.length > 1 ? sameIdentity[0] : undefined;
    const entry = makeEntry(deriveAlias(abs, alias, entries), abs, identity);
    writeRegistry([...entries, entry].sort((a, b) => a.alias.localeCompare(b.alias)));
    return ambiguousWith !== undefined ? { entry, ambiguousWith } : { entry };
  });
}

/**
 * Record the CURRENT identity of each of `roots` on its registry row (when the
 * row exists and the id changed). Never creates rows. Writes only on change.
 *
 * WHY a separate call, after a daemon has opened its projects: the identity is
 * minted by `CrdtState` (`loadOrCreateWriterId`) the first time a daemon opens
 * a project, which is AFTER the start-time prune and register have already
 * read it. Without this, a freshly `init`ed repo would only learn its id on
 * the NEXT daemon start, and moving it before then (while it is being served)
 * would still produce `<alias>-2`.
 */
export function recordProjectIdentities(roots: readonly string[]): void {
  const found = new Map<string, string>();
  for (const root of roots) {
    const id = readProjectIdentity(root);
    if (id !== undefined) found.set(canonicalRoot(root), id);
  }
  if (found.size === 0) return;
  withRegistryLock(() => {
    const entries = readRegistryRaw();
    let changed = false;
    const next = entries.map((e) => {
      if (!isAbsolute(e.root)) return e;
      const id = found.get(canonicalRoot(e.root));
      if (id === undefined || id === e.id) return e;
      changed = true;
      return makeEntry(e.alias, e.root, id, e.missing_since);
    });
    if (changed) writeRegistry(next);
  });
}

// ---------------------------------------------------------------------------
// User-commanded mutations (`hayven projects rename|relocate|prune|remove`).
//
// Each one reads the RAW registry under the lock (same rule as every other
// writer here) and takes a timestamped BACKUP first. The routine daemon-start
// prune deliberately does not back up: it runs on every start, and ten
// identical copies of a healthy file would push out the one backup that
// mattered.
// ---------------------------------------------------------------------------

/**
 * How many `projects.json.hayven-backup-*` files survive. Newest first.
 *
 * Only OUR backups count toward the cap and only ours are ever deleted. People
 * already keep hand-made `projects.json.bak-*` copies next to the registry
 * (from hand-editing it before this command existed); a cap that matched those
 * would quietly delete a user's own backup ten mutations later.
 */
const BACKUPS_KEPT = 10;

/** `YYYYMMDD-HHMMSS` in LOCAL time, the stamp format of hand-made backups too. */
function backupStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Copy `projects.json` to `projects.json.hayven-backup-YYYYMMDD-HHMMSS` (suffixed `-2`,
 * `-3`, … when two mutations land in one second) and keep only the newest
 * {@link BACKUPS_KEPT}. Returns the backup path, or null when there was no file
 * to back up.
 *
 * WHY: every command below rewrites registrations the user built up over time,
 * and until now the only undo was a backup made by hand before hand-editing.
 * Written with read + write rather than `copyFileSync`, because on macOS the
 * copy preserves the SOURCE mtime, and the cap below orders by mtime.
 *
 * Exported for tests. Must be called INSIDE `withRegistryLock`, so the copy is
 * the exact state the mutation then replaces.
 */
export function backupRegistry(now: Date = new Date()): string | null {
  const file = registryFile();
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    return null; // nothing registered yet: nothing to lose
  }
  const base = `${file}.hayven-backup-${backupStamp(now)}`;
  // Next suffix = ONE MORE THAN THE HIGHEST already present, not the first
  // free one. Once the cap below has deleted the oldest backup of a second,
  // "first free" would hand its name (the bare stamp) to the NEWEST copy, and
  // anyone reading the names would restore the wrong one.
  let highest = 0;
  try {
    const stem = basename(base);
    for (const name of readdirSync(dirname(base))) {
      if (name === stem) highest = Math.max(highest, 1);
      const m = name.startsWith(`${stem}-`) ? /^(\d+)$/.exec(name.slice(stem.length + 1)) : null;
      if (m) highest = Math.max(highest, Number(m[1]));
    }
  } catch {
    /* unreadable dir: the `wx` write below still refuses to overwrite */
  }
  let target = highest === 0 ? base : `${base}-${highest + 1}`;
  // `wx`: never overwrite, even if another process won the same name between
  // the existsSync and here. Losing that race costs one retry, not a backup.
  try {
    writeFileSync(target, body, { flag: "wx" });
  } catch {
    target = `${base}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(target, body, { flag: "wx" });
  }
  trimBackups();
  return target;
}

/** Keep the newest {@link BACKUPS_KEPT} backups; best-effort, never throws. */
function trimBackups(): void {
  try {
    const dir = globalHayvenDir();
    const prefix = `${basename(registryFile())}.hayven-backup-`;
    const backups = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => {
        const path = join(dir, name);
        let mtime = 0;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          /* vanished: sorts oldest and is skipped by rmSync's force */
        }
        return { path, name, mtime };
      })
      // Newest first by mtime; the name breaks ties NUMERICALLY so `-10` sorts
      // after `-9` (a plain string compare puts it before `-2`).
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name, undefined, { numeric: true }));
    for (const old of backups.slice(BACKUPS_KEPT)) rmSync(old.path, { force: true });
  } catch {
    /* a leftover backup is clutter, never a failure */
  }
}

/** `{ entry, previous }`: the row after and before a rename/relocate. */
export interface RegistryChange {
  readonly entry: ProjectEntry;
  readonly previous: ProjectEntry;
  /** Path of the backup taken first, or null if nothing changed / no file. */
  readonly backup: string | null;
}

/** The "no such alias" error every alias-taking mutation shares. */
function unknownAliasError(alias: string, entries: readonly ProjectEntry[]): Error {
  const known = entries.map((e) => e.alias);
  return new Error(
    `no registered project with the alias "${alias}". Registered aliases: ` +
      `${known.length > 0 ? known.join(", ") : "(none registered)"}.`,
  );
}

/**
 * Rename a project's alias. Keeps its root, id and `missing_since`.
 *
 * REFUSES rather than silently sanitizing. Every other path into the registry
 * sanitizes (`My Repo` becomes `my-repo`), which is right for a name derived
 * from a folder and wrong for a name the user just TYPED: they would go on
 * using `My Repo` in `?project=` and get nothing back. Saying what it would
 * become lets them retype it deliberately.
 *
 * `dryRun` runs every check and returns the would-be result without writing,
 * so the CLI can validate BEFORE it stops a live daemon from serving the
 * project (a refusal must cost nothing).
 *
 * REFUSES a collision rather than suffixing it. `register` appends `-2`
 * because it is choosing a name on the user's behalf; here the user chose one,
 * and `-2` is precisely the outcome this command exists to undo.
 */
export function renameProject(
  oldAlias: string,
  newAlias: string,
  opts: { dryRun?: boolean } = {},
): RegistryChange {
  const wanted = newAlias.trim();
  const clean = sanitizeAlias(wanted);
  if (wanted.length === 0 || clean !== wanted) {
    throw new Error(
      `"${newAlias}" is not a valid alias: aliases are lowercase letters, digits, '.', '_' and '-'. ` +
        `It would become "${clean}"; run the command again with that if it is what you want.`,
    );
  }
  return withRegistryLock(() => {
    const entries = readRegistryRaw();
    const previous = entries.find((e) => e.alias === oldAlias);
    if (!previous) throw unknownAliasError(oldAlias, entries);
    if (oldAlias === clean) return { entry: previous, previous, backup: null };
    const holder = entries.find((e) => e.alias === clean);
    if (holder) {
      throw new Error(
        `the alias "${clean}" is already used by ${holder.root}. ` +
          `Rename or remove that one first (\`hayven projects remove ${clean}\`).`,
      );
    }
    const entry = makeEntry(clean, previous.root, previous.id, previous.missing_since);
    if (opts.dryRun === true) return { entry, previous, backup: null };
    const backup = backupRegistry();
    writeRegistry(
      entries.map((e) => (e === previous ? entry : e)).sort((a, b) => a.alias.localeCompare(b.alias)),
    );
    return { entry, previous, backup };
  });
}

/** {@link RegistryChange} plus the row a relocation displaced, if any. */
export interface RelocateOutcome extends RegistryChange {
  /**
   * A DIFFERENT alias that was already registered at the new root and has been
   * removed, because one root cannot be served under two aliases. This is the
   * `lydgr` / `lydgr-2` repair: relocating `lydgr` onto the `-2` row's root
   * folds the two back into one.
   */
  readonly replaced?: ProjectEntry;
}

/**
 * Point `alias` at `newRoot`: the manual form of auto-relocation, for the
 * cases it deliberately refuses to guess at (no recorded identity, folder name
 * reused, several candidates). Keeps the alias; clears `missing_since`.
 *
 * `dryRun`: as for {@link renameProject}.
 *
 * GUARDED BY IDENTITY: when both the row's stored id and the target's identity
 * are known and they differ, this refuses without `force`. That combination
 * means the target is a different repo (or a fresh `init` of the same one),
 * and re-pointing a well-known alias at it would silently answer every query
 * for that alias from the wrong codebase. An UNKNOWN identity on either side is
 * not a mismatch: that is exactly the pre-`id` registry this command exists to
 * repair.
 */
export function relocateProject(
  alias: string,
  newRoot: string,
  opts: { force?: boolean; dryRun?: boolean } = {},
): RelocateOutcome {
  const abs = canonicalRoot(isAbsolute(newRoot) ? newRoot : resolve(process.cwd(), newRoot));
  assertRegistrableRoot(abs);
  if (!isDirectory(abs)) throw new Error(`${abs} is not a directory`);
  if (!isDirectory(join(abs, ".hayven"))) {
    throw new Error(
      `${abs} has no .hayven/ directory, so it is not a Hayvenhurst project. ` +
        "Run `hayven init` there first, or check the path.",
    );
  }
  const identity = readProjectIdentity(abs);
  return withRegistryLock(() => {
    const entries = readRegistryRaw();
    const previous = entries.find((e) => e.alias === alias);
    if (!previous) throw unknownAliasError(alias, entries);
    if (
      previous.id !== undefined &&
      identity !== undefined &&
      previous.id !== identity &&
      opts.force !== true
    ) {
      throw new Error(
        `${abs} is a different project than "${alias}" was: its .hayven/config.json writer_id is ` +
          `${identity}, but "${alias}" was registered with ${previous.id}. ` +
          "If you re-ran `hayven init` there or are sure it is the same repo, re-run with --force.",
      );
    }
    const isAtTarget = (e: ProjectEntry): boolean => isAbsolute(e.root) && canonicalRoot(e.root) === abs;
    const replaced = entries.find((e) => e !== previous && isAtTarget(e));
    // The id describes what lives at the target NOW; fall back to the row's own
    // only when the target has none yet (a project the daemon never started in).
    const entry = makeEntry(alias, abs, identity ?? previous.id);
    if (replaced === undefined && JSON.stringify(entry) === JSON.stringify(previous)) {
      return { entry, previous, backup: null };
    }
    if (opts.dryRun === true) {
      return replaced !== undefined ? { entry, previous, backup: null, replaced } : { entry, previous, backup: null };
    }
    const backup = backupRegistry();
    const next = entries
      .filter((e) => e !== replaced)
      .map((e) => (e === previous ? entry : e))
      .sort((a, b) => a.alias.localeCompare(b.alias));
    writeRegistry(next);
    return replaced !== undefined ? { entry, previous, backup, replaced } : { entry, previous, backup };
  });
}

/** What {@link pruneMissingProjects} removed (or, on a dry run, would remove). */
export interface PruneOutcome {
  readonly removed: ProjectEntry[];
  readonly backup: string | null;
}

/**
 * Remove every row whose absolute root is missing RIGHT NOW and, when
 * `minMissingMs > 0`, has carried `missing_since` for at least that long.
 *
 * Different from `pruneStaleProjects` (the daemon-start hygiene) on purpose:
 * that one must assume an absence might be an unmounted drive and waits out a
 * week; this one is a person saying "I know these are gone". Even so:
 *   - The CURRENT stat decides, never a stale `missing_since` alone: a drive
 *     that has been remounted since the last daemon start is present and stays.
 *   - With a minimum age, a row with no (or an implausible) `missing_since`
 *     is KEPT. We have no evidence of how long it has been gone, and the
 *     data-preserving answer to "unknown" is no.
 *   - Non-absolute hand-edited rows are never touched: they cannot be stat'd
 *     and would otherwise read as missing.
 */
export function pruneMissingProjects(
  opts: { minMissingMs?: number; nowMs?: number; dryRun?: boolean } = {},
): PruneOutcome {
  const minMissingMs = opts.minMissingMs ?? 0;
  const nowMs = opts.nowMs ?? Date.now();
  // Stat outside the lock, as `pruneStaleProjects` does and for the same reason.
  const present = new Map<string, boolean>();
  for (const e of readRegistryRaw()) {
    if (isAbsolute(e.root) && !present.has(e.root)) present.set(e.root, isDirectory(e.root));
  }
  const doomed = (e: ProjectEntry): boolean => {
    if (!isAbsolute(e.root)) return false;
    if (present.get(e.root) ?? isDirectory(e.root)) return false;
    if (minMissingMs <= 0) return true;
    const since = graceStartMs(e.missing_since, nowMs);
    return since !== null && nowMs - since >= minMissingMs;
  };
  if (opts.dryRun === true) return { removed: readRegistryRaw().filter(doomed), backup: null };
  return withRegistryLock(() => {
    const entries = readRegistryRaw();
    const removed = entries.filter(doomed);
    if (removed.length === 0) return { removed, backup: null };
    const backup = backupRegistry();
    writeRegistry(entries.filter((e) => !removed.includes(e)));
    return { removed, backup };
  });
}

/**
 * How an `unregister` argument was interpreted. EXACTLY ONE of the two, never
 * both — see {@link classifyUnregisterArg}.
 */
export type UnregisterTarget =
  | { readonly kind: "alias"; readonly alias: string }
  /** `given` is the user's spelling; `root` is its canonical absolute form. */
  | { readonly kind: "path"; readonly given: string; readonly root: string };

/**
 * Decide whether an `unregister` argument is an ALIAS or a PATH. Never both.
 *
 * THE BUG THIS FIXES (silent data loss): the argument used to be resolved
 * against `process.cwd()` AND matched against every entry's root, on top of the
 * alias match. So with a registry of `[{alias:"zzz", root:"$SB/real/repo"}]` and
 * a cwd of `$SB/real`, `unregisterProject("repo")` resolved `"repo"` to
 * `$SB/real/repo`, matched `zzz` by ROOT, and deleted it — reporting success.
 * `hayven daemon unregister myproject` from a parent folder therefore removed a
 * DIFFERENT project than the one named, with no way for the user to tell.
 *
 * THE RULE: an argument that LOOKS like a path is a path; anything else is an
 * alias, and a bare name is NEVER resolved against the cwd. "Looks like a path"
 * means absolute, `~`-rooted, `.`/`..`, or containing a separator. That is
 * unambiguous rather than merely conventional: `sanitizeAlias` strips `/` and
 * `\` out of every alias this module writes, so no alias can collide with the
 * path form — the two namespaces cannot overlap.
 */
export function classifyUnregisterArg(aliasOrRoot: string, cwd: string = process.cwd()): UnregisterTarget {
  const arg = aliasOrRoot.trim();
  const looksLikePath =
    isAbsolute(arg) ||
    arg === "~" ||
    arg.startsWith("~/") ||
    arg === "." ||
    arg === ".." ||
    /[\\/]/.test(arg);
  if (!looksLikePath) return { kind: "alias", alias: arg };
  const expanded = expandHomePrefix(arg);
  return {
    kind: "path",
    given: arg,
    root: canonicalRoot(isAbsolute(expanded) ? expanded : resolve(cwd, expanded)),
  };
}

/** The result of an unregister attempt, with a message fit to print verbatim. */
export interface UnregisterOutcome {
  readonly removed: boolean;
  readonly target: UnregisterTarget;
  /** One line, no trailing newline. Explains WHICH interpretation was used. */
  readonly message: string;
  /** The rows that were removed (empty when nothing matched). */
  readonly removedEntries: readonly ProjectEntry[];
  /** The backup taken first, when `opts.backup` asked for one and a row went. */
  readonly backup: string | null;
}

/**
 * Remove a project by alias XOR path — the detailed form, so the CLI can say
 * which of the two it did and why nothing matched. Prefer this over
 * {@link unregisterProject} at any call site that prints to a user.
 */
export function unregisterProjectDetailed(
  aliasOrRoot: string,
  cwd: string = process.cwd(),
  opts: { backup?: boolean } = {},
): UnregisterOutcome {
  const target = classifyUnregisterArg(aliasOrRoot, cwd);
  return withRegistryLock(() => {
    // RAW for the same reason as `registerProject`: removing "x" must remove ONLY
    // "x", never everything the serve-time filter would have hidden.
    const entries = readRegistryRaw();
    const matches = (e: ProjectEntry): boolean =>
      target.kind === "alias"
        ? e.alias === target.alias
        : isAbsolute(e.root) && canonicalRoot(e.root) === target.root;
    const next = entries.filter((e) => !matches(e));
    if (next.length === entries.length) {
      return {
        removed: false,
        target,
        message: notFoundMessage(target, entries),
        removedEntries: [],
        backup: null,
      };
    }
    // Opt-in: `hayven projects remove` backs up, the older `hayven daemon
    // unregister` keeps its exact historical behavior.
    const backup = opts.backup === true ? backupRegistry() : null;
    writeRegistry(next);
    const what =
      target.kind === "alias"
        ? `alias "${target.alias}"`
        : `the project rooted at ${target.root}`;
    return {
      removed: true,
      target,
      message: `unregistered ${what}`,
      removedEntries: entries.filter(matches),
      backup,
    };
  });
}

/** Say what we looked for, how we read the argument, and what exists instead. */
function notFoundMessage(target: UnregisterTarget, entries: readonly ProjectEntry[]): string {
  if (target.kind === "alias") {
    const known = entries.map((e) => e.alias);
    const listed = known.length > 0 ? known.join(", ") : "(none registered)";
    return (
      `no registered project with the alias "${target.alias}". Registered aliases: ${listed}. ` +
      "A bare name is treated as an ALIAS only — to remove by location, pass a path " +
      `(e.g. ./${target.alias} or an absolute path).`
    );
  }
  return (
    `no registered project rooted at ${target.root} ` +
    `(read "${target.given}" as a path because it names one; a bare name would have been an alias).`
  );
}

/** Remove a project by alias XOR path. Returns true if something was removed. */
export function unregisterProject(aliasOrRoot: string): boolean {
  return unregisterProjectDetailed(aliasOrRoot).removed;
}
