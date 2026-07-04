/**
 * LIVE branch re-pointing — the daemon following a `git checkout` while it is up.
 *
 * Before this feature the daemon resolved its index ONCE at startup
 * (`new Db(resolveWriteIndex(...).path)`) and served that branch forever, going
 * stale on a branch switch. Now a poller detects the branch change and
 * `repointToBranch` swaps the served db to the new branch's index — seeded +
 * freshened — serialized through the SAME ingest chain so no ingest is
 * mid-write during the swap.
 *
 * Test approach — deterministic, NO real long-lived HTTP daemon:
 *  (1) RE-POINT: build per-branch indexes for X and Y with DISTINCT nodes, point
 *      the swappable `DbRef` at X, then call `repointToBranch(...)` for Y (after
 *      a real `git checkout Y`). Assert the holder now reports Y's path/branchKey
 *      and a read through the swapped db returns Y's node, not X's.
 *  (2) SERIALIZATION: the re-point runs INSIDE `runIngestExclusive`; we drive it
 *      through the same single-chain serializer `startDaemon` uses and assert the
 *      OLD db handle is closed after the swap.
 *  (3) NO-OP: with `activeBranchKey` null (per-branch disabled), `repointToBranch`
 *      returns the current path and does NOT swap — behavior UNCHANGED.
 *  (4) HEALTH: `buildApp` with a `dbRef` exposes the served `branch`/`branch_path`
 *      on `GET /api/health`, and a swap is reflected there (deps.db reads through
 *      the holder).
 *
 * No native binary is needed — we materialize each branch index ourselves
 * (migrate a Db at the resolved path) and pass a `freshen` that is a no-op (the
 * branch indexes already hold their distinct data), exercising the swap logic
 * deterministically.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import {
  activeBranchKey,
  branchKey,
  branchSqlitePath,
  resolveWriteIndex,
} from "../src/db/branch_index.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp, type DbRef } from "../src/daemon/server.ts";
import { repointToBranch, type RepointDeps } from "../src/cli/daemon.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { rootLogger } from "../src/util/log.ts";

function git(repo: string, args: string[]): void {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

/** Seed a node whose bare `name` == `qualified_name` so it resolves by name. */
function seedNode(db: Db, id: string, name: string, file: string): void {
  db.upsertNode({
    id,
    name,
    qualified_name: name,
    kind: "function",
    language: "typescript",
    file,
    range: [1, 10],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

/** Materialize a branch's index file (migrate a Db there) with one seed node. */
function buildBranchIndex(path: string, nodeId: string, nodeName: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Db(path);
  db.migrate();
  seedNode(db, nodeId, nodeName, `src/${nodeName}.ts`);
  db.close();
}

/** A serializer that mirrors `startDaemon`'s single-chain `runIngestExclusive`. */
function makeSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<void> = Promise.resolve();
  return function runIngestExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(() => fn());
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

describe("daemon live branch re-pointing", () => {
  let repo: string;
  let paths: ReturnType<typeof hayvenPathsFor>;
  const logger = rootLogger().child("test");

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "hayven-branch-switch-"));
    git(repo, ["init", "-q", "-b", "X"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    mkdirSync(join(repo, ".hayven"), { recursive: true });
    // A commit so we can create a second branch off it.
    Bun.spawnSync(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
    git(repo, ["branch", "Y"]);
    paths = hayvenPathsFor(repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("re-points the served db from branch X to branch Y", async () => {
    // On branch X — build X's index with a node ONLY X has.
    expect(branchKey(repo)).toBe("X");
    const xPath = resolveWriteIndex(paths, DEFAULT_CONFIG).path;
    expect(xPath).toBe(branchSqlitePath(paths, "X"));
    buildBranchIndex(xPath, "src/onlyX", "onlyX");

    // The holder the daemon serves through, pointed at X.
    const dbRef: DbRef = { current: new Db(xPath), path: xPath, branchKey: "X" };
    // Sanity: X's db sees onlyX, not onlyY.
    expect(dbRef.current.getNode("src/onlyX")).not.toBeNull();
    expect(dbRef.current.getNode("src/onlyY")).toBeNull();

    // Now build Y's index (with a node ONLY Y has) and switch HEAD to Y.
    git(repo, ["checkout", "-q", "Y"]);
    expect(branchKey(repo)).toBe("Y");
    const yPath = resolveWriteIndex(paths, DEFAULT_CONFIG).path;
    expect(yPath).toBe(branchSqlitePath(paths, "Y"));
    expect(yPath).not.toBe(xPath);
    buildBranchIndex(yPath, "src/onlyY", "onlyY");

    // Track that the OLD db gets closed by spying via a closed-flag read.
    const oldDb = dbRef.current;
    let oldClosed = false;
    const origClose = oldDb.close.bind(oldDb);
    oldDb.close = () => {
      oldClosed = true;
      origClose();
    };

    const deps: RepointDeps = {
      dbRef,
      paths,
      config: DEFAULT_CONFIG,
      logger,
      runIngestExclusive: makeSerializer(),
      // The branch indexes already hold their data; no native binary needed.
      freshen: async () => {},
    };

    const newKey = activeBranchKey(paths, DEFAULT_CONFIG);
    expect(newKey).toBe("Y");
    const result = await repointToBranch(deps, newKey);

    // The holder now reports Y's index.
    expect(result.path).toBe(yPath);
    expect(result.branchKey).toBe("Y");
    expect(dbRef.path).toBe(yPath);
    expect(dbRef.branchKey).toBe("Y");
    // A read through the SWAPPED db hits Y's data, not X's.
    expect(dbRef.current.getNode("src/onlyY")).not.toBeNull();
    expect(dbRef.current.getNode("src/onlyX")).toBeNull();
    // The old db was closed after the swap.
    expect(oldClosed).toBe(true);

    dbRef.current.close();
  });

  test("re-point is a no-op when activeBranchKey is null (per-branch disabled)", async () => {
    const noBranch = { ...DEFAULT_CONFIG, index: { ...DEFAULT_CONFIG.index, perBranch: false } };
    const legacyPath = paths.sqliteFile;
    buildBranchIndex(legacyPath, "src/legacy", "legacy");
    const dbRef: DbRef = { current: new Db(legacyPath), path: legacyPath, branchKey: null };

    let freshened = false;
    const deps: RepointDeps = {
      dbRef,
      paths,
      config: noBranch,
      logger,
      runIngestExclusive: makeSerializer(),
      freshen: async () => {
        freshened = true;
      },
    };

    const key = activeBranchKey(paths, noBranch);
    expect(key).toBeNull();
    const result = await repointToBranch(deps, key);

    // Unchanged: same path, no swap, no freshen.
    expect(result.path).toBe(legacyPath);
    expect(result.branchKey).toBeNull();
    expect(dbRef.path).toBe(legacyPath);
    expect(freshened).toBe(false);

    dbRef.current.close();
  });

  test("(A) swaps to the DETECTED key even if HEAD moves to a THIRD branch mid-freshen", async () => {
    // On X — build X's index and point the holder at it.
    const xPath = resolveWriteIndex(paths, DEFAULT_CONFIG).path;
    buildBranchIndex(xPath, "src/onlyX", "onlyX");
    const dbRef: DbRef = { current: new Db(xPath), path: xPath, branchKey: "X" };

    // Poller detects Y and builds Y's index (with distinct data).
    git(repo, ["checkout", "-q", "Y"]);
    const yPath = branchSqlitePath(paths, "Y");
    buildBranchIndex(yPath, "src/onlyY", "onlyY");

    // A third branch Z the daemon must NOT accidentally swap to. `freshen`
    // simulates a real `git checkout Z` happening DURING the multi-second
    // freshen window — the old code re-read HEAD via resolveWriteIndex and
    // would have retargeted the swap to Z. The fix resolves FOR the detected
    // key (Y), so HEAD moving is irrelevant to the swap target.
    git(repo, ["branch", "Z"]);
    const deps: RepointDeps = {
      dbRef,
      paths,
      config: DEFAULT_CONFIG,
      logger,
      runIngestExclusive: makeSerializer(),
      freshen: async () => {
        // HEAD moves to Z mid-freshen.
        git(repo, ["checkout", "-q", "Z"]);
        expect(branchKey(repo)).toBe("Z");
      },
    };

    // Poller DETECTED Y — the swap target must be Y, not Z (current HEAD).
    const result = await repointToBranch(deps, "Y");
    expect(result.branchKey).toBe("Y");
    expect(result.path).toBe(yPath);
    // The holder + served index agree on Y (NOT Z, and NOT re-derived from HEAD).
    expect(dbRef.branchKey).toBe("Y");
    expect(dbRef.path).toBe(yPath);
    expect(dbRef.current.getNode("src/onlyY")).not.toBeNull();
    expect(dbRef.current.getNode("src/onlyX")).toBeNull();
    // Z's index was never resolved/created by this re-point.
    expect(existsSync(branchSqlitePath(paths, "Z"))).toBe(false);

    dbRef.current.close();
  });

  test("(B) freshen failure on an EMPTY (unseeded) index does NOT swap — old index still served", async () => {
    // The holder serves a db at a STANDALONE path (outside branchesDir and NOT
    // the legacy sqliteFile), so that when we switch to a brand-new branch W:
    //   - there is NO seedable sibling branch index (branchesDir is empty), and
    //   - there is NO legacy index (paths.sqliteFile does not exist),
    // → resolveWriteIndexForKey creates an empty migrated Db (seededFrom null).
    // Then freshen THROWS (first-record failure on an idle/broken tree). The
    // daemon must keep serving the (still-open) old db, not swap in empty W.
    const standalonePath = join(repo, ".hayven", "served-old.sqlite");
    buildBranchIndex(standalonePath, "src/onlyX", "onlyX");
    const dbRef: DbRef = { current: new Db(standalonePath), path: standalonePath, branchKey: "X" };
    const oldDb = dbRef.current;
    let oldClosed = false;
    const origClose = oldDb.close.bind(oldDb);
    oldDb.close = () => {
      oldClosed = true;
      origClose();
    };

    git(repo, ["checkout", "-q", "-b", "W"]);
    expect(branchKey(repo)).toBe("W");
    const wPath = branchSqlitePath(paths, "W");
    // Premise: no legacy index and no sibling branch index → W is unseeded.
    expect(existsSync(paths.sqliteFile)).toBe(false);
    expect(existsSync(branchSqlitePath(paths, "X"))).toBe(false);

    const deps: RepointDeps = {
      dbRef,
      paths,
      config: DEFAULT_CONFIG,
      logger,
      runIngestExclusive: makeSerializer(),
      freshen: async () => {
        throw new Error("simulated ingest failure on first record");
      },
    };

    const result = await repointToBranch(deps, "W");

    // Aborted: still serving the old (standalone) index, holder unchanged, old
    // db NOT closed.
    expect(result.path).toBe(standalonePath);
    expect(result.branchKey).toBe("X");
    expect(dbRef.path).toBe(standalonePath);
    expect(dbRef.branchKey).toBe("X");
    expect(dbRef.current).toBe(oldDb);
    expect(dbRef.current.getNode("src/onlyX")).not.toBeNull();
    expect(oldClosed).toBe(false);
    // W's dir may have been created by resolution, but its (empty) db must NOT
    // be what we serve.
    expect(dbRef.path).not.toBe(wPath);

    dbRef.current.close();
  });

  test("(B) freshen failure on a SEEDED index still swaps (has content)", async () => {
    // On X — X's per-branch index has real data and is a SIBLING that a new
    // branch S will seed from (freshestSeed picks the freshest sibling in
    // branchesDir).
    const xPath = resolveWriteIndex(paths, DEFAULT_CONFIG).path;
    buildBranchIndex(xPath, "src/onlyX", "onlyX");
    const dbRef: DbRef = { current: new Db(xPath), path: xPath, branchKey: "X" };

    git(repo, ["checkout", "-q", "-b", "S"]);
    const sPath = branchSqlitePath(paths, "S");

    const deps: RepointDeps = {
      dbRef,
      paths,
      config: DEFAULT_CONFIG,
      logger,
      runIngestExclusive: makeSerializer(),
      freshen: async () => {
        throw new Error("freshen failed but index was seeded");
      },
    };

    const result = await repointToBranch(deps, "S");
    // Seeded from sibling X → swap happens despite the freshen throw; the seeded
    // content is served (better than the wrong branch).
    expect(result.branchKey).toBe("S");
    expect(result.path).toBe(sPath);
    expect(dbRef.path).toBe(sPath);
    expect(dbRef.current.getNode("src/onlyX")).not.toBeNull();

    dbRef.current.close();
  });

  test("/api/health reports the served branch + index path through the holder", async () => {
    const xPath = resolveWriteIndex(paths, DEFAULT_CONFIG).path;
    buildBranchIndex(xPath, "src/onlyX", "onlyX");
    const dbRef: DbRef = { current: new Db(xPath), path: xPath, branchKey: "X" };

    const app = buildApp({
      db: dbRef.current,
      dbRef,
      config: DEFAULT_CONFIG,
      paths,
      logger,
      ingest: { current: () => null, start: async () => ({}) as never },
      crdt: { close() {} } as never,
      daemonVersion: "test",
    });

    const res = await app.handle(new Request("http://localhost/api/health"));
    const body = (await res.json()) as { root: string; branch: string | null; branch_path: string | null };
    expect(body.root).toBe(paths.repoRoot);
    expect(body.branch).toBe("X");
    expect(body.branch_path).toBe(xPath);

    // After a holder swap, health reflects the new branch (deps.db reads through
    // the holder, so the served db is the new one too).
    git(repo, ["checkout", "-q", "Y"]);
    const yPath = resolveWriteIndex(paths, DEFAULT_CONFIG).path;
    buildBranchIndex(yPath, "src/onlyY", "onlyY");
    const oldDb = dbRef.current;
    dbRef.current = new Db(yPath);
    dbRef.path = yPath;
    dbRef.branchKey = "Y";
    oldDb.close();

    const res2 = await app.handle(new Request("http://localhost/api/health"));
    const body2 = (await res2.json()) as { branch: string | null; branch_path: string | null };
    expect(body2.branch).toBe("Y");
    expect(body2.branch_path).toBe(yPath);

    dbRef.current.close();
  });
});
