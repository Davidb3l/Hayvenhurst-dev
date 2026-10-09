/**
 * Git plumbing for per-worktree overlay indexes (HAYV-13).
 *
 * Two tiers, on purpose:
 *
 *  - {@link detectLinkedWorktree} is FILESYSTEM-ONLY. It runs on EVERY read
 *    command (via `requireProject`), so it must cost nothing for the normal
 *    case: one upward walk for `.git`, and when that is a directory (an
 *    ordinary checkout) it returns immediately without spawning anything. Only
 *    a `.git` FILE with a `commondir` beside its gitdir is a linked worktree.
 *
 *  - Everything else spawns `git` and is used only on the overlay paths
 *    (`worktree add/list/prune` and the lazy refresh), which already pay for an
 *    ingest. Each call is bounded by a timeout and NEVER throws: failure is a
 *    `null`/`false` the caller turns into a clear message.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";

import { canonicalRoot, findUp } from "../util/paths.ts";

const GIT_TIMEOUT_MS = 10_000;

/** A linked git worktree, located purely from the filesystem. */
export interface LinkedWorktree {
  /** The worktree's top-level directory (holds the `.git` FILE), canonical. */
  readonly worktreeRoot: string;
  /** This worktree's private git dir (`<common>/worktrees/<name>`). */
  readonly gitDir: string;
  /** The repository's shared git dir (`<main>/.git` in the standard layout). */
  readonly commonDir: string;
  /**
   * The MAIN checkout, or `null` when the common dir is not a `<checkout>/.git`
   * (a bare repo or `--separate-git-dir`). Overlays need a main checkout to
   * hold `.hayven/`, so those layouts are simply not overlay-capable.
   */
  readonly mainRoot: string | null;
}

/**
 * Locate the linked worktree containing `start`, or `null` when `start` is in
 * an ordinary checkout, a submodule, or no repo at all. Never spawns, never
 * throws.
 *
 * A submodule also has a `.git` FILE, but its gitdir carries no `commondir`;
 * requiring that file is what tells the two apart.
 */
export function detectLinkedWorktree(start: string): LinkedWorktree | null {
  try {
    const top = findUp(start, ".git");
    if (top === null) return null;
    const dotGit = join(top, ".git");
    if (!statSync(dotGit).isFile()) return null; // ordinary checkout: the fast path
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m || m[1] === undefined) return null;
    const rawGitDir = m[1].trim();
    const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(top, rawGitDir);
    const commonFile = join(gitDir, "commondir");
    if (!existsSync(commonFile)) return null; // submodule, not a worktree
    const rawCommon = readFileSync(commonFile, "utf8").trim();
    const commonDir = canonicalRoot(isAbsolute(rawCommon) ? rawCommon : resolve(gitDir, rawCommon));
    const mainRoot = basename(commonDir) === ".git" ? dirname(commonDir) : null;
    return { worktreeRoot: canonicalRoot(top), gitDir: canonicalRoot(gitDir), commonDir, mainRoot };
  } catch {
    return null;
  }
}

/** Run `git -C <cwd> <args>`; stdout on exit 0, else null. Never throws. */
export function git(cwd: string, args: string[]): string | null {
  try {
    const res = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0 || typeof res.stdout !== "string") return null;
    return res.stdout;
  } catch {
    return null;
  }
}

/**
 * A git invocation's outcome, kept THREE-way on purpose. "git said no" (it
 * ran and exited non-zero, e.g. `not a git repository`) is evidence about the
 * repository; "git could not run" (missing binary, timeout, a signal) is
 * evidence about nothing. Collapsing both into `null` let `prune` delete an
 * overlay because `git` was briefly unavailable at daemon start.
 */
export type GitProbe =
  | { kind: "ok"; out: string }
  | { kind: "exit"; status: number; stderr: string }
  | { kind: "error"; message: string };

/** Run `git -C <cwd> <args>` and classify the outcome. Never throws. */
export function gitProbe(cwd: string, args: string[]): GitProbe {
  try {
    const res = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error !== undefined) return { kind: "error", message: res.error.message };
    if (res.status === null) return { kind: "error", message: `git killed by ${res.signal ?? "a signal"}` };
    if (res.status !== 0) return { kind: "exit", status: res.status, stderr: String(res.stderr ?? "") };
    return { kind: "ok", out: String(res.stdout ?? "") };
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
}

/** A `rev-parse` path answer, made absolute (git reports some relative to `-C`). */
export function revParsePathProbe(
  cwd: string,
  flag: string,
): { kind: "ok"; path: string } | Exclude<GitProbe, { kind: "ok" }> {
  const r = gitProbe(cwd, ["rev-parse", flag]);
  if (r.kind !== "ok") return r;
  const p = r.out.trim();
  if (p.length === 0) return { kind: "exit", status: 0, stderr: `empty answer to rev-parse ${flag}` };
  return { kind: "ok", path: canonicalRoot(isAbsolute(p) ? p : resolve(cwd, p)) };
}

function revParsePath(cwd: string, flag: string): string | null {
  const r = revParsePathProbe(cwd, flag);
  return r.kind === "ok" ? r.path : null;
}

/** `git rev-parse --git-common-dir`, absolute + canonical. */
export function gitCommonDir(cwd: string): string | null {
  return revParsePath(cwd, "--git-common-dir");
}

/** `git rev-parse --git-dir`, absolute + canonical. */
export function gitDirOf(cwd: string): string | null {
  return revParsePath(cwd, "--git-dir");
}

/** `git rev-parse --show-toplevel`, canonical. */
export function gitToplevel(cwd: string): string | null {
  return revParsePath(cwd, "--show-toplevel");
}

/** `git rev-parse HEAD`, or null (unborn branch, not a repo, git missing). */
export function gitHead(cwd: string): string | null {
  const out = git(cwd, ["rev-parse", "HEAD"]);
  const head = out?.trim() ?? "";
  return /^[0-9a-f]{7,64}$/.test(head) ? head : null;
}

/** True iff `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    const res = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant], {
      timeout: GIT_TIMEOUT_MS,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Repo-relative paths `git status` reports as dirty (modified, staged,
 * deleted, renamed — both sides — and untracked), or null on git failure.
 *
 * `--no-optional-locks`: this runs on every read inside a registered worktree,
 * often while a Sirius worker is running git in the same tree. A plain `git
 * status` opportunistically rewrites the index to refresh stat info and takes
 * `index.lock` to do it, which can make the WORKER's own git command fail.
 * `--untracked-files=all` lists each new file rather than collapsing a new
 * directory to `dir/` — an edit inside a new directory does not change the
 * directory's mtime, so the collapsed form would hide it from the fingerprint.
 */
export function gitStatus(cwd: string): { raw: string; paths: string[] } | null {
  const raw = git(cwd, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (raw === null) return null;
  const tokens = raw.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if (t.length < 4) continue;
    const xy = t.slice(0, 2);
    paths.push(t.slice(3));
    // A rename/copy entry is followed by its ORIGINAL path as its own token.
    if (xy.includes("R") || xy.includes("C")) {
      const orig = tokens[i + 1];
      if (orig !== undefined && orig.length > 0) paths.push(orig);
      i++;
    }
  }
  return { raw, paths: [...new Set(paths)].sort() };
}

/** A worktree's change-detection fingerprint. */
export interface WorktreeFingerprint {
  /** Opaque hash compared against the overlay's stamp. */
  readonly hash: string;
  /** HEAD at fingerprint time (null on an unborn branch). */
  readonly head: string | null;
  /** The dirty paths at fingerprint time (stored with the stamp; see overlay.ts). */
  readonly dirty: string[];
}

/**
 * HEAD + `git status` + the mtimes of every dirty path, hashed.
 *
 * Why the mtimes: `git status` says WHICH files are dirty, not WHAT is in them.
 * A second edit to an already-modified file leaves the status output
 * byte-identical, and without the mtime that edit would never trigger a
 * refresh. Clean tracked files need no mtime: any edit to one makes it dirty,
 * which changes the status output itself.
 *
 * Returns null when git cannot answer (the worktree is gone or broken); the
 * caller treats that as an error, never as "fresh".
 */
export function worktreeFingerprint(worktreeRoot: string): WorktreeFingerprint | null {
  const status = gitStatus(worktreeRoot);
  if (status === null) return null;
  const head = gitHead(worktreeRoot);
  const h = createHash("sha256");
  h.update(`head:${head ?? "none"}\n`);
  h.update(status.raw);
  h.update("\n");
  for (const p of status.paths) {
    let m = "absent";
    try {
      const st = statSync(join(worktreeRoot, p));
      m = `${st.mtimeMs}:${st.size}`;
    } catch {
      // deleted in the working tree — "absent" is itself the signal
    }
    h.update(`${p}\0${m}\n`);
  }
  return { hash: h.digest("hex"), head, dirty: status.paths };
}
