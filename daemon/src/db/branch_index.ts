/**
 * Branch-aware (per-branch) index resolution — Phase 0.0.4.5 §5 item 3, the
 * enterprise differentiator.
 *
 * Enterprise devs live on feature branches / PR worktrees. The closest
 * competitor (cocoindex-code) keeps ONE workspace index and re-syncs — and,
 * being embedding-based, **re-embeds the diff** — on EVERY branch switch, before
 * any query; switching back re-does it (§4c-thread). Hayven is embedding-free +
 * incremental, so we can instead CACHE a per-branch index: a switch to a branch
 * we've already indexed is INSTANT (the index already exists — no re-ingest, and
 * never any re-embed). A first visit to a new branch can SEED from the freshest
 * sibling branch's index (a file copy) and then re-parse only the `git`-changed
 * diff (`git checkout` preserves the mtimes of files that don't differ, so
 * `freshness` flags only the diff).
 *
 * Layout: `.hayven/branches/<branchKey>/index.sqlite`. The legacy
 * `.hayven/index.sqlite` is kept as the read FALLBACK for a branch that has not
 * been ingested yet, so existing single-index projects are unaffected. Resolved
 * on the DAEMONLESS read/ingest path only (`requireProject`/`openProjectDb`/
 * `ingest`); the daemon stays v2 and serves the index it started on.
 *
 * Everything here is plain fs + git-plumbing reads (no subprocess for the
 * branch key — we read `.git/HEAD` directly) so it is cheap and testable.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import type { HayvenConfig } from "../config/defaults.ts";
import type { HayvenPaths } from "../util/paths.ts";

/** Default LRU cap on cached per-branch indexes (config `index.maxBranches`). */
export const DEFAULT_MAX_BRANCHES = 8;

/** The per-branch index filename under `<branchesDir>/<key>/`. */
const BRANCH_INDEX_FILE = "index.sqlite";

/** SQLite sidecar suffixes copied/removed alongside the main file. */
const SQLITE_SIDECARS = ["-wal", "-shm"] as const;

/**
 * Read the current git branch and return a filesystem-safe KEY for it, or
 * `null` when this is not a git repo (or `.git/HEAD` can't be read).
 *
 * - Normal checkout: `.git/HEAD` is `ref: refs/heads/<branch>` → `<branch>`
 *   sanitized (`/` → `-`).
 * - Detached HEAD: `.git/HEAD` is a 40-hex SHA → `detached-<short12>`.
 * - Linked worktree: `.git` is a FILE (`gitdir: <path>`) whose target dir holds
 *   this worktree's own `HEAD`; we follow it. (A worktree also has its own
 *   `.hayven`, so this only matters when a worktree shares a tree layout.)
 *
 * Sanitization maps anything outside `[A-Za-z0-9_.-]` to `-`. Two raw names
 * that collapse to the same key (`a/b` vs `a-b`) would share an index — rare
 * enough in practice to accept; the legacy fallback keeps correctness either
 * way (a wrong-but-fresh index is never served because freshness re-checks).
 */
export function branchKey(repoRoot: string): string | null {
  const headFile = resolveHeadFile(repoRoot);
  if (headFile === null) return null;
  let head: string;
  try {
    head = readFileSync(headFile, "utf8").trim();
  } catch {
    return null;
  }
  if (head.length === 0) return null;

  const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (refMatch && refMatch[1] !== undefined) {
    return sanitizeBranchKey(refMatch[1]);
  }
  // Detached HEAD — a raw commit SHA.
  if (/^[0-9a-f]{7,40}$/i.test(head)) {
    return `detached-${head.slice(0, 12)}`;
  }
  // Unrecognized HEAD form — be conservative and fall back to the legacy index.
  return null;
}

/** Locate the `HEAD` file for `repoRoot`, following a worktree `.git` file. */
function resolveHeadFile(repoRoot: string): string | null {
  const dotGit = join(repoRoot, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return null; // no .git → not a git repo
  }
  if (st.isDirectory()) {
    return join(dotGit, "HEAD");
  }
  if (st.isFile()) {
    // Linked worktree / submodule: `.git` is `gitdir: <path-to-real-gitdir>`.
    try {
      const content = readFileSync(dotGit, "utf8").trim();
      const m = /^gitdir:\s*(.+)$/.exec(content);
      if (m && m[1] !== undefined) {
        const gitDir = m[1].trim();
        const abs = gitDir.startsWith("/") ? gitDir : join(repoRoot, gitDir);
        return join(abs, "HEAD");
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Map a raw branch name to a filesystem-safe directory key. */
export function sanitizeBranchKey(raw: string): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9_.-]/g, "-");
  // Guard against empty / dot-only keys that would resolve to the branches dir
  // itself or a parent.
  return cleaned.length === 0 || cleaned === "." || cleaned === ".."
    ? "branch"
    : cleaned;
}

/** Absolute path of a branch's index file (does not check existence). */
export function branchSqlitePath(paths: HayvenPaths, key: string): string {
  return join(paths.branchesDir, key, BRANCH_INDEX_FILE);
}

/**
 * The active branch key when per-branch caching applies, else `null` (→ use the
 * legacy index). `null` when config disables it OR the project is not a git repo.
 */
export function activeBranchKey(
  paths: HayvenPaths,
  config: HayvenConfig,
): string | null {
  if (config.index?.perBranch === false) return null;
  return branchKey(paths.repoRoot);
}

export interface ResolvedIndex {
  /** Absolute path of the SQLite file to open. */
  readonly path: string;
  /** The active branch key, or `null` when the legacy index is in use. */
  readonly branchKey: string | null;
  /** True when we fell back to the legacy index (branch has no index yet). */
  readonly usedFallback: boolean;
}

/**
 * Resolve which index a READ should open: the current branch's cached index if
 * it exists, otherwise the legacy index (fallback). Pure (no writes).
 */
export function resolveReadIndex(
  paths: HayvenPaths,
  config: HayvenConfig,
): ResolvedIndex {
  const key = activeBranchKey(paths, config);
  if (key === null) {
    return { path: paths.sqliteFile, branchKey: null, usedFallback: false };
  }
  const bp = branchSqlitePath(paths, key);
  if (existsSync(bp)) {
    return { path: bp, branchKey: key, usedFallback: false };
  }
  return { path: paths.sqliteFile, branchKey: key, usedFallback: true };
}

export interface ResolvedWriteIndex extends ResolvedIndex {
  /** The index file we copied to seed a brand-new branch index, or `null`. */
  readonly seededFrom: string | null;
}

/**
 * Resolve which index a WRITE (ingest/reindex) should target, creating the
 * branch directory and — when the branch index does not exist yet and
 * `opts.seed` is set — SEEDING it by copying the freshest sibling branch index
 * (or the legacy index). Seeding lets a subsequent INCREMENTAL ingest re-parse
 * only the `git`-changed diff instead of the whole repo. Also bumps the
 * branch's LRU recency and evicts indexes beyond `index.maxBranches`.
 *
 * When per-branch caching does not apply, returns the legacy index unchanged
 * (no seeding, no eviction) — identical to the pre-feature behavior.
 */
export function resolveWriteIndex(
  paths: HayvenPaths,
  config: HayvenConfig,
  opts: { seed?: boolean } = {},
): ResolvedWriteIndex {
  const key = activeBranchKey(paths, config);
  if (key === null) {
    return {
      path: paths.sqliteFile,
      branchKey: null,
      usedFallback: false,
      seededFrom: null,
    };
  }

  const dir = join(paths.branchesDir, key);
  const bp = join(dir, BRANCH_INDEX_FILE);
  let seededFrom: string | null = null;

  if (!existsSync(bp)) {
    mkdirSync(dir, { recursive: true });
    if (opts.seed) {
      const seed = freshestSeed(paths, key);
      if (seed !== null) {
        copySqlite(seed, bp);
        seededFrom = seed;
      }
    }
  }

  // The just-touched branch is the most-recently-used; evict the oldest beyond
  // the cap (legacy index is never a candidate — it lives outside branchesDir).
  evictBranchesLru(paths, config, key);

  return { path: bp, branchKey: key, usedFallback: false, seededFrom };
}

/** All existing per-branch index entries with their mtime (epoch ms). */
export function listBranchIndexes(
  paths: HayvenPaths,
): Array<{ key: string; path: string; mtimeMs: number }> {
  let entries: string[];
  try {
    entries = readdirSync(paths.branchesDir);
  } catch {
    return []; // branchesDir doesn't exist yet
  }
  const out: Array<{ key: string; path: string; mtimeMs: number }> = [];
  for (const key of entries) {
    const p = join(paths.branchesDir, key, BRANCH_INDEX_FILE);
    try {
      out.push({ key, path: p, mtimeMs: statSync(p).mtimeMs });
    } catch {
      // Not an index dir (or partially-created) — skip.
    }
  }
  return out;
}

/**
 * Pick the freshest (most-recently-ingested) seed for a NEW branch index:
 * the newest sibling branch index, or — when there is none — the legacy index
 * if it exists. Returns the source PATH, or `null` when nothing is seedable.
 */
function freshestSeed(paths: HayvenPaths, exceptKey: string): string | null {
  const siblings = listBranchIndexes(paths)
    .filter((b) => b.key !== exceptKey)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = siblings[0];
  if (newest !== undefined) return newest.path;
  return existsSync(paths.sqliteFile) ? paths.sqliteFile : null;
}

export interface BranchDiff {
  /** Repo-relative files added/modified/renamed-to since `fromRef` (re-parse). */
  readonly changed: string[];
  /** Repo-relative files deleted/renamed-from since `fromRef` (purge nodes). */
  readonly deleted: string[];
}

/**
 * Compute the set of files that differ between the commit a seeded index was
 * built against (`fromRef`, the seed's `last_ingest_git_head`) and the CURRENT
 * working tree, via `git diff --name-status`. This is exactly the branch diff:
 * after a `git checkout`, only files that differ between branches changed, so a
 * seed-from-sibling + re-parse-this-diff ingest does the minimum work (the
 * "cheap switch"). Diffing against the WORKING TREE (no `HEAD` in the args) also
 * folds in TRACKED uncommitted edits; untracked new files are not git-diffed and
 * are caught by the normal freshness/ingest path instead. Returns `null` on any
 * git failure / non-repo so the caller falls back to a full re-parse. NEVER throws.
 */
export function gitDiffSince(repoRoot: string, fromRef: string): BranchDiff | null {
  let out: string;
  try {
    const res = spawnSync(
      "git",
      ["-C", repoRoot, "diff", "--name-status", "-z", "--no-renames", fromRef],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (res.status !== 0 || typeof res.stdout !== "string") return null;
    out = res.stdout;
  } catch {
    return null;
  }
  // `--no-renames` keeps the stream simple: each entry is `<STATUS>\0<path>\0`.
  // A rename then surfaces as a D (old) + A (new), which is exactly the
  // purge-old + parse-new we want anyway.
  const tokens = out.split("\0").filter((t) => t.length > 0);
  const changed: string[] = [];
  const deleted: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i] ?? "";
    const path = tokens[i + 1] ?? "";
    if (path.length === 0) continue;
    if (status.startsWith("D")) deleted.push(path);
    else changed.push(path); // A, M, T, etc.
  }
  return { changed, deleted };
}

/** Copy a SQLite file and any present `-wal`/`-shm` sidecars. */
function copySqlite(from: string, to: string): void {
  copyFileSync(from, to);
  for (const suffix of SQLITE_SIDECARS) {
    const src = from + suffix;
    if (existsSync(src)) {
      try {
        copyFileSync(src, to + suffix);
      } catch {
        // Sidecars are best-effort; a clean source has none anyway.
      }
    }
  }
}

/**
 * LRU-evict per-branch indexes beyond `index.maxBranches`, keeping the most
 * recently modified (the current branch `keepKey` is always retained even if
 * its mtime is momentarily oldest). Best-effort; never throws.
 */
export function evictBranchesLru(
  paths: HayvenPaths,
  config: HayvenConfig,
  keepKey?: string,
): void {
  const max = Math.max(1, config.index?.maxBranches ?? DEFAULT_MAX_BRANCHES);
  const all = listBranchIndexes(paths);
  if (all.length <= max) return;

  // Newest first; protect the current branch by forcing it to the front.
  const ranked = all.sort((a, b) => {
    if (a.key === keepKey) return -1;
    if (b.key === keepKey) return 1;
    return b.mtimeMs - a.mtimeMs;
  });
  for (const victim of ranked.slice(max)) {
    try {
      rmSync(join(paths.branchesDir, victim.key), { recursive: true, force: true });
    } catch {
      // best-effort eviction
    }
  }
}
