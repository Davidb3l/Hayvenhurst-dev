// Branch-aware (per-branch) index resolution — Phase 0.0.4.5 §5 item 3.
// Unit-tests the pure path logic (branchKey/sanitize/resolveRead/resolveWrite/
// LRU) with hand-written `.git/HEAD` files, plus `gitDiffSince` against a real
// temporary git repo (git is available in CI — see ingest.test.ts).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
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
  resolveWriteIndexForKey,
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

  test("(D) keepKey is retained regardless of position — total-order partition, not comparator hack", () => {
    // Stress the ordering: many branches whose mtimes deliberately span the
    // range, with keepKey placed at DIFFERENT extremes across runs. A
    // non-transitive comparator (old ±1-for-keepKey) can drop the protected
    // key depending on the engine's sort pivots; the partition-first impl must
    // NEVER evict it.
    for (const keepMtime of [10, 500_000, 5_000_000, 9_999_999]) {
      const r = tmp();
      const paths = hayvenPathsFor(r);
      makeBranchIndex(r, "a", 1_000_000);
      makeBranchIndex(r, "b", 2_000_000);
      makeBranchIndex(r, "c", 3_000_000);
      makeBranchIndex(r, "d", 4_000_000);
      makeBranchIndex(r, "keep", keepMtime);
      evictBranchesLru(paths, cfg({ maxBranches: 1 }), "keep");
      const remaining = listBranchIndexes(paths).map((b) => b.key);
      // maxBranches=1 and keep is protected → ONLY keep survives (the protected
      // key consumes the single slot; no evictable sibling has room).
      expect(remaining).toEqual(["keep"]);
    }
  });

  test("(D/C) keepAlsoKey protects a SECOND key (the old served branch) from eviction", () => {
    const r = tmp();
    const paths = hayvenPathsFor(r);
    makeBranchIndex(r, "old", 100); // oldest — would be the LRU victim
    makeBranchIndex(r, "s1", 2_000_000);
    makeBranchIndex(r, "s2", 3_000_000);
    makeBranchIndex(r, "new", 9_000_000); // freshest (the re-point target)
    // Cap 2, but BOTH `new` (current) and `old` (still-open served) protected →
    // both survive even though `old` is by far the oldest.
    evictBranchesLru(paths, cfg({ maxBranches: 2 }), "new", "old");
    const remaining = listBranchIndexes(paths).map((b) => b.key).sort();
    expect(remaining).toContain("new");
    expect(remaining).toContain("old"); // protected despite oldest mtime
    // The two protected keys fill the cap; the fresher unprotected siblings go.
    expect(remaining).not.toContain("s1");
    expect(remaining).not.toContain("s2");
  });

  test("(C) resolveWriteIndexForKey protects both the target and keepAlsoKey", () => {
    const r = tmp();
    setHead(r, "ref: refs/heads/target\n");
    const paths = hayvenPathsFor(r);
    // Legacy index so `target` can SEED (→ gets a real index.sqlite file and is
    // enumerable by listBranchIndexes, hence protectable).
    mkdirSync(paths.hayvenDir, { recursive: true });
    writeFileSync(paths.sqliteFile, "legacy");
    // Pre-existing branches; `old` (the still-served branch) is the oldest.
    makeBranchIndex(r, "old", 100);
    makeBranchIndex(r, "filler1", 2_000_000);
    makeBranchIndex(r, "filler2", 3_000_000);
    // Resolve/create+seed `target`, cap at 2, pinning `old` open.
    const res = resolveWriteIndexForKey(paths, cfg({ maxBranches: 2 }), "target", {
      seed: true,
      keepAlsoKey: "old",
    });
    expect(res.branchKey).toBe("target");
    expect(res.seededFrom).not.toBeNull(); // seeded (from freshest sibling)
    expect(existsSync(res.path)).toBe(true); // real index file exists → enumerable
    const remaining = listBranchIndexes(paths).map((b) => b.key).sort();
    // target (just resolved+seeded) + old (pinned) survive; fillers evicted.
    // (target consumes a slot; old is protected → both fillers exceed cap 2.)
    expect(remaining).toContain("target");
    expect(remaining).toContain("old");
    expect(remaining).not.toContain("filler1");
    expect(remaining).not.toContain("filler2");
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

describe("seed copy is WAL-consistent", () => {
  /**
   * Create a WAL-mode index at `path` and leave `rows` COMMITTED rows in an
   * un-checkpointed `-wal`, returning the STILL-OPEN handle (the caller must
   * close it). Mirrors the daemon's live source: `journal_mode = WAL`, committed
   * data that has NOT been checkpointed into the main file, connection open.
   */
  function openLiveWalIndex(path: string, rows: number): Database {
    const db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("CREATE TABLE t (x INTEGER);");
    // Fold the schema into main so the ONLY thing left in the -wal is the row
    // data below — makes the "un-checkpointed committed data" precise.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    const insert = db.prepare("INSERT INTO t (x) VALUES (?)");
    const many = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(i);
    });
    many(rows);
    // Sanity: the committed rows really are sitting in a NON-EMPTY -wal (i.e. we
    // have reproduced the risky "open source with un-checkpointed WAL" state).
    let walSize = 0;
    try {
      walSize = statSync(path + "-wal").size;
    } catch {
      walSize = 0;
    }
    expect(walSize).toBeGreaterThan(0);
    return db;
  }

  test("seed from a LIVE-open source captures un-checkpointed WAL commits", () => {
    const r = tmp();
    const paths = hayvenPathsFor(r);
    const config = cfg();

    // A pre-existing branch "a" is the freshest seed source; its index is OPEN
    // (the daemon's live connection) with committed-but-un-checkpointed rows.
    const ROWS = 500;
    const aPath = branchSqlitePath(paths, "a");
    mkdirSync(join(aPath, ".."), { recursive: true });
    const live = openLiveWalIndex(aPath, ROWS);

    try {
      // Switch to a NEW branch "b": resolve+seed b FROM a while a is still open.
      // This drives the real seed path (resolveWriteIndexForKey → freshestSeed →
      // copySqlite), the code under test.
      const res = resolveWriteIndexForKey(paths, config, "b", { seed: true });
      expect(res.seededFrom).toBe(aPath);
      const bPath = res.path;
      expect(existsSync(bPath)).toBe(true);

      // The DESTINATION must open READONLY (many read commands do) and contain
      // ALL committed rows. Pre-fix this FAILS: copyFileSync(main) alone dropped
      // every un-checkpointed WAL commit (count 0) or refused to open at all.
      const dst = new Database(bPath, { readonly: true });
      try {
        const got = dst.query("SELECT count(*) AS c FROM t").get() as { c: number };
        expect(got.c).toBe(ROWS);
      } finally {
        dst.close();
      }

      // And the copy must NOT depend on a live `-shm`: a copied shared-memory
      // file is meaningless, so we never emit one at the destination.
      expect(existsSync(bPath + "-shm")).toBe(false);
    } finally {
      live.close();
    }
  });

  test("seed from a cleanly-closed source stays consistent", () => {
    const r = tmp();
    const paths = hayvenPathsFor(r);
    const config = cfg();

    const ROWS = 250;
    const aPath = branchSqlitePath(paths, "a");
    mkdirSync(join(aPath, ".."), { recursive: true });
    // Same data, but CLOSE the source (last-connection close checkpoints) so its
    // on-disk state is already a consistent single main file (the fast path).
    openLiveWalIndex(aPath, ROWS).close();

    const res = resolveWriteIndexForKey(paths, config, "b", { seed: true });
    expect(res.seededFrom).toBe(aPath);

    const dst = new Database(res.path, { readonly: true });
    try {
      const got = dst.query("SELECT count(*) AS c FROM t").get() as { c: number };
      expect(got.c).toBe(ROWS);
    } finally {
      dst.close();
    }
  });
});
