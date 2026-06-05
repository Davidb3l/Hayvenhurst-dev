/**
 * Staleness detection for the DAEMONLESS read path (`hayven query`/`neighbors`).
 *
 * `query`/`neighbors` open `.hayven/index.sqlite` read-only and answer without
 * the daemon. That is deliberately low-friction — but it means the index goes
 * SILENTLY stale once source files change while no watcher is running: the
 * commands keep returning rows from the OLD index with no indication they're
 * out of date. An agent that gets stale results once distrusts the tool and
 * falls back to grep — the exact failure we're fighting.
 *
 * This module makes staleness HONESTLY SURFACED on stderr without touching the
 * hot read path's stdout (so `--json` stays byte-identical and pipeable) and
 * without walking the source tree on every query.
 *
 * Design (lightest honest approach — DETECTION + warning only, no auto-refresh):
 *   1. The index already stores `last_ingest_at` (epoch ms) as a stat row
 *      (written by `graph/ingest.ts`). Reading it is one indexed key lookup.
 *   2. We compare it against a set of cheap `stat()` probes. The cheap O(1)
 *      probes (repo-root dir mtime + each top-level entry's mtime +
 *      `.git/{index,HEAD}`) catch the add/remove/rename + stage/commit cases.
 *      Those are NOT enough on their own: an IN-PLACE edit of an existing,
 *      deeply-nested file changes only THAT file's mtime — not its parent
 *      dir's and not any ancestor's — so the bounded probe set is structurally
 *      blind to "edit a tracked file, re-query before committing", the single
 *      most common loop. So we ALSO stat the project's tracked SOURCE files,
 *      with EARLY-EXIT against `last_ingest_at`: the scan returns the moment it
 *      finds ONE file newer than the last ingest. The stale case therefore
 *      stops at the first changed file (typically instant); only a genuinely
 *      fresh index pays the full scan, which is still bounded (see below) and
 *      stat-only — no file reads.
 *   3. If a daemon (hence its file watcher) is already running for THIS project
 *      — pidfile present and the pid alive — we suppress the warning entirely:
 *      the watcher owns freshness and any momentary lag is its job, not ours.
 *      That guard runs FIRST in `evaluateStaleness`, so a running daemon means
 *      we never stat the tree at all.
 *
 * Cost bound of the tracked-file scan (the new work): at most the file-scan cap
 * (default 4096, override `HAYVEN_FRESHNESS_MAX_FILES`) stat() calls, stat-only,
 * with first-newer-file early-exit. `git ls-files` (when this is a git repo)
 * yields exactly the tracked files cheaply; otherwise a bounded recursive walk
 * that SKIPS the directories in `SKIP_DIRS` (`.hayven`, `.git`, `node_modules`,
 * `dist`, `build`, `.next`, `coverage`). If the cap is hit WITHOUT finding a
 * newer file we DO NOT over-scan: we fall back to the cheap dir/git-probe result
 * rather than claim freshness we didn't verify (and rather than false-warn).
 *
 * SCALE NOTE (40k repos): a STALE repo is detected instantly (early-exit on the
 * first newer file, regardless of size); a FRESH repo larger than the cap is
 * reported fresh from the verified prefix — a deliberate, documented bound whose
 * only cost is a possibly-missed note (never a false-stale). Raise the cap via
 * the env override when verifying the whole tree on every read is worth the
 * extra stats. See {@link maxFilesScanned}.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { resolveReadIndex } from "./branch_index.ts";
import { Db } from "./queries.ts";
import { daemonStatus } from "../daemon/lifecycle.ts";
import { runIngest } from "../cli/ingest.ts";
import type { HayvenPaths } from "../util/paths.ts";
import type { ParsedArgs } from "../cli.ts";
import type { ProjectContext } from "../cli/_shared.ts";

/**
 * A clock + filesystem-mtime source, injectable so the predicate is testable.
 *
 * `newestSourceMtimeMs` takes an optional `sinceMs` early-exit threshold. When
 * provided, the probe MAY short-circuit and return the first mtime it observes
 * that exceeds `sinceMs` (the stale case is then instant) instead of computing
 * the true maximum; when nothing beats the threshold it returns the genuine
 * newest mtime among everything it scanned. Injected test probes are free to
 * ignore `sinceMs` and return a fixed value — the predicate only ever compares
 * the result against the same threshold, so either behavior is correct.
 */
export interface FreshnessProbes {
  /**
   * Latest mtime (epoch ms) among the probe set, or 0 if none exist. If
   * `sinceMs` is given, the implementation may early-exit on the first mtime
   * strictly greater than `sinceMs`.
   */
  newestSourceMtimeMs(paths: HayvenPaths, sinceMs?: number): number;
  /** True iff a daemon (with its watcher) is running for this project. */
  daemonRunning(paths: HayvenPaths): boolean;
  /**
   * SOURCE-content-aware freshness check, used ONLY to SUPPRESS a would-be-stale
   * warning (never to add one). Returns `true` iff we can PROVE that the SOURCE
   * files the index is built from are byte-identical to what was ingested — i.e.
   * the current `git rev-parse HEAD` equals `ingestedHead` AND `git diff
   * --name-only HEAD` contains NO tracked SOURCE file (a file whose extension is
   * in {@link SOURCE_EXTENSIONS}).
   *
   * Crucially this is SOURCE-SCOPED, not whole-tree-clean. The index is built
   * ONLY from source files (the parse languages: `.ts .tsx .js .jsx .mjs .cjs
   * .py .rs .go .astro`), so staleness must depend ONLY on whether a SOURCE
   * file's content changed since ingest. The normal `hayven init` → `ingest`
   * flow itself leaves the tree permanently "dirty" by `git status` standards:
   * it creates an UNTRACKED `AGENTS.md` and MODIFIES the tracked `.gitignore`
   * (adding `.hayven/`). A whole-tree `git status --porcelain` check would
   * therefore NEVER be empty after a real init, so source-scoping is what makes
   * suppression actually fire. Untracked files (AGENTS.md, caches, `.hayven/`)
   * and non-source tracked files (`.gitignore`, `*.md`) MUST be ignored.
   *
   * This is the fresh-clone / fresh-checkout case: `cp -r`/`rsync`/`git clone`
   * reset file mtimes to clone-time (newer than `last_ingest_at`) even though no
   * source byte changed, which would otherwise FALSE-fire the mtime probe.
   *
   * Returns `false` on ANY uncertainty — HEAD differs, a tracked source file
   * differs from HEAD, not a git repo, git missing/errors/times out — so the
   * caller falls through to the EXISTING mtime behavior unchanged. MUST be
   * bounded (short git timeout) and MUST NEVER throw.
   */
  gitSourceContentUnchanged(repoRoot: string, ingestedHead: string): boolean;
}

/**
 * Cap on the number of tracked source files we stat in the fresh-path scan.
 *
 * BOUNDEDNESS / SCALE (40k-node repos — DELIVERABLE 2): this cap is what keeps
 * the freshness probe O(cap), independent of repo size. The two cases on a 40k
 * repo:
 *   - STALE 40k repo: the early-exit fires on the FIRST tracked source file whose
 *     mtime exceeds `last_ingest_at`, so detection is effectively instant and the
 *     cap is never reached — staleness is detected regardless of repo size.
 *   - FRESH 40k repo with MORE than `MAX_FILES_SCANNED` tracked files: the scan
 *     stats the first `MAX_FILES_SCANNED` (git-order) without finding a newer
 *     file, hits the cap, and returns the cheap-probe result → "fresh". This is a
 *     DELIBERATE bound: we report "fresh" for the prefix we verified rather than
 *     over-scan the whole tree on every daemonless read. The only correctness
 *     cost is a POSSIBLE MISSED warning (never a false-stale) if the single
 *     changed file happens to sit beyond the scanned prefix AND none of the cheap
 *     O(1) probes (dir/`.git` mtimes) caught it — an unlikely corner, and a
 *     missed note is strictly less harmful than a false one (a false-stale is the
 *     cardinal sin: it makes agents distrust `refs`/`query` and fall back to grep).
 *
 * OPERATOR OVERRIDE: set `HAYVEN_FRESHNESS_MAX_FILES=<N>` to raise (or lower) the
 * cap when the silent-cap trade-off above is unacceptable on a very large repo —
 * e.g. raise it to cover all tracked source files so a fresh-but-edited deep file
 * past position 4096 is still caught. Invalid/≤0/non-numeric values fall back to
 * the default. Raising it only costs extra `stat()` calls on a genuinely-fresh
 * read (the stale path still early-exits); it never changes correctness, only how
 * much of a fresh tree we bother to verify before trusting it.
 */
const DEFAULT_MAX_FILES_SCANNED = 4096;

/**
 * Resolve the file-scan cap from `HAYVEN_FRESHNESS_MAX_FILES`, else the default.
 * Read at use-time (not module-load) so tests/operators can set it per-process.
 * Conservative: any non-positive / non-finite value yields the default.
 */
function maxFilesScanned(): number {
  const raw = process.env["HAYVEN_FRESHNESS_MAX_FILES"];
  if (raw === undefined) return DEFAULT_MAX_FILES_SCANNED;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_FILES_SCANNED;
}

/**
 * Directories never worth statting for SOURCE freshness — either our own
 * machinery (`.hayven`/`.git`, whose churn is our writes, not source edits) or
 * generated/vendored trees. Used by the non-git recursive-walk fallback.
 */
const SKIP_DIRS = new Set([
  ".hayven",
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
]);

/**
 * The file extensions (lowercase, leading dot) the index is built from — the
 * parse languages in `native/src/parse/language.rs::from_extension` /
 * `DEFAULT_CONFIG.parse_languages`. Staleness depends ONLY on whether one of
 * THESE changed: a modified `.gitignore`/`*.md`, an untracked `AGENTS.md`, or
 * anything under `.hayven/` is NOT a source change and must never block
 * suppression. Keep this in lockstep with the parser's extension map.
 */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".astro",
]);

/** True iff `path` (a repo-relative path from `git diff`) is a source file. */
function isSourcePath(path: string): boolean {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  // A leading-dot dotfile with no later dot (".gitignore") has no extension.
  if (dot <= slash) return false;
  return SOURCE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Default probes: cheap O(1) dir/git stats, an early-exit tracked-file scan,
 *  and the real pidfile liveness check. */
export const defaultProbes: FreshnessProbes = {
  newestSourceMtimeMs(paths: HayvenPaths, sinceMs?: number): number {
    // `threshold` drives the early-exit: as soon as we see a file/dir whose
    // mtime exceeds it, the index is already known-stale and we can stop. When
    // no threshold is given (e.g. a caller wanting the raw newest) we scan to
    // completion within the cap. -Infinity means "never early-exit".
    const threshold = sinceMs ?? Number.POSITIVE_INFINITY;
    let newest = 0;
    let earlyExit = false;
    const probe = (p: string): void => {
      try {
        if (!existsSync(p)) return;
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
        if (m > threshold) earlyExit = true;
      } catch {
        /* unreadable probe — ignore, never throw on the read path */
      }
    };

    // (1) Cheap O(1) probes first — these catch add/remove/rename (dir mtimes)
    // and stage/commit (`.git/{index,HEAD}`), and are the cheapest hits.
    probe(paths.repoRoot);
    try {
      for (const ent of readdirSync(paths.repoRoot, { withFileTypes: true })) {
        // Skip our own machinery AND generated/vendored trees: a fresh
        // `node_modules`/`dist` dir mtime (e.g. after `bun install` or a build)
        // is NOT a source edit and must never false-warn. SKIP_DIRS covers both.
        if (SKIP_DIRS.has(ent.name)) continue;
        probe(join(paths.repoRoot, ent.name));
        if (earlyExit) return newest;
      }
    } catch {
      /* unreadable root — fall back to the probes above */
    }
    const gitDir = join(paths.repoRoot, ".git");
    probe(join(gitDir, "index"));
    probe(join(gitDir, "HEAD"));
    if (earlyExit) return newest;

    // (2) Tracked-source-file scan with early-exit. This is what catches the
    // IN-PLACE edit of an existing deep file — the case the bounded probes
    // above are structurally blind to. Stat-only, bounded by MAX_FILES_SCANNED,
    // and short-circuited the instant one file beats the threshold. We only get
    // here when the cheap probes did NOT already prove staleness, so the common
    // "something obvious changed" case never pays for this at all.
    const files = listSourceFiles(paths.repoRoot);
    if (files === null) {
      // Could not enumerate (no git, unreadable tree, or cap blew during the
      // walk) — return the cheap probe result rather than over-scan or lie.
      return newest;
    }
    const n = Math.min(files.length, maxFilesScanned());
    for (let i = 0; i < n; i++) {
      probe(files[i]!);
      if (earlyExit) return newest;
    }
    // If we hit the cap without enumerating everything AND found nothing newer,
    // we have NOT verified freshness across the whole tree — but we also have
    // no evidence of staleness, and false-warning is the cardinal sin here, so
    // we report the newest we did see (≤ threshold) → "fresh". Documented bound.
    return newest;
  },
  daemonRunning(paths: HayvenPaths): boolean {
    return daemonStatus(paths.pidFile).state === "running";
  },
  gitSourceContentUnchanged(repoRoot: string, ingestedHead: string): boolean {
    return gitSourceContentUnchangedImpl(repoRoot, ingestedHead);
  },
};

/**
 * Default {@link FreshnessProbes.gitSourceContentUnchanged} implementation.
 *
 * Proves SOURCE-content-equality with the ingested snapshot via two bounded,
 * read-only git calls in `repoRoot`:
 *   1. `git rev-parse HEAD` — must equal the `ingestedHead` recorded at ingest.
 *   2. `git diff --name-only HEAD --` — the set of tracked files whose CONTENT
 *      differs from HEAD (staged + unstaged combined; untracked files are NOT
 *      listed). Suppression requires that NONE of those files is a SOURCE file
 *      ({@link isSourcePath}).
 *
 * Why `git diff --name-only HEAD` and NOT `git status --porcelain`: the index is
 * built ONLY from source files, but the normal `hayven init` footprint leaves
 * the tree permanently dirty by whole-tree standards — it creates an untracked
 * `AGENTS.md` and modifies the tracked `.gitignore` (to add `.hayven/`). A
 * porcelain check would therefore NEVER be empty after a real init, so the old
 * clean-tree gate never fired in the workflow it was meant to fix.
 * `git diff --name-only HEAD` ignores untracked files entirely (AGENTS.md,
 * caches, `.hayven/`), and we additionally filter the listed tracked files to
 * source extensions — so a modified `.gitignore` / `*.md` is correctly ignored.
 *
 * Conservative by construction: returns `false` on ANY doubt — empty/blank
 * `ingestedHead`, no `.git`, git missing, non-zero exit, timeout, or any thrown
 * error — so the caller keeps the EXISTING mtime behavior. Bounded by a 2s
 * timeout on each call (matching the `git ls-files` guard). NEVER throws.
 */
function gitSourceContentUnchangedImpl(repoRoot: string, ingestedHead: string): boolean {
  const head = ingestedHead.trim();
  if (head.length === 0) return false; // nothing trustworthy to compare against
  if (!existsSync(join(repoRoot, ".git"))) return false; // not a git repo
  try {
    const rev = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (rev.status !== 0 || typeof rev.stdout !== "string") return false;
    if (rev.stdout.trim() !== head) return false; // HEAD moved → real change

    // `-z` gives NUL-delimited paths so filenames with spaces/newlines are safe;
    // `--` ends options so a path that looks like a flag can't confuse git. This
    // lists tracked files (staged + unstaged) whose content differs from HEAD;
    // untracked files (AGENTS.md, caches, `.hayven/`) are NOT included.
    const diff = spawnSync("git", ["-C", repoRoot, "diff", "--name-only", "-z", "HEAD", "--"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (diff.status !== 0 || typeof diff.stdout !== "string") return false;
    const changed = diff.stdout.split("\0").filter((p) => p.length > 0);
    // If ANY changed tracked file is a source file, the index's content really
    // did change → cannot suppress (fall through to the stale warning).
    if (changed.some(isSourcePath)) return false;

    // HEAD matches AND no tracked SOURCE file differs from HEAD → the source the
    // index was built from is byte-identical; the mtimes are merely newer (fresh
    // clone) and the init footprint (.gitignore mod, untracked AGENTS.md) is
    // correctly ignored. Safe to suppress.
    return true;
  } catch {
    // git missing / spawn error / etc. — behave exactly as today (no suppress).
    return false;
  }
}

/**
 * Enumerate the project's tracked SOURCE files as absolute paths.
 *
 * Prefers `git ls-files` when `repoRoot` is a git repo — it returns exactly the
 * tracked files (no node_modules/dist churn, no untracked build output) cheaply
 * in one subprocess. Falls back to a bounded recursive walk that skips
 * `SKIP_DIRS` when this is not a git repo (or git is unavailable / errors).
 *
 * Returns `null` when enumeration is not possible or exceeds the scan cap, so
 * the caller falls back to the cheap probes rather than over-scanning. Never
 * throws.
 */
function listSourceFiles(repoRoot: string): string[] | null {
  const cap = maxFilesScanned();
  // git ls-files: cheap, exactly-tracked, naturally excludes vendored/built
  // trees. `-z` for NUL-delimited paths so filenames with spaces/newlines are
  // safe. Bounded output and a short timeout keep this from ever hanging.
  if (existsSync(join(repoRoot, ".git"))) {
    try {
      const res = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], {
        encoding: "buffer",
        timeout: 2000,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (res.status === 0 && res.stdout) {
        const rel = res.stdout
          .toString("utf8")
          .split("\0")
          .filter((p) => p.length > 0);
        // Early cap: if a repo has more tracked files than we'll scan, don't
        // build a huge array — the walk fallback isn't better here, so just
        // take the first `cap`. Order is git's (roughly stable), which is fine:
        // any newer file in the prefix triggers the early-exit.
        const sliced = rel.length > cap ? rel.slice(0, cap) : rel;
        return sliced.map((p) => join(repoRoot, p));
      }
    } catch {
      /* git missing / errored — fall through to the walk */
    }
  }

  // Non-git fallback: bounded recursive walk, skipping SKIP_DIRS. Stat-only of
  // files; returns null if we exceed the cap (signals "could not bound-verify"
  // to the caller, which then trusts the cheap probes instead of false-warning).
  const out: string[] = [];
  const stack: string[] = [repoRoot];
  try {
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable dir — skip, don't abort the whole walk
      }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) continue;
          stack.push(join(dir, ent.name));
        } else if (ent.isFile()) {
          out.push(join(dir, ent.name));
          if (out.length > cap) return null; // too big to bound — bail
        }
      }
    }
  } catch {
    return null;
  }
  return out;
}

export interface StalenessResult {
  /** True iff a warning SHOULD be surfaced (stale AND no daemon running). */
  stale: boolean;
  /** The single concise stderr line to print, or "" when nothing to say. */
  message: string;
}

/**
 * Decide whether to warn about a stale index — pure given its probes.
 *
 * Returns `stale: false` (and an empty message) when:
 *   - a daemon/watcher is already running for this project (it owns freshness);
 *   - the index has no `last_ingest_at` (nothing to compare — never invent a
 *     warning, e.g. a freshly-created index mid-ingest);
 *   - the newest probed mtime is at or before the last ingest (genuinely fresh).
 *
 * The message NEVER touches stdout; callers write it to stderr only.
 */
export function evaluateStaleness(
  db: Db,
  paths: HayvenPaths,
  probes: FreshnessProbes = defaultProbes,
): StalenessResult {
  // Guard FIRST and cheapest: if the watcher owns this project, say nothing.
  // This also means we never even stat the tree when a daemon is up.
  if (probes.daemonRunning(paths)) return { stale: false, message: "" };

  const raw = db.getStat("last_ingest_at");
  if (raw === null) return { stale: false, message: "" };
  const lastIngestMs = Number(raw);
  if (!Number.isFinite(lastIngestMs) || lastIngestMs <= 0) {
    return { stale: false, message: "" };
  }

  // Pass `lastIngestMs` as the early-exit threshold so the default probe can
  // short-circuit on the first source file newer than the last ingest (the
  // stale path is then instant). The comparison below is unchanged whether the
  // probe early-exited or scanned to completion.
  const newest = probes.newestSourceMtimeMs(paths, lastIngestMs);
  if (newest <= lastIngestMs) return { stale: false, message: "" };

  // SOURCE-content-aware suppression of the mtime false-positive: a freshly
  // CLONED / checked-out repo (`cp -r`/`rsync`/`git clone`) resets file mtimes
  // to clone-time — newer than `last_ingest_at` — even though every SOURCE byte
  // is identical to what was ingested. The mtime probe above WOULD flag that as
  // stale. Before we do, ask git whether the SOURCE content actually changed: if
  // the ingest recorded a HEAD commit (`last_ingest_git_head`) AND the current
  // HEAD still equals it AND no tracked SOURCE file differs from HEAD, the index
  // input is provably unchanged → treat as FRESH and suppress the note.
  //
  // This is SOURCE-scoped on purpose: the normal `hayven init` flow itself
  // leaves the tree permanently dirty (untracked AGENTS.md + a `.gitignore`
  // edit adding `.hayven/`), so a whole-tree clean check would never fire after
  // a real init. We only care about the parse-language files the index is built
  // from — non-source churn (.gitignore, *.md, caches, `.hayven/`) is ignored.
  //
  // On ANY git uncertainty (stat missing, HEAD moved, a source file differs,
  // not-a-repo, git unavailable/timeout) `gitSourceContentUnchanged` returns
  // false and we fall through to the existing stale result UNCHANGED. This path
  // only ever SUPPRESSES — it never warns.
  const ingestedHead = db.getStat("last_ingest_git_head");
  if (ingestedHead !== null && probes.gitSourceContentUnchanged(paths.repoRoot, ingestedHead)) {
    return { stale: false, message: "" };
  }

  return {
    stale: true,
    message:
      "note: index may be stale (source files changed since last ingest) — " +
      "run `hayven ingest` or start the daemon (`hayven daemon start`)",
  };
}

/**
 * Convenience for CLI callers: evaluate and, if stale, write the single note to
 * stderr. Returns whether a note was written. NEVER writes to stdout. Swallows
 * any error so a freshness check can never fail a query.
 */
export function warnIfStale(
  db: Db,
  paths: HayvenPaths,
  probes: FreshnessProbes = defaultProbes,
): boolean {
  try {
    const { stale, message } = evaluateStaleness(db, paths, probes);
    if (stale) {
      process.stderr.write(message + "\n");
      return true;
    }
  } catch {
    /* freshness is best-effort — never break the query over it */
  }
  return false;
}

/**
 * Result of an opt-in `--refresh` attempt (see {@link refreshIfRequested}).
 *   - `"ingested"` — the index looked stale + no daemon owned it, so a FULL
 *     reindex (whole-repo re-parse) ran before the read.
 *   - `"fresh"`    — the staleness probe said the index is already current.
 *   - `"daemon"`   — a daemon/watcher owns the project; we deferred to it and
 *     did NOT reindex (never race the watcher's writes).
 *   - `"no-ingest-info"` — no `last_ingest_at`, so we can't judge staleness;
 *     we do NOT reindex (mirrors `warnIfStale`'s "never invent" stance).
 *   - `"failed"`   — the reindex was attempted but returned non-zero; the read
 *     proceeds against whatever index exists (best-effort, never a hard fail).
 *     NOTE: the CLI ingest's clear-then-reinsert is NOT transactional, so a
 *     killed/failed reindex can leave the index EMPTY/partial — the caller emits
 *     a loud stderr warning in this case (see {@link refreshIfRequested}).
 */
export type RefreshOutcome =
  | "ingested"
  | "fresh"
  | "daemon"
  | "no-ingest-info"
  | "failed";

/**
 * Injectable seams for {@link refreshIfRequested}, all defaulted for production
 * and overridden in tests so the decision logic is verifiable without a native
 * binary or a real ingest:
 *   - `probes`  — the freshness probe set (same as `evaluateStaleness`).
 *   - `ingest`  — the reindex runner (defaults to the real CLI `runIngest`, the
 *                 SAME path `hayven ingest` uses; with no path positional this
 *                 is a FULL whole-repo rebuild — drop+re-parse); tests pass a
 *                 spy.
 *   - `openProbeDb` — opens a READ-ONLY Db to read `last_ingest_at`; tests pass
 *                 an in-memory/temp Db factory.
 */
export interface RefreshDeps {
  probes?: FreshnessProbes;
  ingest?: (args: ParsedArgs) => Promise<number>;
  openProbeDb?: (paths: HayvenPaths) => Db;
}

/**
 * Perform a FULL reindex before a read, but ONLY when it's both needed and safe.
 * Wired behind the `--refresh` opt-in on `hayven query` / `hayven neighbors`;
 * the caller invokes it (before opening its read handle) solely when the flag is
 * present.
 *
 * The CLI has NO incremental mode — only the daemon's file watcher does. So
 * `--refresh` runs a FULL whole-repo rebuild: `runIngest` with no path positional
 * does `DELETE FROM edges; DELETE FROM nodes;` then a complete re-parse. On a
 * large repo this is NOT cheap; the stderr note below says so up front.
 *
 * Decision (in order — the cheap/safe guards first, mirroring `evaluateStaleness`):
 *   1. If a daemon/watcher owns this project (pidfile alive — the SAME guard
 *      `warnIfStale` uses), SKIP the refresh: the watcher already keeps the
 *      index fresh and we must never race its writes. Noted on stderr.
 *   2. Otherwise probe staleness exactly as `warnIfStale` does (reuse
 *      `evaluateStaleness`, which itself re-checks the daemon guard). If the
 *      index is NOT stale, do nothing (a true no-op — no reindex, no writes).
 *   3. If stale, run a FULL reindex (the `runIngest` entry point as `hayven
 *      ingest` WITHOUT a path positional → drop nodes+edges, whole-repo
 *      re-parse). The read then proceeds against the now-fresh index.
 *
 * Best-effort: any thrown error or non-zero reindex is swallowed/noted and the
 * read continues — a refresh must never harden into a way to FAIL a query. BUT
 * the CLI ingest's clear-then-reinsert is NOT transactional, so a killed/failed
 * reindex can leave the index EMPTY/partial; on failure we emit a LOUD stderr
 * warning that the read is proceeding against a possibly-empty index (we do NOT
 * restructure ingest's transactions here — that's out of scope). We open our OWN
 * short-lived read-only Db to probe and close it before reindexing, so the
 * ingest's writer connection never contends with it.
 *
 * Returns a {@link RefreshOutcome} (also useful for tests/observability).
 */
export async function refreshIfRequested(
  args: ParsedArgs,
  ctx: ProjectContext,
  deps: RefreshDeps = {},
): Promise<RefreshOutcome> {
  const probes = deps.probes ?? defaultProbes;
  const ingest = deps.ingest ?? runIngest;
  const openProbeDb =
    deps.openProbeDb ??
    // Probe the SAME index the read path uses (the current branch's, with the
    // legacy fallback) so staleness is judged against what will actually be read.
    ((paths) => new Db(resolveReadIndex(paths, ctx.config).path, { readonly: true }));

  // Tracks whether we've entered the destructive reindex phase. If `ingest`
  // THROWS, the index's nodes+edges may already be cleared (the rebuild's
  // clear-then-reinsert isn't transactional) — the catch then needs the same
  // LOUD warning as the non-zero-exit path. A throw BEFORE this is set (e.g. a
  // probe-Db failure) leaves the index untouched, so the mild note suffices.
  let reindexStarted = false;

  try {
    // (1) Daemon owns the project → defer, never race its writes.
    if (probes.daemonRunning(ctx.paths)) {
      process.stderr.write(
        "note: a daemon/watcher already owns this project — skipping --refresh " +
          "(the watcher keeps the index fresh)\n",
      );
      return "daemon";
    }

    // (2) Probe staleness with a short-lived read-only handle.
    let stale: boolean;
    let hadIngestInfo: boolean;
    const probeDb = openProbeDb(ctx.paths);
    try {
      hadIngestInfo = probeDb.getStat("last_ingest_at") !== null;
      stale = evaluateStaleness(probeDb, ctx.paths, probes).stale;
    } finally {
      probeDb.close();
    }

    if (!hadIngestInfo) return "no-ingest-info";
    if (!stale) return "fresh"; // true no-op — no reindex, no writes.

    // (3) Stale + nobody owns it → FULL reindex, then read. The CLI has no
    // incremental mode (only the daemon watcher does), so this is a whole-repo
    // drop+re-parse; say so up front so a large-repo cost isn't a surprise.
    process.stderr.write(
      "note: index is stale — running a full reindex (`hayven ingest`) before " +
        "the read (--refresh)…\n",
    );
    // Reuse the EXACT `hayven ingest` entry point with NO path positional → a
    // FULL whole-repo rebuild (drop nodes+edges, re-parse everything). Thread
    // `--cwd` so it targets THIS project (runIngest resolves from cwd).
    const ingestArgs: ParsedArgs = {
      positionals: [],
      flags: { cwd: ctx.paths.repoRoot },
    };
    // `runIngest` writes its completion summary to STDOUT. The read commands we
    // front (`query`/`neighbors`) keep stdout byte-identical so `--json` stays
    // pipeable — so we MUST NOT let the ingest summary leak onto their stdout.
    // Redirect the ingest's stdout to STDERR for the duration of the call (it's
    // a progress note, semantically a stderr concern here), then restore.
    reindexStarted = true;
    const code = await withStdoutRedirectedToStderr(() => ingest(ingestArgs));
    if (code !== 0) {
      // A FULL reindex drops nodes+edges BEFORE re-inserting, and that clear is
      // NOT transactional with the re-insert (out of scope to fix here). So a
      // non-zero/killed reindex can leave the index EMPTY or partial, and the
      // read is about to run against it — silently returning zero/too-few hits.
      // Make that LOUD rather than letting a downstream "No matches" mislead.
      process.stderr.write(
        "WARNING: --refresh reindex FAILED — the index may now be EMPTY or " +
          "partial (the rebuild clears nodes+edges before re-inserting and that " +
          "is not transactional). The read is proceeding against it and may " +
          "return zero or too few hits. Re-run `hayven ingest` to rebuild.\n",
      );
      return "failed";
    }
    return "ingested";
  } catch (err) {
    // Never let a refresh failure break the read.
    if (reindexStarted) {
      // The throw happened during/after the destructive reindex — the index may
      // already be EMPTY/partial and the read is about to run against it. Same
      // loud warning as the non-zero-exit path.
      process.stderr.write(
        `WARNING: --refresh reindex FAILED (${(err as Error).message}) — the ` +
          "index may now be EMPTY or partial (the rebuild clears nodes+edges " +
          "before re-inserting and that is not transactional). The read is " +
          "proceeding against it and may return zero or too few hits. Re-run " +
          "`hayven ingest` to rebuild.\n",
      );
    } else {
      // Failed before touching the index (e.g. a probe error) — it's intact.
      process.stderr.write(
        `note: --refresh skipped (${(err as Error).message})\n`,
      );
    }
    return "failed";
  }
}

/**
 * Run `fn` with `process.stdout.write` temporarily routed to `process.stderr`,
 * then restore it. Used so a refresh-triggered `runIngest`'s stdout summary
 * lands on stderr (a progress note) and never contaminates the read command's
 * stdout — keeping `query --json` / `neighbors --json` byte-identical and
 * pipeable. Restoration is in a `finally` so it survives a throw/rejection.
 */
async function withStdoutRedirectedToStderr<T>(fn: () => Promise<T>): Promise<T> {
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    (process.stderr.write as (...a: unknown[]) => boolean)(
      chunk,
      ...rest,
    )) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = realWrite;
  }
}
