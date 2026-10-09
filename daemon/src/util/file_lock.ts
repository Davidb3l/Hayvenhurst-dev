/**
 * A small advisory, cross-process lockfile — the SIMPLIFIED sibling of the
 * project-registry lock in `daemon/registry.ts`.
 *
 * Same core mechanism, for the same reasons (read the long comments there for
 * the incident history): `O_CREAT|O_EXCL` decides who creates the file, a
 * unique TOKEN written into it and read back makes a stale-reclaim race
 * detectable, and release only ever deletes a lockfile that still carries OUR
 * token. Staleness is "the lockfile's mtime has not changed for `staleMs` of
 * the WAITER'S OWN elapsed time" (never `Date.now() - mtime`, which mixes two
 * clocks on a network mount), short-circuited by "the pid written into it is
 * provably dead" so a crashed holder on this host is reclaimed at once.
 *
 * What is simplified away: the registry lock's in-process re-entrancy counter,
 * its lease-renewal-before-publish dance and its degrade-to-unlocked fallback.
 * The callers here (the per-project worktree registry and the per-overlay
 * refresh lock) are not on a path that must never fail the way `daemon start`
 * is, so a lock that cannot be taken inside the budget THROWS with a message
 * naming the file, instead of silently switching mutual exclusion off.
 *
 * The ASYNC variant is for long critical sections (an overlay re-ingest can run
 * for minutes). Its holder TOUCHES the lockfile on an interval so a waiter's
 * "unchanged for staleMs" rule never mistakes a slow-but-alive refresh for a
 * dead one.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { isAlive } from "../daemon/lifecycle.ts";

export interface FileLockOptions {
  /** Total time to wait for the lock before throwing {@link FileLockTimeoutError}. */
  readonly budgetMs: number;
  /** How long an UNCHANGED lockfile must sit (on our clock) before it is reclaimed. */
  readonly staleMs: number;
}

/** Thrown when a lock could not be taken inside its budget. */
export class FileLockTimeoutError extends Error {
  constructor(readonly path: string, budgetMs: number) {
    super(
      `could not take the lock ${path} within ${budgetMs}ms: another hayven process holds it. ` +
        "If no hayven process is running, delete that file.",
    );
    this.name = "FileLockTimeoutError";
  }
}

/**
 * Staleness window for a lockfile with NO readable owner token: empty (the
 * holder died between `open` and `write`) or garbage. Nobody can ever touch or
 * release such a file, so waiting out a long `staleMs` (two minutes for an
 * overlay refresh) would only stall every reader behind a corpse. A genuine
 * holder writes its token in the same breath as creating the file, so a few
 * seconds of an unchanged, ownerless file is already conclusive.
 */
const UNREADABLE_STALE_MS = 5_000;

/** How often an async holder refreshes the lockfile's mtime. Well under any sane `staleMs`. */
const TOUCH_INTERVAL_MS = 1_000;

function newToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
}

/** The lockfile's token line, or null when it is gone/unreadable. */
function readToken(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** The pid encoded at the front of a token (`<pid>.<ms>.<rand>`), or null. */
function tokenPid(token: string | null): number | null {
  if (token === null) return null;
  const pid = Number(token.split(".")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Try to create the lockfile with `token`. True only when WE now hold it. */
function tryCreate(path: string, token: string): boolean {
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, token + "\n");
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err; // read-only FS, bad perms, ENOSPC: a real error, say so
  }
  // Confirm a concurrent stale-reclaim did not delete our brand-new file.
  return readToken(path) === token;
}

/**
 * Delete `path` only if it still carries `expected`. Two waiters can both
 * conclude "stale"; re-reading the token immediately before the unlink keeps
 * the window to the unavoidable read→unlink gap, and the token check in
 * {@link tryCreate} turns the residual race into a retry, not a double entry.
 */
function reclaim(path: string, expected: string | null): void {
  if (readToken(path) !== expected) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // someone else reclaimed it first — fine
  }
}

/**
 * One acquisition step. Returns the token when acquired, otherwise updates the
 * staleness watch and returns null so the caller sleeps and retries.
 */
function step(
  path: string,
  watch: { mtime: number | null; since: number },
  opts: FileLockOptions,
): string | null {
  const token = newToken();
  if (tryCreate(path, token)) return token;
  const holder = readToken(path);
  const pid = tokenPid(holder);
  // A holder on this host whose pid is gone died mid-section: reclaim now
  // rather than making every waiter sit out the full stale window.
  if (pid !== null && pid !== process.pid && !isAlive(pid)) {
    reclaim(path, holder);
    watch.mtime = null;
    return null;
  }
  const mtime = mtimeOf(path);
  if (mtime === null) {
    watch.mtime = null; // vanished under us — retry immediately
  } else if (watch.mtime !== mtime) {
    watch.mtime = mtime; // first sighting, or the holder touched it
    watch.since = Date.now();
  } else if (Date.now() - watch.since >= (pid === null ? Math.min(opts.staleMs, UNREADABLE_STALE_MS) : opts.staleMs)) {
    reclaim(path, holder);
    watch.mtime = null;
  }
  return null;
}

function release(path: string, token: string): void {
  if (readToken(path) === token) {
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort
    }
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin — bounded by the caller's budget */
    }
  }
}

/** Run `fn` synchronously while holding the lockfile at `path`. */
export function withFileLockSync<T>(path: string, fn: () => T, opts: FileLockOptions): T {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + opts.budgetMs;
  const watch = { mtime: null as number | null, since: 0 };
  let token: string | null = null;
  while (token === null) {
    token = step(path, watch, opts);
    if (token !== null) break;
    if (Date.now() >= deadline) throw new FileLockTimeoutError(path, opts.budgetMs);
    sleepSync(5 + Math.floor(Math.random() * 15));
  }
  try {
    return fn();
  } finally {
    release(path, token);
  }
}

/**
 * Run async `fn` while holding the lockfile at `path`, touching it every
 * {@link TOUCH_INTERVAL_MS} so a long section never looks stale to a waiter.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, opts: FileLockOptions): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + opts.budgetMs;
  const watch = { mtime: null as number | null, since: 0 };
  let token: string | null = null;
  while (token === null) {
    token = step(path, watch, opts);
    if (token !== null) break;
    if (Date.now() >= deadline) throw new FileLockTimeoutError(path, opts.budgetMs);
    await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 50)));
  }
  const held = token;
  const touch = setInterval(() => {
    // Only touch a file that is still ours; never revive a successor's lock.
    if (readToken(path) !== held) return;
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // best-effort; worst case a waiter reclaims after staleMs
    }
  }, TOUCH_INTERVAL_MS);
  // Never keep the process alive just to touch a lockfile.
  (touch as { unref?: () => void }).unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(touch);
    release(path, held);
  }
}
