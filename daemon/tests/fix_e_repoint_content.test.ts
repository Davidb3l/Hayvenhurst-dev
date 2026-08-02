/**
 * E3 — `repointToBranch` used to trust `seeded` as proof of content.
 *
 * The old guard was `freshenOk || seeded || next.counts().nodes > 0`, and the
 * comment above it read "A seeded index (has content)". That premise is false:
 * `seeded` only means the resolver COPIED a sibling branch's index file. If the
 * source index was itself empty (or half-written), `seeded` is true, the graph
 * holds nothing, the `||` short-circuits before the node count is ever read —
 * and the daemon swaps in and serves an EMPTY index with no error anywhere.
 *
 * The fix consults the graph itself (`checkIndexIntegrity()` + a real node
 * count), and flags the abort so the poller backs off rather than retrying a
 * full freshen ingest every 2 s forever.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { activeBranchKey, branchSqlitePath, resolveWriteIndex } from "../src/db/branch_index.ts";
import { Db } from "../src/db/queries.ts";
import type { DbRef } from "../src/daemon/server.ts";
import { repointToBranch, type RepointDeps } from "../src/cli/daemon.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

function git(repo: string, args: string[]): void {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

function seedNode(db: Db, id: string, name: string): void {
  db.upsertNode({
    id,
    name,
    qualified_name: name,
    kind: "function",
    language: "typescript",
    file: `src/${name}.ts`,
    range: [1, 10],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

/** Materialize a branch index. With `nodeId` omitted it is migrated but EMPTY —
 *  a perfectly valid seed SOURCE that carries no content. */
function buildBranchIndex(path: string, nodeId?: string, nodeName?: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Db(path);
  db.migrate();
  if (nodeId && nodeName) seedNode(db, nodeId, nodeName);
  db.close();
}

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

describe("E3: branch re-point refuses to serve an empty index", () => {
  let repo: string;
  let paths: ReturnType<typeof hayvenPathsFor>;
  const logger = createLogger({ toFile: false, toStderr: false });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "hayven-fixe-repoint-"));
    git(repo, ["init", "-q", "-b", "X"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    mkdirSync(join(repo, ".hayven"), { recursive: true });
    Bun.spawnSync(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
    git(repo, ["branch", "Y"]);
    paths = hayvenPathsFor(repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("does NOT swap into a HALF-WRITTEN target index when freshen fails", async () => {
    // The old guard's third clause was a bare `next.counts().nodes > 0`, which
    // an index wrecked by an interrupted ingest satisfies: node rows flush in
    // batches BEFORE the parser's exit-code gate, while edges/call-sites/stats
    // are written after, so a killed ingest leaves a populated-LOOKING graph
    // with no edges. Counting rows cannot tell that apart from a good index;
    // `checkIndexIntegrity()` can, via the in-progress marker.
    const xPath = resolveWriteIndex(paths, DEFAULT_CONFIG).path;
    buildBranchIndex(xPath, "src/onlyX", "onlyX");
    const dbRef: DbRef = { current: new Db(xPath), path: xPath, branchKey: "X" };

    git(repo, ["checkout", "-q", "Y"]);
    const yPath = branchSqlitePath(paths, "Y");
    buildBranchIndex(yPath, "src/onlyY", "onlyY");
    // Simulate the interrupted ingest: rows present, marker never cleared.
    const wounded = new Db(yPath);
    wounded.markIngestInProgress(Date.now());
    expect(wounded.checkIndexIntegrity().ok).toBe(false);
    expect(wounded.counts().nodes).toBeGreaterThan(0); // the old guard's evidence
    wounded.close();

    const deps: RepointDeps = {
      dbRef,
      paths,
      config: DEFAULT_CONFIG,
      logger,
      runIngestExclusive: makeSerializer(),
      // In the real failure the freshen is exactly what did not work — which is
      // why the index was left half-written in the first place.
      freshen: async () => {
        throw new Error("native parse failed");
      },
    };

    const newKey = activeBranchKey(paths, DEFAULT_CONFIG);
    expect(newKey).toBe("Y");
    const result = await repointToBranch(deps, newKey);

    // THE property: keep serving X's good index rather than swapping in a
    // half-written one. Pre-fix, `nodes > 0` was enough and Y was served.
    expect(result.branchKey).toBe("X");
    expect(result.path).toBe(xPath);
    expect(dbRef.path).toBe(xPath);
    expect(dbRef.current.getNode("src/onlyX")).not.toBeNull();
    // …and the abort is FLAGGED so the poller backs off instead of retrying a
    // full freshen ingest on every 2 s tick, forever.
    expect(result.aborted).toBe(true);

    dbRef.current.close();
  });

  test("still swaps when the target index genuinely holds content", async () => {
    const xPath = resolveWriteIndex(paths, DEFAULT_CONFIG).path;
    buildBranchIndex(xPath, "src/onlyX", "onlyX");
    const dbRef: DbRef = { current: new Db(xPath), path: xPath, branchKey: "X" };

    git(repo, ["checkout", "-q", "Y"]);
    const yPath = branchSqlitePath(paths, "Y");
    buildBranchIndex(yPath, "src/onlyY", "onlyY");

    const deps: RepointDeps = {
      dbRef,
      paths,
      config: DEFAULT_CONFIG,
      logger,
      runIngestExclusive: makeSerializer(),
      // Freshen fails, but Y's index has REAL content — so the swap is correct.
      freshen: async () => {
        throw new Error("native parse failed");
      },
    };

    const result = await repointToBranch(deps, activeBranchKey(paths, DEFAULT_CONFIG));

    expect(result.branchKey).toBe("Y");
    expect(result.aborted).toBeFalsy();
    expect(dbRef.current.getNode("src/onlyY")).not.toBeNull();
    expect(dbRef.current.getNode("src/onlyX")).toBeNull();

    dbRef.current.close();
  });

  test("a SUCCESSFUL freshen still swaps even into an empty branch", async () => {
    // Regression guard on the fix itself: an empty branch is a legitimate state,
    // and refusing forever would re-point-loop the poller instead.
    const xPath = resolveWriteIndex(paths, DEFAULT_CONFIG).path;
    buildBranchIndex(xPath, "src/onlyX", "onlyX");
    const dbRef: DbRef = { current: new Db(xPath), path: xPath, branchKey: "X" };

    git(repo, ["checkout", "-q", "Y"]);
    buildBranchIndex(branchSqlitePath(paths, "Y"));

    const deps: RepointDeps = {
      dbRef,
      paths,
      config: DEFAULT_CONFIG,
      logger,
      runIngestExclusive: makeSerializer(),
      freshen: async () => {}, // completed; the branch simply has no code
    };

    const result = await repointToBranch(deps, activeBranchKey(paths, DEFAULT_CONFIG));

    expect(result.branchKey).toBe("Y");
    expect(result.aborted).toBeFalsy();

    dbRef.current.close();
  });
});
