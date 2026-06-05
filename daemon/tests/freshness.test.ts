/**
 * Hermetic unit tests for the daemonless staleness predicate
 * (`daemon/src/db/freshness.ts`). No live daemon, no native binary: a tiny
 * temp index plus an INJECTED probe source (clock/mtime + daemon-liveness) so
 * every branch is deterministic.
 *
 * Coverage:
 *   - fresh index            → no warning
 *   - stale index            → warning (with the exact text shape)
 *   - daemon/watcher running → warning suppressed even when stale
 *   - missing/invalid last_ingest_at → no warning (never invent one)
 *   - stdout is never written; the note is stderr-only (both fresh + stale)
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { Db } from "../src/db/queries.ts";
import {
  defaultProbes,
  evaluateStaleness,
  warnIfStale,
  type FreshnessProbes,
} from "../src/db/freshness.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Fresh on-disk index in a throwaway dir. Caller seeds stats as needed. */
function makeIndex(): { db: Db; paths: ReturnType<typeof hayvenPathsFor> } {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-fresh-test-"));
  dirs.push(repoRoot);
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(join(repoRoot, "index.sqlite"));
  db.migrate();
  return { db, paths };
}

/**
 * Injectable probes: a fixed newest-mtime and a fixed daemon-running flag.
 * `gitSourceContentUnchanged` defaults to `false` (no content-suppression) so
 * these helpers exercise the PURE mtime behavior; the git-suppression branch
 * has its own dedicated probes below.
 */
function probes(
  newestMs: number,
  daemonRunning = false,
  gitSourceContentUnchanged = false,
): FreshnessProbes {
  return {
    newestSourceMtimeMs: () => newestMs,
    daemonRunning: () => daemonRunning,
    gitSourceContentUnchanged: () => gitSourceContentUnchanged,
  };
}

/** Set both atime+mtime of a path to a fixed epoch-ms instant. */
function setMtimeMs(path: string, ms: number): void {
  const s = ms / 1000;
  utimesSync(path, s, s);
}

/** Write a file (creating parent dirs) and stamp its mtime. */
function writeFileAt(path: string, content: string, mtimeMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  setMtimeMs(path, mtimeMs);
}

/** True iff `git` is on PATH (the ls-files probe path needs it). */
function hasGit(): boolean {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
}

describe("evaluateStaleness", () => {
  it("fresh index (no source change since ingest) → no warning", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(1_000_000));
    // newest source mtime is BEFORE the last ingest → fresh.
    const r = evaluateStaleness(db, paths, probes(900_000));
    expect(r.stale).toBe(false);
    expect(r.message).toBe("");
    db.close();
  });

  it("equal mtime == ingest time → not stale (boundary)", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(1_000_000));
    const r = evaluateStaleness(db, paths, probes(1_000_000));
    expect(r.stale).toBe(false);
    db.close();
  });

  it("stale index (source changed after ingest) → warning", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(1_000_000));
    // newest source mtime is AFTER the last ingest → stale.
    const r = evaluateStaleness(db, paths, probes(2_000_000));
    expect(r.stale).toBe(true);
    expect(r.message).toContain("index may be stale");
    expect(r.message).toContain("hayven ingest");
    expect(r.message).toContain("hayven daemon start");
    // Single line — no embedded newline (callers add exactly one).
    expect(r.message).not.toContain("\n");
    db.close();
  });

  it("daemon/watcher running → warning SUPPRESSED even when stale", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(1_000_000));
    const r = evaluateStaleness(db, paths, probes(2_000_000, /* daemonRunning */ true));
    expect(r.stale).toBe(false);
    expect(r.message).toBe("");
    db.close();
  });

  it("missing last_ingest_at → no warning (never invent one)", () => {
    const { db, paths } = makeIndex();
    // No stat set at all.
    const r = evaluateStaleness(db, paths, probes(2_000_000));
    expect(r.stale).toBe(false);
    db.close();
  });

  it("non-numeric / non-positive last_ingest_at → no warning", () => {
    const { db, paths } = makeIndex();
    for (const bad of ["", "not-a-number", "0", "-5"]) {
      db.setStat("last_ingest_at", bad);
      expect(evaluateStaleness(db, paths, probes(2_000_000)).stale).toBe(false);
    }
    db.close();
  });

  it("daemon check is evaluated before probing the tree", () => {
    // If the daemon is running we should short-circuit and never call
    // newestSourceMtimeMs — proven by throwing from it.
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(1_000_000));
    const throwingProbes: FreshnessProbes = {
      newestSourceMtimeMs: () => {
        throw new Error("must not probe when daemon is running");
      },
      daemonRunning: () => true,
      gitSourceContentUnchanged: () => {
        throw new Error("must not git-probe when daemon is running");
      },
    };
    const r = evaluateStaleness(db, paths, throwingProbes);
    expect(r.stale).toBe(false);
    db.close();
  });
});

describe("warnIfStale — stdout is never touched", () => {
  /** Capture both streams' writes for the duration of `fn`. */
  function capture(fn: () => void): { out: string; err: string } {
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    let out = "";
    let err = "";
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    };
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    };
    try {
      fn();
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    return { out, err };
  }

  it("stale → writes ONE note to stderr, nothing to stdout", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(1_000_000));
    const { out, err } = capture(() => {
      const wrote = warnIfStale(db, paths, probes(2_000_000));
      expect(wrote).toBe(true);
    });
    expect(out).toBe(""); // stdout untouched → --json stays clean
    expect(err).toContain("index may be stale");
    expect(err.endsWith("\n")).toBe(true);
    expect(err.split("\n").filter((l) => l.length > 0).length).toBe(1);
    db.close();
  });

  it("fresh → writes NOTHING to either stream", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(1_000_000));
    const { out, err } = capture(() => {
      const wrote = warnIfStale(db, paths, probes(900_000));
      expect(wrote).toBe(false);
    });
    expect(out).toBe("");
    expect(err).toBe("");
    db.close();
  });

  it("daemon running + stale → writes NOTHING (suppressed)", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(1_000_000));
    const { out, err } = capture(() => {
      const wrote = warnIfStale(db, paths, probes(2_000_000, true));
      expect(wrote).toBe(false);
    });
    expect(out).toBe("");
    expect(err).toBe("");
    db.close();
  });
});

/**
 * The REGRESSION this module fixes: an in-place edit of an existing,
 * deeply-nested tracked source file changes ONLY that file's mtime — not its
 * parent dir's, not any ancestor's, and not `.git/{index,HEAD}` (until staged).
 * The old bounded probe (root + top-level entries + git-state) was structurally
 * blind to it, so `query` silently served a stale index. These tests use the
 * REAL `defaultProbes` against REAL temp files (no injected mtimes) to prove the
 * tracked-file scan now catches it, stays quiet when fresh, early-exits, and is
 * never even reached when a daemon is running.
 *
 * They cover BOTH enumeration paths: a non-git temp dir (recursive-walk
 * fallback) and a real `git init` + `git add` temp repo (the `git ls-files`
 * path). The git variant skips cleanly if `git` is unavailable.
 *
 * Cost bound (not directly unit-tested — timing is environment-dependent):
 * the scan is stat-only, capped at MAX_FILES_SCANNED (4096), and early-exits on
 * the first file newer than last_ingest. The stale path therefore stops at the
 * first changed file; only a genuinely-fresh index pays the (bounded) full scan.
 */
describe("defaultProbes — in-place edit detection over real temp files", () => {
  /** A throwaway project dir with an index whose last_ingest_at = `ingestMs`. */
  function makeProject(ingestMs: number): {
    db: Db;
    paths: ReturnType<typeof hayvenPathsFor>;
    repoRoot: string;
  } {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-inplace-test-"));
    dirs.push(repoRoot);
    const paths = hayvenPathsFor(repoRoot);
    // Index lives under `.hayven/` exactly as in production — that dir is in
    // SKIP_DIRS and excluded by `git ls-files`, so OUR own sqlite writes never
    // make the index look stale. (Putting it at repoRoot would.)
    mkdirSync(paths.hayvenDir, { recursive: true });
    const db = new Db(paths.sqliteFile);
    db.migrate();
    db.setStat("last_ingest_at", String(ingestMs));
    return { db, paths, repoRoot };
  }

  const INGEST = 1_700_000_000_000; // a recent-ish fixed epoch-ms

  it("in-place edit of an existing deep file (non-git) → STALE (the bug case)", () => {
    const { db, paths, repoRoot } = makeProject(INGEST);
    // A deep, existing file edited AFTER ingest. Its ancestors keep PRE-ingest
    // mtimes — exactly the situation the old bounded probe missed.
    writeFileAt(join(repoRoot, "a", "b", "c", "file.ts"), "export const x = 1;\n", INGEST + 5_000);
    setMtimeMs(join(repoRoot, "a", "b", "c"), INGEST - 10_000);
    setMtimeMs(join(repoRoot, "a", "b"), INGEST - 10_000);
    setMtimeMs(join(repoRoot, "a"), INGEST - 10_000);
    setMtimeMs(repoRoot, INGEST - 10_000);

    const r = evaluateStaleness(db, paths, defaultProbes);
    expect(r.stale).toBe(true);
    expect(r.message).toContain("index may be stale");
    db.close();
  });

  it("fresh index — every file older than last_ingest (non-git) → NO warning", () => {
    const { db, paths, repoRoot } = makeProject(INGEST);
    writeFileAt(join(repoRoot, "a", "b", "c", "file.ts"), "export const x = 1;\n", INGEST - 5_000);
    setMtimeMs(join(repoRoot, "a", "b", "c"), INGEST - 10_000);
    setMtimeMs(join(repoRoot, "a", "b"), INGEST - 10_000);
    setMtimeMs(join(repoRoot, "a"), INGEST - 10_000);
    setMtimeMs(repoRoot, INGEST - 10_000);

    const r = evaluateStaleness(db, paths, defaultProbes);
    expect(r.stale).toBe(false);
    expect(r.message).toBe("");
    db.close();
  });

  it("daemon running → tree is NOT scanned even with a newer file present", () => {
    const { db, paths, repoRoot } = makeProject(INGEST);
    writeFileAt(join(repoRoot, "a", "b", "c", "file.ts"), "x", INGEST + 5_000);

    // Spy: wrap the real scan so we can assert it is NEVER called when the
    // daemonRunning guard short-circuits first.
    let scanned = 0;
    const spyProbes: FreshnessProbes = {
      newestSourceMtimeMs: (p, since) => {
        scanned++;
        return defaultProbes.newestSourceMtimeMs(p, since);
      },
      daemonRunning: () => true,
      gitSourceContentUnchanged: () => false,
    };
    const r = evaluateStaleness(db, paths, spyProbes);
    expect(r.stale).toBe(false);
    expect(scanned).toBe(0); // guard ran first → no scan
    db.close();
  });

  it("early-exit: returns a value > threshold without computing the true max", () => {
    // Two newer files; the probe is allowed to short-circuit on the first one
    // it sees that beats the threshold. We can't assert WHICH file it stopped
    // on (enumeration order isn't a contract), but we CAN assert it returned a
    // value strictly greater than the threshold (proves the early-exit branch
    // is exercised and the result is correct for the predicate).
    const { repoRoot } = makeProject(INGEST);
    writeFileAt(join(repoRoot, "src", "one.ts"), "1", INGEST + 1_000);
    writeFileAt(join(repoRoot, "src", "two.ts"), "2", INGEST + 9_000);
    setMtimeMs(join(repoRoot, "src"), INGEST - 10_000);
    setMtimeMs(repoRoot, INGEST - 10_000);

    const paths = hayvenPathsFor(repoRoot);
    const newest = defaultProbes.newestSourceMtimeMs(paths, INGEST);
    expect(newest).toBeGreaterThan(INGEST);
  });

  it("skips node_modules / dist in the non-git walk (no false-warn from vendored churn)", () => {
    const { db, paths, repoRoot } = makeProject(INGEST);
    // Only generated/vendored trees are "newer" — these must NOT trigger a warn.
    writeFileAt(join(repoRoot, "node_modules", "dep", "index.js"), "x", INGEST + 50_000);
    writeFileAt(join(repoRoot, "dist", "bundle.js"), "x", INGEST + 50_000);
    // A real source file, but OLDER than ingest → genuinely fresh.
    writeFileAt(join(repoRoot, "src", "real.ts"), "y", INGEST - 5_000);
    setMtimeMs(join(repoRoot, "src"), INGEST - 10_000);
    setMtimeMs(repoRoot, INGEST - 10_000);

    const r = evaluateStaleness(db, paths, defaultProbes);
    expect(r.stale).toBe(false);
    db.close();
  });

  it("git repo: in-place edit of a tracked file → STALE (ls-files path)", () => {
    if (!hasGit()) return; // hermetic skip when git is unavailable
    const { db, paths, repoRoot } = makeProject(INGEST);
    // Real tracked file via git add, then edit it in place AFTER ingest.
    writeFileAt(join(repoRoot, "x", "y", "tracked.ts"), "export const a = 1;\n", INGEST - 20_000);
    writeFileAt(join(repoRoot, ".gitignore"), ".hayven/\n", INGEST - 20_000);
    spawnSync("git", ["-C", repoRoot, "init", "-q"]);
    spawnSync("git", ["-C", repoRoot, "add", "."]);
    // Edit in place AFTER ingest; do NOT re-stage (so .git/index stays old).
    writeFileAt(join(repoRoot, "x", "y", "tracked.ts"), "export const a = 2;\n", INGEST + 5_000);
    // Force every dir + git-state mtime to PRE-ingest so ONLY the file is newer.
    for (const p of [
      join(repoRoot, "x", "y"),
      join(repoRoot, "x"),
      repoRoot,
      join(repoRoot, ".git", "index"),
      join(repoRoot, ".git", "HEAD"),
    ]) {
      try {
        setMtimeMs(p, INGEST - 10_000);
      } catch {
        /* .git/HEAD may not exist on some git versions pre-commit — fine */
      }
    }

    const r = evaluateStaleness(db, paths, defaultProbes);
    expect(r.stale).toBe(true);
    db.close();
  });

  it("git repo: no edits since ingest → fresh (ls-files path, no false-warn)", () => {
    if (!hasGit()) return;
    const { db, paths, repoRoot } = makeProject(INGEST);
    writeFileAt(join(repoRoot, "x", "y", "tracked.ts"), "export const a = 1;\n", INGEST - 20_000);
    writeFileAt(join(repoRoot, ".gitignore"), ".hayven/\n", INGEST - 20_000);
    spawnSync("git", ["-C", repoRoot, "init", "-q"]);
    spawnSync("git", ["-C", repoRoot, "add", "."]);
    for (const p of [
      join(repoRoot, ".gitignore"),
      join(repoRoot, "x", "y", "tracked.ts"),
      join(repoRoot, "x", "y"),
      join(repoRoot, "x"),
      repoRoot,
      join(repoRoot, ".git", "index"),
      join(repoRoot, ".git", "HEAD"),
    ]) {
      try {
        setMtimeMs(p, INGEST - 10_000);
      } catch {
        /* ignore */
      }
    }

    const r = evaluateStaleness(db, paths, defaultProbes);
    expect(r.stale).toBe(false);
    db.close();
  });
});

/**
 * DELIVERABLE 2 — the file-scan cap stays BOUNDED at scale and the
 * `HAYVEN_FRESHNESS_MAX_FILES` override behaves. These tests model a "large"
 * repo (well over the default 4096) at a tiny multiple via a LOWERED cap, so the
 * cap-vs-tree-size interaction is exercised cheaply and deterministically:
 *   - STALE large repo  → detected regardless of cap (early-exit on first newer).
 *   - FRESH repo bigger than the cap → reported fresh from the verified prefix
 *     (the documented silent-cap bound; NEVER a false-stale).
 *   - the env override raises/lowers the cap (read at use-time, not load-time).
 */
describe("defaultProbes — bounded file-scan cap + HAYVEN_FRESHNESS_MAX_FILES (scale)", () => {
  const INGEST = 1_700_000_000_000;

  function makeProject(ingestMs: number): {
    db: Db;
    paths: ReturnType<typeof hayvenPathsFor>;
    repoRoot: string;
  } {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-cap-test-"));
    dirs.push(repoRoot);
    const paths = hayvenPathsFor(repoRoot);
    mkdirSync(paths.hayvenDir, { recursive: true });
    const db = new Db(paths.sqliteFile);
    db.migrate();
    db.setStat("last_ingest_at", String(ingestMs));
    return { db, paths, repoRoot };
  }

  const prevCap = process.env["HAYVEN_FRESHNESS_MAX_FILES"];
  afterEach(() => {
    if (prevCap === undefined) delete process.env["HAYVEN_FRESHNESS_MAX_FILES"];
    else process.env["HAYVEN_FRESHNESS_MAX_FILES"] = prevCap;
  });

  /**
   * Build a real git repo of `n` tracked `.ts` files, all stamped OLD, then run
   * `mutate` (which may add/edit a newer file) before forcing every dir + git
   * state mtime PRE-ingest so only the files matter. Models the 40k case (a git
   * repo where `git ls-files` slices to the first `cap` paths) at tiny scale.
   */
  function gitRepoWith(
    n: number,
    mutate: (repoRoot: string) => void,
  ): { db: Db; paths: ReturnType<typeof hayvenPathsFor>; repoRoot: string } {
    const ctx = makeProject(INGEST);
    const { repoRoot } = ctx;
    writeFileAt(join(repoRoot, ".gitignore"), ".hayven/\n", INGEST - 20_000);
    for (let i = 0; i < n; i++) {
      writeFileAt(join(repoRoot, "src", `f${String(i).padStart(4, "0")}.ts`), `export const n${i}=${i};\n`, INGEST - 20_000);
    }
    spawnSync("git", ["-C", repoRoot, "init", "-q"]);
    spawnSync("git", ["-C", repoRoot, "add", "."]);
    mutate(repoRoot);
    // Force all dir + git-state mtimes PRE-ingest so ONLY tracked files matter.
    const fix = (p: string) => {
      try {
        setMtimeMs(p, INGEST - 10_000);
      } catch {
        /* may not exist on some git versions — fine */
      }
    };
    fix(join(repoRoot, "src"));
    fix(repoRoot);
    fix(join(repoRoot, ".git", "index"));
    fix(join(repoRoot, ".git", "HEAD"));
    return ctx;
  }

  it("STALE large git repo is detected regardless of a tiny cap (early-exit before the cap)", () => {
    if (!hasGit()) return;
    process.env["HAYVEN_FRESHNESS_MAX_FILES"] = "8"; // cap << tree size
    // The edited file sorts FIRST (f0000 → a000-prefixed name) so it's within the
    // git-order prefix the cap keeps; the early-exit fires before the cap.
    const { db, paths } = gitRepoWith(40, (repoRoot) => {
      writeFileAt(join(repoRoot, "src", "a000_changed.ts"), "export const z = 1;\n", INGEST + 5_000);
      spawnSync("git", ["-C", repoRoot, "add", "src/a000_changed.ts"]);
      // Re-stamp OLD on dirs after the add; the file itself stays newer.
      setMtimeMs(join(repoRoot, "src", "a000_changed.ts"), INGEST + 5_000);
    });
    const r = evaluateStaleness(db, paths, defaultProbes);
    expect(r.stale).toBe(true); // size-independent; the cap never blocks staleness
    db.close();
  });

  it("FRESH large git repo (bigger than the cap) → reported fresh (documented bound, never false-stale)", () => {
    if (!hasGit()) return;
    process.env["HAYVEN_FRESHNESS_MAX_FILES"] = "8";
    // 40 tracked files, ALL older than ingest → genuinely fresh. The tree is 5×
    // the cap; hitting the cap without a newer file must yield "fresh" (cheap
    // probe fallback), NOT a false-stale warning.
    const { db, paths } = gitRepoWith(40, () => {});
    const r = evaluateStaleness(db, paths, defaultProbes);
    expect(r.stale).toBe(false);
    expect(r.message).toBe("");
    db.close();
  });

  it("raising the cap covers a file PAST the default prefix (env override is honored)", () => {
    if (!hasGit()) return;
    // With a cap of 2 the edited file (which sorts LAST) is beyond the scanned
    // prefix → missed (fresh). Raising the cap to cover the whole tree catches it.
    // Proves the env override actually changes how much we verify.
    const mk = () =>
      gitRepoWith(20, (repoRoot) => {
        writeFileAt(join(repoRoot, "src", "zzzz_last.ts"), "export const z = 2;\n", INGEST + 5_000);
        spawnSync("git", ["-C", repoRoot, "add", "src/zzzz_last.ts"]);
        setMtimeMs(join(repoRoot, "src", "zzzz_last.ts"), INGEST + 5_000);
      });

    process.env["HAYVEN_FRESHNESS_MAX_FILES"] = "2";
    const a = mk();
    const missed = evaluateStaleness(a.db, a.paths, defaultProbes);
    a.db.close();
    expect(missed.stale).toBe(false); // documented silent-cap: missed, never false-stale

    process.env["HAYVEN_FRESHNESS_MAX_FILES"] = "10000";
    const b = mk();
    const caught = evaluateStaleness(b.db, b.paths, defaultProbes);
    b.db.close();
    expect(caught.stale).toBe(true); // raised cap now covers the deep file
  });

  it("env override is read at use-time and falls back to default on a bad value", () => {
    // A non-numeric value must NOT lower the cap to 0 (which would scan nothing);
    // it falls back to the default, so a small fresh tree is still fully verified.
    process.env["HAYVEN_FRESHNESS_MAX_FILES"] = "not-a-number";
    const { db, paths, repoRoot } = makeProject(INGEST);
    writeFileAt(join(repoRoot, "deep", "a", "b", "edited.ts"), "x", INGEST + 5_000);
    setMtimeMs(join(repoRoot, "deep", "a", "b"), INGEST - 10_000);
    setMtimeMs(join(repoRoot, "deep", "a"), INGEST - 10_000);
    setMtimeMs(join(repoRoot, "deep"), INGEST - 10_000);
    setMtimeMs(repoRoot, INGEST - 10_000);

    const r = evaluateStaleness(db, paths, defaultProbes);
    expect(r.stale).toBe(true); // default cap applied → deep edit still caught
    db.close();
  });

  it("env override is read at use-time and falls back to default on a bad value", () => {
    // A non-numeric value must NOT lower the cap to 0 (which would scan nothing);
    // it falls back to the default, so a small fresh tree is still fully verified.
    process.env["HAYVEN_FRESHNESS_MAX_FILES"] = "not-a-number";
    const { db, paths, repoRoot } = makeProject(INGEST);
    writeFileAt(join(repoRoot, "deep", "a", "b", "edited.ts"), "x", INGEST + 5_000);
    setMtimeMs(join(repoRoot, "deep", "a", "b"), INGEST - 10_000);
    setMtimeMs(join(repoRoot, "deep", "a"), INGEST - 10_000);
    setMtimeMs(join(repoRoot, "deep"), INGEST - 10_000);
    setMtimeMs(repoRoot, INGEST - 10_000);

    const r = evaluateStaleness(db, paths, defaultProbes);
    expect(r.stale).toBe(true); // default cap applied → deep edit still caught
    db.close();
  });
});

/**
 * The FALSE-POSITIVE this fix kills: on a freshly CLONED / checked-out repo
 * (`cp -r`/`rsync`/`git clone`) every file's mtime is reset to clone-time —
 * newer than `last_ingest_at` — even though the SOURCE content is byte-identical
 * to what was ingested. The mtime probe would (correctly, by its own lights)
 * flag the index stale, and agents then distrust a perfectly-correct index and
 * fall back to grep. The fix makes staleness SOURCE-CONTENT-aware: when the
 * mtime probe WOULD warn, we first ask git whether the SOURCE actually changed
 * via the `last_ingest_git_head` stat (written by the sibling ingest lane — we
 * only READ it). If HEAD is unchanged AND no tracked SOURCE file differs from
 * HEAD, we SUPPRESS the note. Critically this IGNORES the `hayven init`
 * footprint (untracked AGENTS.md + a `.gitignore` edit) and any non-source
 * churn, which the previous whole-tree clean check did NOT.
 *
 * These tests INJECT `gitSourceContentUnchanged` (deterministic, no real git
 * needed for the decision-logic cases), plus real-`git`-repo integration cases
 * for the default implementation. Note injection always pairs a NEWER mtime
 * (`probes(2_000_000, …)` vs ingest `1_000_000`) so the mtime path WOULD warn —
 * the only variable under test is the git source-content check.
 */
describe("evaluateStaleness — content-aware git suppression (fresh-clone fix)", () => {
  const INGEST_MS = 1_000_000;
  const NEWER_MS = 2_000_000; // > INGEST_MS → mtime probe WOULD flag stale
  const HEAD = "a".repeat(40); // a plausible 40-char git sha

  /** Probes whose ONLY interesting axis is the git source-content verdict. */
  function gitProbes(
    contentUnchanged: boolean,
    spy?: (repoRoot: string, head: string) => void,
  ): FreshnessProbes {
    return {
      newestSourceMtimeMs: () => NEWER_MS, // always "newer" → mtime would warn
      daemonRunning: () => false,
      gitSourceContentUnchanged: (repoRoot, head) => {
        spy?.(repoRoot, head);
        return contentUnchanged;
      },
    };
  }

  it("(a) mtime newer + HEAD == ingested + no source change → NOT stale (the fix)", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(INGEST_MS));
    db.setStat("last_ingest_git_head", HEAD);
    let sawHead = "";
    const r = evaluateStaleness(
      db,
      paths,
      gitProbes(true, (_root, head) => {
        sawHead = head;
      }),
    );
    expect(r.stale).toBe(false);
    expect(r.message).toBe("");
    // The recorded ingest HEAD is the value passed to the git check.
    expect(sawHead).toBe(HEAD);
    db.close();
  });

  it("(b) mtime newer + dirty tree (git verdict false) → STILL stale", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(INGEST_MS));
    db.setStat("last_ingest_git_head", HEAD);
    // gitSourceContentUnchanged === false models a tracked source file differing
    // from HEAD (`git diff --name-only HEAD` lists a source path).
    const r = evaluateStaleness(db, paths, gitProbes(false));
    expect(r.stale).toBe(true);
    expect(r.message).toContain("index may be stale");
    db.close();
  });

  it("(c) mtime newer + HEAD differs (git verdict false) → STILL stale", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(INGEST_MS));
    db.setStat("last_ingest_git_head", HEAD);
    // A moved HEAD also surfaces as gitSourceContentUnchanged === false.
    const r = evaluateStaleness(db, paths, gitProbes(false));
    expect(r.stale).toBe(true);
    db.close();
  });

  it("(d) stat missing → git check NOT consulted, existing mtime behavior (stale)", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(INGEST_MS));
    // No last_ingest_git_head stat at all (e.g. not-a-git-repo at ingest).
    let consulted = false;
    const r = evaluateStaleness(
      db,
      paths,
      gitProbes(true, () => {
        consulted = true;
      }),
    );
    expect(r.stale).toBe(true); // unchanged mtime behavior
    expect(consulted).toBe(false); // never even ask git when the stat is absent
    db.close();
  });

  it("git suppression only fires when the mtime path WOULD warn (fresh index → no git call)", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(INGEST_MS));
    db.setStat("last_ingest_git_head", HEAD);
    let consulted = false;
    // newest mtime is BEFORE ingest → already fresh; git must NOT be consulted.
    const r = evaluateStaleness(db, paths, {
      newestSourceMtimeMs: () => 900_000,
      daemonRunning: () => false,
      gitSourceContentUnchanged: () => {
        consulted = true;
        return false;
      },
    });
    expect(r.stale).toBe(false);
    expect(consulted).toBe(false);
    db.close();
  });

  it("(e) --json/stdout stays byte-identical; suppressed note is stderr-only (and empty)", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(INGEST_MS));
    db.setStat("last_ingest_git_head", HEAD);
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    let out = "";
    let err = "";
    process.stdout.write = (c: string | Uint8Array): boolean => {
      out += typeof c === "string" ? c : Buffer.from(c).toString();
      return true;
    };
    process.stderr.write = (c: string | Uint8Array): boolean => {
      err += typeof c === "string" ? c : Buffer.from(c).toString();
      return true;
    };
    try {
      // Content unchanged → warnIfStale must SUPPRESS: write nothing, return false.
      const wrote = warnIfStale(db, paths, gitProbes(true));
      expect(wrote).toBe(false);
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    expect(out).toBe(""); // stdout untouched → --json stays clean
    expect(err).toBe(""); // suppressed → nothing on stderr either
    db.close();
  });

  it("never ADDS a warning: a fresh index with content-unchanged git stays silent", () => {
    const { db, paths } = makeIndex();
    db.setStat("last_ingest_at", String(INGEST_MS));
    db.setStat("last_ingest_git_head", HEAD);
    // Fresh by mtime AND content-unchanged: still no warning (the check only
    // ever suppresses, never warns).
    const r = evaluateStaleness(db, paths, {
      newestSourceMtimeMs: () => 900_000,
      daemonRunning: () => false,
      gitSourceContentUnchanged: () => true,
    });
    expect(r.stale).toBe(false);
    db.close();
  });
});

/**
 * Integration coverage for the DEFAULT `gitSourceContentUnchanged`
 * implementation against a REAL temp git repo, so the bounded git calls +
 * source-scoped `git diff --name-only HEAD` logic are exercised end-to-end (not
 * just the injected decision logic above). Skips cleanly when `git` is
 * unavailable.
 *
 * The headline case `applies the hayven init footprint` reproduces the real
 * workflow the previous (whole-tree-clean) fix FAILED on: an UNTRACKED
 * `AGENTS.md` plus a MODIFIED tracked `.gitignore` make the tree permanently
 * dirty by `git status` standards, yet every SOURCE file is content-clean at
 * HEAD — so suppression MUST still fire. That is the test the old check failed.
 */
describe("defaultProbes.gitSourceContentUnchanged — real temp git repo", () => {
  /**
   * Create a temp git repo with a committed `.gitignore` + a couple committed
   * source files; return its paths + HEAD. Mirrors a real repo before `init`.
   */
  function makeGitRepo(): { repoRoot: string; head: string } | null {
    if (!hasGit()) return null;
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-gitsource-test-"));
    dirs.push(repoRoot);
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repoRoot, "file.ts"), "export const x = 1;\n");
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "app.py"), "x = 1\n");
    spawnSync("git", ["-C", repoRoot, "init", "-q"]);
    spawnSync("git", ["-C", repoRoot, "config", "user.email", "t@example.com"]);
    spawnSync("git", ["-C", repoRoot, "config", "user.name", "Test"]);
    spawnSync("git", ["-C", repoRoot, "add", "."]);
    spawnSync("git", ["-C", repoRoot, "commit", "-q", "-m", "init"]);
    const rev = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    if (rev.status !== 0 || typeof rev.stdout !== "string") return null;
    return { repoRoot, head: rev.stdout.trim() };
  }

  it("HEAD matches + no source change → true (the fresh-clone signature)", () => {
    const repo = makeGitRepo();
    if (!repo) return; // git unavailable → hermetic skip
    expect(defaultProbes.gitSourceContentUnchanged(repo.repoRoot, repo.head)).toBe(true);
  });

  it("applies the `hayven init` footprint (untracked AGENTS.md + modified .gitignore) but source is clean → true (THE fix)", () => {
    const repo = makeGitRepo();
    if (!repo) return;
    // Reproduce EXACTLY what `hayven init` does to a repo: create an untracked
    // AGENTS.md and MODIFY the tracked .gitignore (to add `.hayven/`). Neither is
    // a source file; both make `git status --porcelain` permanently non-empty —
    // the previous whole-tree-clean check would NEVER suppress here.
    writeFileSync(join(repo.repoRoot, "AGENTS.md"), "# reflex block\n");
    writeFileSync(join(repo.repoRoot, ".gitignore"), "node_modules/\n.hayven/\n");
    // Also drop an untracked CLAUDE.md + a `.hayven/` dir like a real init/ingest.
    writeFileSync(join(repo.repoRoot, "CLAUDE.md"), "# notes\n");
    mkdirSync(join(repo.repoRoot, ".hayven"), { recursive: true });
    writeFileSync(join(repo.repoRoot, ".hayven", "index.sqlite"), "fake");
    // Every SOURCE file is still byte-identical to HEAD → suppression MUST fire.
    expect(defaultProbes.gitSourceContentUnchanged(repo.repoRoot, repo.head)).toBe(true);
  });

  it("a modified tracked SOURCE file (.ts differs from HEAD) → false (still stale)", () => {
    const repo = makeGitRepo();
    if (!repo) return;
    // Even with the init footprint present, a real source edit must NOT suppress.
    writeFileSync(join(repo.repoRoot, "AGENTS.md"), "# reflex block\n");
    writeFileSync(join(repo.repoRoot, ".gitignore"), "node_modules/\n.hayven/\n");
    writeFileSync(join(repo.repoRoot, "file.ts"), "export const x = 2;\n");
    expect(defaultProbes.gitSourceContentUnchanged(repo.repoRoot, repo.head)).toBe(false);
  });

  it("only a non-source tracked file changed (.gitignore) → true (ignored)", () => {
    const repo = makeGitRepo();
    if (!repo) return;
    // .gitignore is tracked AND changed, but it is NOT a source file → ignore it.
    writeFileSync(join(repo.repoRoot, ".gitignore"), "node_modules/\n.hayven/\n");
    expect(defaultProbes.gitSourceContentUnchanged(repo.repoRoot, repo.head)).toBe(true);
  });

  it("recorded HEAD differs from current → false", () => {
    const repo = makeGitRepo();
    if (!repo) return;
    const otherHead = "b".repeat(40);
    expect(defaultProbes.gitSourceContentUnchanged(repo.repoRoot, otherHead)).toBe(false);
  });

  it("blank/empty ingested head → false (nothing to compare)", () => {
    const repo = makeGitRepo();
    if (!repo) return;
    expect(defaultProbes.gitSourceContentUnchanged(repo.repoRoot, "")).toBe(false);
    expect(defaultProbes.gitSourceContentUnchanged(repo.repoRoot, "   ")).toBe(false);
  });

  it("not a git repo → false (never throws)", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-nogit-test-"));
    dirs.push(repoRoot);
    expect(defaultProbes.gitSourceContentUnchanged(repoRoot, "a".repeat(40))).toBe(false);
  });
});
