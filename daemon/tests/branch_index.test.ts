// Branch-aware (per-branch) index resolution — Phase 0.0.4.5 §5 item 3.
// Unit-tests the pure path logic (branchKey/sanitize/resolveRead/resolveWrite/
// LRU) with hand-written `.git/HEAD` files, plus `gitDiffSince` against a real
// temporary git repo (git is available in CI — see ingest.test.ts).
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activeBranchKey,
  branchKey,
  branchSqlitePath,
  evictBranchesLru,
  gitDiffSince,
  listBranchIndexes,
  resolveReadIndex,
  resolveWriteIndex,
  sanitizeBranchKey,
} from "../src/db/branch_index.ts";
import { DEFAULT_CONFIG, type HayvenConfig } from "../src/config/defaults.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "hayven-branch-"));
}

/** Write `.git/HEAD` (creating `.git/`) so `branchKey` resolves a branch. */
function setHead(repo: string, head: string): void {
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), head);
}

/** Create an (empty-ish) branch index file under `.hayven/branches/<key>/`. */
function makeBranchIndex(repo: string, key: string, mtime?: number): string {
  const p = branchSqlitePath(hayvenPathsFor(repo), key);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "x");
  if (mtime !== undefined) utimesSync(p, mtime / 1000, mtime / 1000);
  return p;
}

const cfg = (over?: Partial<HayvenConfig["index"]>): HayvenConfig => ({
  ...DEFAULT_CONFIG,
  index: { ...DEFAULT_CONFIG.index, ...over },
});

describe("branchKey", () => {
  test("reads a normal ref HEAD and sanitizes slashes", () => {
    const r = tmp();
    setHead(r, "ref: refs/heads/feature/cool-thing\n");
    expect(branchKey(r)).toBe("feature-cool-thing");
  });

  test("detached HEAD → detached-<short sha>", () => {
    const r = tmp();
    setHead(r, "3f786850e387550fdab836ed7e6dc881de23001b\n");
    expect(branchKey(r)).toBe("detached-3f786850e387");
  });

  test("non-git directory → null", () => {
    expect(branchKey(tmp())).toBeNull();
  });

  test("worktree `.git` FILE is followed to the linked HEAD", () => {
    const r = tmp();
    const realGitDir = join(r, "realgit");
    mkdirSync(realGitDir, { recursive: true });
    writeFileSync(join(realGitDir, "HEAD"), "ref: refs/heads/wt-branch\n");
    // `.git` is a FILE pointing at the worktree's real gitdir (absolute path).
    writeFileSync(join(r, ".git"), `gitdir: ${realGitDir}\n`);
    expect(branchKey(r)).toBe("wt-branch");
  });

  test("sanitizeBranchKey maps unsafe chars and guards empties", () => {
    expect(sanitizeBranchKey("a/b")).toBe("a-b");
    expect(sanitizeBranchKey("release/1.2.x")).toBe("release-1.2.x");
    expect(sanitizeBranchKey("")).toBe("branch");
    expect(sanitizeBranchKey("..")).toBe("branch");
  });
});

describe("activeBranchKey / resolveReadIndex", () => {
  test("non-git → legacy index, no branch key", () => {
    const r = tmp();
    const paths = hayvenPathsFor(r);
    expect(activeBranchKey(paths, cfg())).toBeNull();
    const res = resolveReadIndex(paths, cfg());
    expect(res.path).toBe(paths.sqliteFile);
    expect(res.branchKey).toBeNull();
  });

  test("perBranch:false → legacy even in a git repo", () => {
    const r = tmp();
    setHead(r, "ref: refs/heads/main\n");
    const paths = hayvenPathsFor(r);
    expect(activeBranchKey(paths, cfg({ perBranch: false }))).toBeNull();
    expect(resolveReadIndex(paths, cfg({ perBranch: false })).path).toBe(paths.sqliteFile);
  });

  test("git repo, no branch index yet → falls back to legacy (flagged)", () => {
    const r = tmp();
    setHead(r, "ref: refs/heads/main\n");
    const paths = hayvenPathsFor(r);
    const res = resolveReadIndex(paths, cfg());
    expect(res.path).toBe(paths.sqliteFile);
    expect(res.branchKey).toBe("main");
    expect(res.usedFallback).toBe(true);
  });

  test("git repo with a branch index → uses it", () => {
    const r = tmp();
    setHead(r, "ref: refs/heads/main\n");
    const paths = hayvenPathsFor(r);
    const bp = makeBranchIndex(r, "main");
    const res = resolveReadIndex(paths, cfg());
    expect(res.path).toBe(bp);
    expect(res.usedFallback).toBe(false);
  });
});

describe("resolveWriteIndex (seed + LRU)", () => {
  test("non-git → legacy, no seeding", () => {
    const r = tmp();
    const paths = hayvenPathsFor(r);
    const res = resolveWriteIndex(paths, cfg(), { seed: true });
    expect(res.path).toBe(paths.sqliteFile);
    expect(res.seededFrom).toBeNull();
  });

  test("new branch seeds from the freshest sibling branch index", () => {
    const r = tmp();
    setHead(r, "ref: refs/heads/feature\n");
    const paths = hayvenPathsFor(r);
    // Two siblings; `newer` is the freshest.
    makeBranchIndex(r, "older", 1_000_000);
    const newer = makeBranchIndex(r, "main", 2_000_000);
    const res = resolveWriteIndex(paths, cfg(), { seed: true });
    expect(res.branchKey).toBe("feature");
    expect(res.path).toBe(branchSqlitePath(paths, "feature"));
    expect(res.seededFrom).toBe(newer);
    expect(existsSync(res.path)).toBe(true); // copied
  });

  test("new branch with no sibling seeds from the legacy index", () => {
    const r = tmp();
    setHead(r, "ref: refs/heads/main\n");
    const paths = hayvenPathsFor(r);
    mkdirSync(paths.hayvenDir, { recursive: true });
    writeFileSync(paths.sqliteFile, "legacy");
    const res = resolveWriteIndex(paths, cfg(), { seed: true });
    expect(res.seededFrom).toBe(paths.sqliteFile);
    expect(existsSync(branchSqlitePath(paths, "main"))).toBe(true);
  });

  test("an existing branch index is NOT re-seeded", () => {
    const r = tmp();
    setHead(r, "ref: refs/heads/main\n");
    const paths = hayvenPathsFor(r);
    makeBranchIndex(r, "main");
    makeBranchIndex(r, "other", 9_000_000); // a fresher sibling exists
    const res = resolveWriteIndex(paths, cfg(), { seed: true });
    expect(res.seededFrom).toBeNull(); // already present → no copy
  });

  test("LRU evicts oldest branch indexes beyond maxBranches, keeping current", () => {
    const r = tmp();
    const paths = hayvenPathsFor(r);
    makeBranchIndex(r, "b1", 1_000_000);
    makeBranchIndex(r, "b2", 2_000_000);
    makeBranchIndex(r, "b3", 3_000_000);
    makeBranchIndex(r, "keep", 500_000); // oldest, but must be protected
    evictBranchesLru(paths, cfg({ maxBranches: 2 }), "keep");
    const remaining = listBranchIndexes(paths).map((b) => b.key).sort();
    expect(remaining).toContain("keep"); // protected current branch
    expect(remaining).toContain("b3"); // newest sibling
    expect(remaining.length).toBe(2);
    expect(remaining).not.toContain("b1");
  });
});

describe("gitDiffSince (real git repo)", () => {
  function git(repo: string, args: string[]): void {
    const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
    }
  }
  function rev(repo: string): string {
    return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" })
      .stdout.toString()
      .trim();
  }

  test("returns the changed + deleted files between a ref and the working tree", () => {
    const r = tmp();
    git(r, ["init", "-q"]);
    git(r, ["config", "user.email", "t@t.t"]);
    git(r, ["config", "user.name", "t"]);
    writeFileSync(join(r, "keep.ts"), "export const a = 1;\n");
    writeFileSync(join(r, "gone.ts"), "export const b = 2;\n");
    writeFileSync(join(r, "stable.ts"), "export const s = 0;\n");
    git(r, ["add", "-A"]);
    git(r, ["commit", "-q", "-m", "base"]);
    const base = rev(r);

    // Mutate: modify keep.ts, delete gone.ts, add new.ts (committed) + leave a
    // TRACKED uncommitted edit on stable.ts to prove working-tree edits count.
    writeFileSync(join(r, "keep.ts"), "export const a = 99;\n");
    rmSync(join(r, "gone.ts"));
    writeFileSync(join(r, "new.ts"), "export const c = 3;\n");
    git(r, ["add", "-A"]);
    git(r, ["commit", "-q", "-m", "change"]);
    writeFileSync(join(r, "stable.ts"), "export const s = 1;\n"); // tracked, uncommitted

    const diff = gitDiffSince(r, base);
    expect(diff).not.toBeNull();
    expect(diff!.changed.sort()).toEqual(["keep.ts", "new.ts", "stable.ts"]);
    expect(diff!.deleted).toEqual(["gone.ts"]);
  });

  test("returns null on a bad ref / non-repo", () => {
    expect(gitDiffSince(tmp(), "deadbeef")).toBeNull();
  });
});
