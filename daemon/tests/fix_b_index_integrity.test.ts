/**
 * LANE B regression tests — index integrity + ingest correctness.
 *
 * Every test here targets a bug whose signature was "plausible-looking default
 * causing UNBOUNDED work or SILENT wrongness with no user-visible signal". They
 * are written to FAIL if the corresponding fix is reverted (each was
 * mutation-tested by reverting the fix in place and confirming a red run).
 *
 * Hermetic by construction:
 *   - every index lives in its own `mkdtemp` dir; no global state is touched,
 *     so no `$HAYVEN_HOME` sandboxing is required (and `$HOME` is never read);
 *   - freshness probes are INJECTED, so nothing depends on whether a real
 *     daemon happens to be answering on 127.0.0.1:7777 or on any port being
 *     free — `daemonRunning` is a value we pass in, never a probe;
 *   - the native binary is replaced by a scripted `ParseRun`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { resolveWriteIndexForKey } from "../src/db/branch_index.ts";
import { evaluateStaleness, type FreshnessProbes } from "../src/db/freshness.ts";
import { Db } from "../src/db/queries.ts";
import { runIngest } from "../src/graph/ingest.ts";
import {
  pruneOrphanNodeMarkdowns,
  removeNodeMarkdowns,
  writeNodeMarkdowns,
} from "../src/graph/nodeWriter.ts";
import type { GraphNode } from "../src/graph/types.ts";
import type { NativeRecord } from "../src/native/protocol.ts";
import type { ParseRun } from "../src/native/process.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import type { HayvenConfig } from "../src/config/defaults.ts";

const dirs: string[] = [];
const envRestore: Array<[string, string | undefined]> = [];

/**
 * Sandbox global state via `$HAYVEN_HOME` (read at call-time in `util/paths.ts`,
 * so setting it here is effective). Nothing in this file is *supposed* to reach
 * global state — every index lives in its own `mkdtemp` dir — but this is the
 * belt-and-braces the house rules require, and the tripwire at the bottom of
 * this file asserts we never wrote outside the temp dir. NEVER sandbox via
 * `$HOME`: Bun resolves `os.homedir()` once per process, so mutating it at
 * runtime does nothing and the test would read and REWRITE the developer's real
 * `~/.hayven/projects.json`.
 */
const HAYVEN_HOME_SANDBOX = mkdtempSync(join(tmpdir(), "hayven-fixb-home-"));
process.env["HAYVEN_HOME"] = HAYVEN_HOME_SANDBOX;

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of envRestore.splice(0)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function setEnv(key: string, value: string): void {
  envRestore.push([key, process.env[key]]);
  process.env[key] = value;
}

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `hayven-${prefix}-`));
  dirs.push(d);
  return d;
}

/** A throwaway on-disk index in its own repo root. */
function makeIndex(): { db: Db; repoRoot: string; sqlitePath: string } {
  const repoRoot = tmp("fixb");
  const sqlitePath = join(repoRoot, "index.sqlite");
  const db = new Db(sqlitePath);
  db.migrate();
  return { db, repoRoot, sqlitePath };
}

/**
 * Injected freshness probes. `daemonRunning` is an explicit VALUE, never a live
 * port/pidfile probe — a real daemon running on this machine must not be able
 * to change what these tests exercise.
 */
function probes(newestMs: number, daemonRunning = false): FreshnessProbes {
  return {
    newestSourceMtimeMs: () => newestMs,
    daemonRunning: () => daemonRunning,
    gitSourceContentUnchanged: () => false,
  };
}

/** A scripted native run. `exitCode` defaults to 0 (clean exit). */
function fakeRun(records: NativeRecord[], exitCode = 0): ParseRun {
  async function* iter(): AsyncIterable<NativeRecord> {
    for (const r of records) yield r;
  }
  return {
    records: iter(),
    wait: async () => exitCode,
    kill: async () => undefined,
    recentStderr: () => ["scripted stderr"],
  };
}

function nodeRec(file: string, name: string): NativeRecord {
  return {
    type: "node",
    file,
    name,
    qualified_name: name,
    kind: "function",
    language: "typescript",
    range: [1, 5],
    ast_hash: `hash-${file}-${name}`,
  };
}

function moduleRec(file: string, name: string): NativeRecord {
  return {
    type: "node",
    file,
    name,
    qualified_name: name,
    kind: "module",
    language: "typescript",
    range: [0, 0],
    ast_hash: `mod-${file}`,
  };
}

function callRec(srcFile: string, srcName: string, dstName: string, line: number): NativeRecord {
  return {
    type: "edge",
    src_file: srcFile,
    src_name: srcName,
    dst_name: dstName,
    kind: "static_call",
    line,
    col: 1,
  } as NativeRecord;
}

function doneRec(nodes: number, edges: number): NativeRecord {
  return { type: "done", files_done: 1, nodes, edges, elapsed_ms: 1 };
}

function gNode(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    name: id.split("/").pop() ?? id,
    qualified_name: id,
    kind: "function",
    language: "typescript",
    file: "src/a.ts",
    range: [1, 2],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* B1 — an EMPTY index must not report itself FRESH                    */
/* ------------------------------------------------------------------ */

describe("B1: an interrupted ingest must not leave the index reporting FRESH", () => {
  it("reports BROKEN (not fresh) after clearGraph with no re-populate, even when mtimes say fresh", () => {
    const { db, repoRoot } = makeIndex();
    const paths = hayvenPathsFor(repoRoot);

    // A successful ingest: one node, and the stats a real run would write.
    db.upsertNodes([gNode("a/one")]);
    const ingestAt = 10_000_000;
    db.setStat("last_ingest_at", String(ingestAt));
    db.setStat("last_ingest_nodes", String(db.counts().nodes));
    expect(db.counts().nodes).toBe(1);

    // The crash: clearGraph commits, then the re-parse dies (timeout/kill -9).
    db.clearGraph();
    expect(db.counts().nodes).toBe(0);
    // `last_ingest_at` lives in `stats`, which clearGraph does not touch — this
    // survival is exactly what used to certify the wreckage as fresh.
    expect(db.getStat("last_ingest_at")).toBe(String(ingestAt));

    // Source mtimes OLDER than the last ingest: the mtime comparison alone
    // would say "fresh". This is the precise state that was proven to return
    // {"stale":false,"message":""}.
    const verdict = evaluateStaleness(db, paths, probes(ingestAt - 5_000));

    expect(verdict.stale).toBe(true);
    // Assert the SPECIFIC reason. `toBeDefined()` made this test vacuous: with
    // `last_ingest_nodes` seeded three lines above, it passed off the
    // empty-but-claims-content detector even with clearGraph's marker deleted,
    // so the headline invariant of this lane was unpinned.
    expect(verdict.broken).toBe("empty-but-claims-content");
    expect(verdict.message).toContain("BROKEN");
    db.close();
  });

  it("pins clearGraph's MARKER specifically, with no watermark to fall back on", () => {
    // Isolates the OTHER channel: no `last_ingest_nodes` is ever written, so
    // `empty-but-claims-content` cannot fire and the ONLY thing that can report
    // this index as broken is the in-progress marker clearGraph stamps.
    const { db, repoRoot } = makeIndex();
    const paths = hayvenPathsFor(repoRoot);

    db.upsertNodes([gNode("a/one")]);
    const ingestAt = 10_000_000;
    db.setStat("last_ingest_at", String(ingestAt));
    expect(db.getStat("last_ingest_nodes")).toBeNull();

    db.clearGraph();

    expect(db.getStat("last_ingest_nodes")).toBeNull(); // no fallback signal
    const integrity = db.checkIndexIntegrity();
    expect(integrity.reason).toBe("ingest-interrupted");

    const verdict = evaluateStaleness(db, paths, probes(ingestAt - 5_000));
    expect(verdict.stale).toBe(true);
    expect(verdict.broken).toBe("ingest-interrupted");
    db.close();
  });

  it("detects empty-but-claims-content even when the in-progress marker is gone", () => {
    // An index wiped by an older build (or a marker cleared by hand) still has
    // the count mismatch. Nothing anywhere used to compare these two numbers.
    const { db } = makeIndex();
    db.setStat("last_ingest_nodes", "2");
    db.clearIngestInProgress();

    const integrity = db.checkIndexIntegrity();
    expect(integrity.ok).toBe(false);
    expect(integrity.reason).toBe("empty-but-claims-content");
    expect(integrity.nodes).toBe(0);
    expect(integrity.claimedNodes).toBe(2);
    db.close();
  });

  it("reports the empty-but-claims-content case even when a daemon IS running", () => {
    // A live daemon is the most likely thing to have wiped the index, so
    // deferring to the watcher here would suppress the one signal that matters.
    const { db, repoRoot } = makeIndex();
    const paths = hayvenPathsFor(repoRoot);
    db.setStat("last_ingest_at", "10000000");
    db.setStat("last_ingest_nodes", "5");

    const verdict = evaluateStaleness(db, paths, probes(1, /* daemonRunning */ true));
    expect(verdict.stale).toBe(true);
    expect(verdict.broken).toBe("empty-but-claims-content");
    db.close();
  });

  it("does NOT false-fire on a never-ingested (legitimately empty) index", () => {
    // The cardinal sin is a false warning. An index with no recorded watermark
    // and no marker is empty-but-honest and must stay silent.
    const { db, repoRoot } = makeIndex();
    const paths = hayvenPathsFor(repoRoot);
    expect(db.checkIndexIntegrity().ok).toBe(true);
    const verdict = evaluateStaleness(db, paths, probes(Date.now()));
    expect(verdict.stale).toBe(false);
    expect(verdict.message).toBe("");
    db.close();
  });

  it("clears the marker on a SUCCESSFUL ingest, so a healthy index is never flagged", async () => {
    const { db, repoRoot } = makeIndex();
    db.clearGraph(); // stamps the in-progress marker
    expect(db.ingestInProgressSince()).not.toBeNull();

    await runIngest({
      db,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0" },
        moduleRec("src/a.ts", "a"),
        nodeRec("src/a.ts", "one"),
        doneRec(2, 0),
      ]),
      repoRoot,
      fullRebuild: true,
    });

    expect(db.ingestInProgressSince()).toBeNull();
    expect(db.checkIndexIntegrity().ok).toBe(true);
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* B1-concurrency — a second process must not clear our marker         */
/* ------------------------------------------------------------------ */

describe("B1 (concurrency): the in-progress marker is OWNED, not global", () => {
  /**
   * Reproduces the reviewer's end-to-end trigger: `hayven ingest --full` in a
   * shell while the daemon watcher ingests the SAME index. Nothing serializes
   * them (`runIngestExclusive` is in-process only), so each holds its own `Db`
   * handle against one file — modelled here by two handles, which is exactly
   * what two processes have.
   */
  it("process B finishing does NOT un-flag process A's in-flight wipe", async () => {
    const repoRoot = tmp("fixb-conc");
    const sqlitePath = join(repoRoot, "index.sqlite");
    const seed = new Db(sqlitePath);
    seed.migrate();
    seed.upsertNodes([gNode("a/one"), gNode("a/two"), gNode("a/three")]);
    seed.setStat("last_ingest_at", String(10_000_000));
    seed.recordNodeWatermark(3, true);
    seed.close();

    const A = new Db(sqlitePath); // the CLI's `ingest --full`
    const B = new Db(sqlitePath); // the daemon watcher

    // A clears the graph and dies before repopulating.
    A.clearGraph();
    expect(A.counts().nodes).toBe(0);
    expect(A.ingestInProgressSince()).not.toBeNull();

    // B now completes its own scoped ingest against the same file. Its success
    // transaction must NOT retract A's marker, and must NOT lower the watermark
    // to the 0 it currently observes.
    await runIngest({
      db: B,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0" },
        moduleRec("src/z.ts", "z"),
        doneRec(1, 0),
      ]),
      repoRoot,
    });

    const check = new Db(sqlitePath, { readonly: true });
    const integrity = check.checkIndexIntegrity();
    const paths = hayvenPathsFor(repoRoot);
    const verdict = evaluateStaleness(check, paths, probes(9_000_000));

    // Before the fix this whole block read {ok:true,reason:"ok"} / stale:false.
    expect(integrity.ok).toBe(false);
    expect(verdict.stale).toBe(true);

    check.close();
    A.close();
    B.close();
  });

  it("a handle that never began an ingest cannot retract someone else's marker", () => {
    const repoRoot = tmp("fixb-conc2");
    const sqlitePath = join(repoRoot, "index.sqlite");
    const owner = new Db(sqlitePath);
    owner.migrate();
    owner.beginIngest();
    expect(owner.ingestInProgressSince()).not.toBeNull();

    const stranger = new Db(sqlitePath);
    stranger.endIngest(); // no token → must be a no-op
    stranger.clearIngestInProgress(); // the deprecated alias, likewise

    expect(new Db(sqlitePath, { readonly: true }).ingestInProgressSince()).not.toBeNull();
    owner.close();
    stranger.close();
  });

  it("two overlapping ingests each retract only their own token", () => {
    // The follow-on case: A marks, B marks, B finishes. A's protection must
    // survive — with a single scalar, B's write overwrote A's and B's clear
    // removed it entirely.
    const repoRoot = tmp("fixb-conc3");
    const sqlitePath = join(repoRoot, "index.sqlite");
    const init = new Db(sqlitePath);
    init.migrate();
    init.close();

    const A = new Db(sqlitePath);
    const B = new Db(sqlitePath);
    A.beginIngest();
    B.beginIngest();

    B.endIngest();
    expect(A.ingestInProgressSince()).not.toBeNull(); // A still protected

    A.endIngest();
    expect(A.ingestInProgressSince()).toBeNull(); // now genuinely clear
    A.close();
    B.close();
  });

  it("a scoped run never LOWERS the node watermark", () => {
    const { db } = makeIndex();
    db.recordNodeWatermark(500, true); // an authoritative full rebuild
    db.recordNodeWatermark(0, false); // a scoped run observing a cleared graph
    expect(db.getStat("last_ingest_nodes")).toBe("500");

    db.recordNodeWatermark(900, false); // scoped runs may still RAISE it
    expect(db.getStat("last_ingest_nodes")).toBe("900");

    db.recordNodeWatermark(12, true); // only an authoritative run may lower it
    expect(db.getStat("last_ingest_nodes")).toBe("12");
    db.close();
  });

  it("adopts a legacy scalar marker rather than leaving the index wedged", () => {
    const { db, sqlitePath } = makeIndex();
    db.setStat("ingest_in_progress", String(7_000_000)); // an old build's format
    expect(db.ingestInProgressSince()).toBe(7_000_000);

    const next = new Db(sqlitePath);
    next.beginIngest();
    expect(next.ingestInProgressSince()).toBe(7_000_000); // start time preserved
    next.endIngest();
    expect(next.ingestInProgressSince()).toBeNull(); // and it CAN be retracted
    next.close();
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* B2 — a timed-out ingest leaves nodes with ZERO edges                */
/* ------------------------------------------------------------------ */

describe("B2: a non-zero native exit leaves the index flagged, not silently partial", () => {
  it("throws AND leaves the index marked broken when the parser is SIGTERMed (exit 143)", async () => {
    const { db, repoRoot } = makeIndex();

    // Node rows flush in batches BEFORE the exit-code gate; edges/call sites/
    // stats are all written AFTER it. So this run persists nodes and no edges.
    const records: NativeRecord[] = [
      { type: "start", files_total: 1, version: "0.0.0" },
      moduleRec("src/a.ts", "a"),
      nodeRec("src/a.ts", "one"),
      nodeRec("src/a.ts", "two"),
      callRec("src/a.ts", "one", "two", 3),
    ];

    await expect(
      runIngest({
        db,
        nodesDir: join(repoRoot, "nodes"),
        run: fakeRun(records, 143),
        repoRoot,
        fullRebuild: true,
      }),
    ).rejects.toThrow();

    // The structurally-wrong state the bug produced: populated nodes, no edges.
    expect(db.counts().nodes).toBeGreaterThan(0);
    expect(db.counts().edges).toBe(0);

    // ...but it is no longer SILENT.
    const integrity = db.checkIndexIntegrity();
    expect(integrity.ok).toBe(false);
    expect(integrity.reason).toBe("ingest-interrupted");
    db.close();
  });

  it("surfaces the interrupted state to a reader when no daemon is running", async () => {
    const { db, repoRoot } = makeIndex();
    const paths = hayvenPathsFor(repoRoot);
    db.setStat("last_ingest_at", String(10_000_000));

    await expect(
      runIngest({
        db,
        nodesDir: join(repoRoot, "nodes"),
        run: fakeRun(
          [
            { type: "start", files_total: 1, version: "0.0.0" },
            moduleRec("src/a.ts", "a"),
            nodeRec("src/a.ts", "one"),
          ],
          143,
        ),
        repoRoot,
      }),
    ).rejects.toThrow();

    // mtimes older than the last ingest → the mtime path alone says "fresh".
    const verdict = evaluateStaleness(db, paths, probes(9_000_000, /* daemonRunning */ false));
    expect(verdict.stale).toBe(true);
    expect(verdict.broken).toBe("ingest-interrupted");
    expect(verdict.message).toContain("INCOMPLETE");
    db.close();
  });

  it("stays quiet about an in-flight ingest while a daemon owns the project", async () => {
    // The watcher re-ingests on every save; warning on each of those short
    // windows would be exactly the false-stale noise freshness exists to avoid.
    const { db, repoRoot } = makeIndex();
    const paths = hayvenPathsFor(repoRoot);
    db.upsertNodes([gNode("a/one")]);
    db.setStat("last_ingest_at", String(10_000_000));
    db.markIngestInProgress();

    const verdict = evaluateStaleness(db, paths, probes(9_000_000, /* daemonRunning */ true));
    expect(verdict.stale).toBe(false);
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* B3 — an incremental save must not wipe the whole call_sites table   */
/* ------------------------------------------------------------------ */

describe("B3: an incremental re-ingest replaces only the parsed files' call sites", () => {
  it("preserves OTHER files' call sites when one file is re-parsed", async () => {
    const { db, repoRoot } = makeIndex();

    // A pre-existing graph: two files, each with a call site.
    db.insertCallSites([
      { dst: "b/target", src: "b/caller", kind: "static_call", file: "src/b.ts", line: 9, col: 1 },
      { dst: "a/two", src: "a/one", kind: "static_call", file: "src/a.ts", line: 3, col: 1 },
    ]);
    expect(db.callSitesOf("b/target").length).toBe(1);

    // The watcher's incremental batch: ONE file re-parsed. `fullRebuild` is
    // absent (the safe default), so only src/a.ts's sites may be replaced.
    await runIngest({
      db,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0" },
        moduleRec("src/a.ts", "a"),
        nodeRec("src/a.ts", "one"),
        nodeRec("src/a.ts", "two"),
        callRec("src/a.ts", "one", "two", 4),
        doneRec(3, 1),
      ]),
      repoRoot,
    });

    // THE REGRESSION: this used to be 0 for the entire repo after saving one
    // file, so `refs --sites` silently returned nothing everywhere else.
    expect(db.callSitesOf("b/target").length).toBe(1);
    expect(db.callSitesOf("b/target")[0]?.file).toBe("src/b.ts");

    // The re-parsed file's own sites were REPLACED, not duplicated.
    const aSites = db.callSitesOf("a/two");
    expect(aSites.length).toBe(1);
    expect(aSites[0]?.line).toBe(4);
    db.close();
  });

  it("a declared full rebuild still clears the whole table", async () => {
    const { db, repoRoot } = makeIndex();
    db.insertCallSites([
      { dst: "b/target", src: "b/caller", kind: "static_call", file: "src/b.ts", line: 9, col: 1 },
    ]);

    await runIngest({
      db,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0" },
        moduleRec("src/a.ts", "a"),
        nodeRec("src/a.ts", "one"),
        doneRec(2, 0),
      ]),
      repoRoot,
      fullRebuild: true,
    });

    expect(db.callSitesOf("b/target").length).toBe(0);
    db.close();
  });

  it("deleteNodesByFile also reclaims that file's call sites", () => {
    // A file deleted from the repo is never re-parsed, so the per-file
    // replacement above cannot reach it — its sites would live forever.
    const { db } = makeIndex();
    db.insertCallSites([
      { dst: "x/t", src: "gone/c", kind: "static_call", file: "src/gone.ts", line: 1, col: 1 },
      { dst: "x/t", src: "keep/c", kind: "static_call", file: "src/keep.ts", line: 1, col: 1 },
    ]);

    db.deleteNodesByFile("src/gone.ts");

    const remaining = db.callSitesOf("x/t");
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.file).toBe("src/keep.ts");
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* B4 — emptiness must not PROPAGATE to a new branch index             */
/* ------------------------------------------------------------------ */

describe("B4: a seed with no content is not a valid seed", () => {
  /** Write a branch index at `<branchesDir>/<key>/index.sqlite`. */
  function makeBranchIndex(
    paths: ReturnType<typeof hayvenPathsFor>,
    key: string,
    populate: boolean,
  ): string {
    const p = join(paths.branchesDir, key, "index.sqlite");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(paths.branchesDir, key), { recursive: true });
    const db = new Db(p);
    db.migrate();
    if (populate) {
      db.upsertNodes([gNode("kept/one")]);
      db.setStat("last_ingest_nodes", "1");
      db.setStat("last_ingest_git_head", "a".repeat(40));
    }
    db.close();
    return p;
  }

  const config = { index: { perBranch: true, maxBranches: 8 } } as unknown as HayvenConfig;

  it("skips a newly-EMPTIED sibling even though its mtime makes it the freshest", () => {
    const repoRoot = tmp("fixb-branch");
    const paths = hayvenPathsFor(repoRoot);

    const goodPath = makeBranchIndex(paths, "good", true);
    const emptyPath = makeBranchIndex(paths, "wiped", false);

    // The wiped index is the NEWEST file on disk — a `clearGraph()` write is
    // precisely what made the just-emptied index look freshest, which is how
    // emptiness propagated to every subsequent branch.
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    utimesSync(goodPath, new Date(1_000_000), new Date(1_000_000));
    utimesSync(emptyPath, new Date(9_000_000), new Date(9_000_000));
    expect(statSync(emptyPath).mtimeMs).toBeGreaterThan(statSync(goodPath).mtimeMs);

    const resolved = resolveWriteIndexForKey(paths, config, "feature-x", { seed: true });

    expect(resolved.seededFrom).toBe(goodPath);
    // And the new branch really did inherit CONTENT.
    const seeded = new Db(resolved.path, { readonly: true });
    expect(seeded.counts().nodes).toBe(1);
    seeded.close();
  });

  it("seeds from NOTHING rather than from an empty index (forcing a correct full parse)", () => {
    const repoRoot = tmp("fixb-branch2");
    const paths = hayvenPathsFor(repoRoot);
    makeBranchIndex(paths, "wiped", false);

    const resolved = resolveWriteIndexForKey(paths, config, "feature-y", { seed: true });

    // THE REGRESSION: this used to be the empty index's path, and the seeded
    // branch also inherited its `last_ingest_git_head`, making it eligible for
    // the incremental path at 0 nodes — permanently partial, self-certifying.
    expect(resolved.seededFrom).toBeNull();
  });

  it("refuses a seed whose in-progress marker is still set", () => {
    const repoRoot = tmp("fixb-branch3");
    const paths = hayvenPathsFor(repoRoot);
    const p = makeBranchIndex(paths, "halfwritten", true);
    const db = new Db(p);
    db.markIngestInProgress();
    db.close();

    const resolved = resolveWriteIndexForKey(paths, config, "feature-z", { seed: true });
    expect(resolved.seededFrom).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* B5 — repeated full ingests must not inflate edge weights            */
/* ------------------------------------------------------------------ */

describe("B5: edge writes are idempotent even without a preceding clearGraph", () => {
  const records: NativeRecord[] = [
    { type: "start", files_total: 1, version: "0.0.0" },
    moduleRec("src/a.ts", "a"),
    nodeRec("src/a.ts", "one"),
    nodeRec("src/a.ts", "two"),
    callRec("src/a.ts", "one", "two", 3),
    doneRec(3, 1),
  ];

  async function ingestOnce(db: Db, repoRoot: string): Promise<void> {
    await runIngest({
      db,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun(records),
      repoRoot,
      fullRebuild: true,
    });
  }

  function maxWeight(db: Db): number {
    return (
      db.handle.query<{ w: number | null }, []>("SELECT MAX(weight) AS w FROM edges").get()?.w ?? 0
    );
  }

  it("does NOT double edge weight across repeated full ingests with no clear", async () => {
    const { db, repoRoot } = makeIndex();

    await ingestOnce(db, repoRoot);
    const first = maxWeight(db);
    expect(first).toBe(1);

    // Deliberately NO clearGraph between runs — this is the daemon's fullIngest
    // shape, which is what inflated weights 1 → 2 → 3 without bound.
    await ingestOnce(db, repoRoot);
    await ingestOnce(db, repoRoot);

    expect(maxWeight(db)).toBe(first);
    db.close();
  });

  it("still SUMS multiple occurrences within a single run", async () => {
    // Idempotence must not cost us occurrence counting — three calls on three
    // lines are one edge of weight 3, not one edge of weight 1.
    const { db, repoRoot } = makeIndex();
    await runIngest({
      db,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0" },
        moduleRec("src/a.ts", "a"),
        nodeRec("src/a.ts", "one"),
        nodeRec("src/a.ts", "two"),
        callRec("src/a.ts", "one", "two", 3),
        callRec("src/a.ts", "one", "two", 7),
        callRec("src/a.ts", "one", "two", 11),
        doneRec(3, 3),
      ]),
      repoRoot,
      fullRebuild: true,
    });

    expect(maxWeight(db)).toBe(3);
    // Exactly ONE edge row carrying the summed weight (not three rows).
    expect(db.counts().edges).toBe(1);
    // And each occurrence still has its own call site at its own line.
    const sites = db.callSitesOf("a/two");
    expect(sites.map((s) => s.line).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([3, 7, 11]);
    db.close();
  });

  it("replaceEdges SETS weight where upsertEdges accumulates", () => {
    const { db } = makeIndex();
    const e = { src: "a", dst: "b", kind: "static_call" as const, weight: 4, last_seen: 1 };

    db.upsertEdges([e]);
    db.upsertEdges([e]);
    expect(db.outgoing("a")[0]?.weight).toBe(8); // accumulate — unchanged behaviour

    db.replaceEdges([e]);
    expect(db.outgoing("a")[0]?.weight).toBe(4); // set
    db.replaceEdges([e]);
    expect(db.outgoing("a")[0]?.weight).toBe(4); // idempotent
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* B6 — node markdown: change detection + orphan reclaim               */
/* ------------------------------------------------------------------ */

describe("B6: node markdown is not rewritten unchanged, and orphans are reclaimed", () => {
  it("writes nothing on a second identical pass (and leaves mtimes untouched)", async () => {
    const nodesDir = tmp("fixb-md");
    const nodes = [gNode("a/one"), gNode("a/two"), gNode("b/three")];

    const firstWritten = await writeNodeMarkdowns(nodesDir, nodes);
    expect(firstWritten).toBe(3);

    const path = join(nodesDir, "a", "one.md");
    const mtimeBefore = statSync(path).mtimeMs;

    // The exact incident shape: the same nodes re-written every watcher cycle.
    const secondWritten = await writeNodeMarkdowns(nodesDir, nodes);

    expect(secondWritten).toBe(0);
    expect(statSync(path).mtimeMs).toBe(mtimeBefore);
  });

  it("still writes when a node's content actually changed", async () => {
    const nodesDir = tmp("fixb-md2");
    await writeNodeMarkdowns(nodesDir, [gNode("a/one")]);
    const written = await writeNodeMarkdowns(nodesDir, [gNode("a/one", { ast_hash: "CHANGED" })]);
    expect(written).toBe(1);
    expect(readFileSync(join(nodesDir, "a", "one.md"), "utf8")).toContain("CHANGED");
  });

  it("honours the concurrency knob without changing the result", async () => {
    const nodesDir = tmp("fixb-md3");
    const nodes = Array.from({ length: 25 }, (_, i) => gNode(`pkg/n${i}`));
    expect(await writeNodeMarkdowns(nodesDir, nodes, new Map(), 1)).toBe(25);
    expect(await writeNodeMarkdowns(nodesDir, nodes, new Map(), 16)).toBe(0);
    for (let i = 0; i < 25; i++) {
      expect(existsSync(join(nodesDir, "pkg", `n${i}.md`))).toBe(true);
    }
  });

  it("removeNodeMarkdowns unlinks the named ids and prunes emptied dirs", async () => {
    const nodesDir = tmp("fixb-md4");
    await writeNodeMarkdowns(nodesDir, [gNode("a/gone"), gNode("b/kept")]);

    const removed = removeNodeMarkdowns(nodesDir, ["a/gone"]);

    expect(removed).toBe(1);
    expect(existsSync(join(nodesDir, "a", "gone.md"))).toBe(false);
    expect(existsSync(join(nodesDir, "a"))).toBe(false); // dir reclaimed too
    expect(existsSync(join(nodesDir, "b", "kept.md"))).toBe(true);
  });

  it("pruneOrphanNodeMarkdowns removes files with no surviving node", async () => {
    const nodesDir = tmp("fixb-md5");
    await writeNodeMarkdowns(nodesDir, [gNode("a/one"), gNode("a/renamed_away")]);

    const removed = pruneOrphanNodeMarkdowns(nodesDir, ["a/one"]);

    expect(removed).toBe(1);
    expect(existsSync(join(nodesDir, "a", "one.md"))).toBe(true);
    expect(existsSync(join(nodesDir, "a", "renamed_away.md"))).toBe(false);
  });

  it("a full-rebuild ingest sweeps orphans left by a removed symbol", async () => {
    const { db, repoRoot } = makeIndex();
    const nodesDir = join(repoRoot, "nodes");

    const base: NativeRecord[] = [
      { type: "start", files_total: 1, version: "0.0.0" },
      moduleRec("src/a.ts", "a"),
    ];
    await runIngest({
      db,
      nodesDir,
      run: fakeRun([...base, nodeRec("src/a.ts", "keeper"), nodeRec("src/a.ts", "doomed"), doneRec(3, 0)]),
      repoRoot,
      fullRebuild: true,
      sweepOrphanMarkdown: true,
    });
    const doomed = join(nodesDir, "a", "doomed.md");
    expect(existsSync(doomed)).toBe(true);

    // `doomed` is deleted from the source; the next full ingest must reclaim it.
    db.clearGraph();
    await runIngest({
      db,
      nodesDir,
      run: fakeRun([...base, nodeRec("src/a.ts", "keeper"), doneRec(2, 0)]),
      repoRoot,
      fullRebuild: true,
      sweepOrphanMarkdown: true,
    });

    expect(existsSync(doomed)).toBe(false);
    expect(existsSync(join(nodesDir, "a", "keeper.md"))).toBe(true);
    db.close();
  });

  it("an INCREMENTAL ingest never sweeps (it would delete the rest of the repo)", async () => {
    const { db, repoRoot } = makeIndex();
    const nodesDir = join(repoRoot, "nodes");
    await writeNodeMarkdowns(nodesDir, [gNode("other/untouched")]);

    await runIngest({
      db,
      nodesDir,
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0" },
        moduleRec("src/a.ts", "a"),
        nodeRec("src/a.ts", "one"),
        doneRec(2, 0),
      ]),
      repoRoot,
      // no fullRebuild — the safe default
    });

    expect(existsSync(join(nodesDir, "other", "untouched.md"))).toBe(true);
    db.close();
  });
});

describe("B6 (production path): the write-skip must survive last_seen re-stamping", () => {
  it("a second runIngest of an UNCHANGED repo rewrites no markdown", async () => {
    // THE TEST THAT WAS MISSING. The unit tests above use a fixture pinned to
    // `last_seen: 0` and never route through `runIngest` — but `runIngest`
    // stamps `last_seen: Date.now()` on every node every run and the frontmatter
    // renders it, so a whole-content comparison can never be true in production.
    // The skip was inert and each cycle NET-ADDED a read per node.
    const { db, repoRoot } = makeIndex();
    const nodesDir = join(repoRoot, "nodes");
    const records = (): NativeRecord[] => [
      { type: "start", files_total: 1, version: "0.0.0" },
      moduleRec("src/a.ts", "a"),
      nodeRec("src/a.ts", "one"),
      nodeRec("src/a.ts", "two"),
      doneRec(3, 0),
    ];

    await runIngest({ db, nodesDir, run: fakeRun(records()), repoRoot, fullRebuild: true });
    const p1 = join(nodesDir, "a", "one.md");
    const p2 = join(nodesDir, "a", "two.md");
    const before = [statSync(p1).mtimeMs, statSync(p2).mtimeMs];

    // Ensure a distinguishable clock tick, then re-ingest identical source.
    const t0 = Date.now();
    while (Date.now() - t0 < 12) {
      /* spin briefly so a rewrite would move mtime */
    }
    await runIngest({ db, nodesDir, run: fakeRun(records()), repoRoot, fullRebuild: true });

    expect([statSync(p1).mtimeMs, statSync(p2).mtimeMs]).toEqual(before);
    db.close();
  });

  it("still rewrites through runIngest when the code actually changed", async () => {
    const { db, repoRoot } = makeIndex();
    const nodesDir = join(repoRoot, "nodes");
    const base: NativeRecord[] = [
      { type: "start", files_total: 1, version: "0.0.0" },
      moduleRec("src/a.ts", "a"),
    ];
    await runIngest({
      db,
      nodesDir,
      run: fakeRun([...base, nodeRec("src/a.ts", "one"), doneRec(2, 0)]),
      repoRoot,
      fullRebuild: true,
    });
    const p = join(nodesDir, "a", "one.md");
    expect(readFileSync(p, "utf8")).toContain("range: [1, 5]");

    const moved = { ...(nodeRec("src/a.ts", "one") as object), range: [40, 90] } as NativeRecord;
    await runIngest({
      db,
      nodesDir,
      run: fakeRun([...base, moved, doneRec(2, 0)]),
      repoRoot,
      fullRebuild: true,
    });
    expect(readFileSync(p, "utf8")).toContain("range: [40, 90]");
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* B4/B8 — a scope refusal must not destroy the existing index         */
/* ------------------------------------------------------------------ */

describe("B8 (non-destructive refusal): the cap fires BEFORE the wipe", () => {
  it("leaves a good index intact when the run is refused for scope", async () => {
    const { db, repoRoot } = makeIndex();
    db.upsertNodes([gNode("a/one"), gNode("a/two")]);
    db.recordNodeWatermark(2, true);
    db.setStat("last_ingest_at", String(10_000_000));
    setEnv("HAYVEN_MAX_INGEST_FILES", "3");

    await expect(
      runIngest({
        db,
        nodesDir: join(repoRoot, "nodes"),
        run: fakeRun([
          { type: "start", files_total: 500_000, version: "0.0.0" },
          doneRec(0, 0),
        ]),
        repoRoot,
        fullRebuild: true,
        clearBeforeIngest: true, // the destructive step is DELEGATED to runIngest
      }),
    ).rejects.toThrow(/HAYVEN_MAX_INGEST_FILES/);

    // THE REGRESSION: the clear used to run before `startParse`, so an
    // over-cap repo lost its previously-good index and every retry re-wiped it.
    expect(db.counts().nodes).toBe(2);
    expect(db.checkIndexIntegrity().ok).toBe(true);
    db.close();
  });

  it("retrying after a refusal still finds the index usable (not wedged)", async () => {
    const { db, repoRoot } = makeIndex();
    db.upsertNodes([gNode("a/one")]);
    db.recordNodeWatermark(1, true);
    setEnv("HAYVEN_MAX_INGEST_FILES", "2");

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        runIngest({
          db,
          nodesDir: join(repoRoot, "nodes"),
          run: fakeRun([{ type: "start", files_total: 99, version: "0.0.0" }, doneRec(0, 0)]),
          repoRoot,
          fullRebuild: true,
          clearBeforeIngest: true,
        }),
      ).rejects.toThrow();
      expect(db.counts().nodes).toBe(1); // never destroyed
    }
    db.close();
  });

  it("performs the delegated clear once the run is IN bounds", async () => {
    const { db, repoRoot } = makeIndex();
    db.upsertNodes([gNode("stale/leftover")]);
    setEnv("HAYVEN_MAX_INGEST_FILES", "100");

    await runIngest({
      db,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0" },
        moduleRec("src/a.ts", "a"),
        nodeRec("src/a.ts", "one"),
        doneRec(2, 0),
      ]),
      repoRoot,
      fullRebuild: true,
      clearBeforeIngest: true,
    });

    // The stale node is gone (the clear DID happen) and the new ones are in.
    expect(db.getNode("stale/leftover")).toBeNull();
    expect(db.counts().nodes).toBe(2);
    expect(db.checkIndexIntegrity().ok).toBe(true);
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* B6 (safety) — the sweep must not delete files hayven didn't write   */
/* ------------------------------------------------------------------ */

describe("B6 (safety): the orphan sweep only deletes what hayven provably wrote", () => {
  it("leaves hand-written markdown alone", async () => {
    const nodesDir = tmp("fixb-own");
    await writeNodeMarkdowns(nodesDir, [gNode("a/one"), gNode("a/orphan")]);
    const notes = join(nodesDir, "MY_NOTES.md");
    writeFileSync(notes, "# My notes\n\nNothing to do with hayven.\n");
    const nested = join(nodesDir, "a", "README.md");
    writeFileSync(nested, "hand written\n");

    const removed = pruneOrphanNodeMarkdowns(nodesDir, ["a/one"]);

    expect(removed).toBe(1); // only the genuine orphan
    expect(existsSync(join(nodesDir, "a", "orphan.md"))).toBe(false);
    expect(existsSync(notes)).toBe(true);
    expect(existsSync(nested)).toBe(true);
    expect(readFileSync(notes, "utf8")).toContain("My notes");
  });

  it("leaves a file whose frontmatter id does not match its own path", async () => {
    // A file carrying our frontmatter but sitting somewhere we'd never write it
    // is not something this writer produced — so we cannot prove ownership.
    const nodesDir = tmp("fixb-own2");
    const impostor = join(nodesDir, "somewhere", "else.md");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(nodesDir, "somewhere"), { recursive: true });
    writeFileSync(impostor, "---\nid: totally/different\nkind: function\n---\n\n# x\n");

    expect(pruneOrphanNodeMarkdowns(nodesDir, [])).toBe(0);
    expect(existsSync(impostor)).toBe(true);
  });

  it("runIngest does NOT sweep unless explicitly permitted", async () => {
    // `nodesDir` is per-PROJECT and shared by every per-branch index, so a
    // full rebuild of ONE branch must not reclaim another branch's markdown.
    const { db, repoRoot } = makeIndex();
    const nodesDir = join(repoRoot, "nodes");
    await writeNodeMarkdowns(nodesDir, [gNode("otherbranch/symbol")]);

    await runIngest({
      db,
      nodesDir,
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0" },
        moduleRec("src/a.ts", "a"),
        doneRec(1, 0),
      ]),
      repoRoot,
      fullRebuild: true,
      // sweepOrphanMarkdown deliberately omitted — the safe default
    });

    expect(existsSync(join(nodesDir, "otherbranch", "symbol.md"))).toBe(true);
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* B1 (unreadable) — a dropped schema must warn, not throw             */
/* ------------------------------------------------------------------ */

describe("an index whose tables were dropped warns instead of throwing", () => {
  it("reports UNREADABLE rather than throwing `no such table: stats`", () => {
    // `hayven reindex` killed between `dropDerived` (which DROPs stats AND
    // nodes) and the follow-on ingest. `evaluateStaleness` used to fall through
    // to `getStat("last_ingest_at")` and throw; `warnIfStale` swallowed it, so
    // the user got no warning at all about an index that answers nothing.
    const { db, repoRoot } = makeIndex();
    const paths = hayvenPathsFor(repoRoot);
    db.handle.exec("DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS stats;");

    const integrity = db.checkIndexIntegrity();
    expect(integrity.reason).toBe("unreadable");

    let verdict!: ReturnType<typeof evaluateStaleness>;
    expect(() => {
      verdict = evaluateStaleness(db, paths, probes(Date.now()));
    }).not.toThrow();
    expect(verdict.stale).toBe(true);
    expect(verdict.broken).toBe("unreadable");
    expect(verdict.message).toContain("UNREADABLE");
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* B7 — SQLite busy_timeout                                            */
/* ------------------------------------------------------------------ */

describe("B7: connections wait for a lock instead of failing at 0 ms", () => {
  it("sets a non-zero busy_timeout on write AND readonly connections", () => {
    const { db, sqlitePath } = makeIndex();
    const w =
      db.handle.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout ?? 0;
    expect(w).toBeGreaterThan(0);

    const ro = new Db(sqlitePath, { readonly: true });
    const r =
      ro.handle.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout ?? 0;
    expect(r).toBeGreaterThan(0);
    ro.close();
    db.close();
  });

  it("honours HAYVEN_BUSY_TIMEOUT_MS", () => {
    const repoRoot = tmp("fixb-busy");
    setEnv("HAYVEN_BUSY_TIMEOUT_MS", "1234");
    const db = new Db(join(repoRoot, "index.sqlite"));
    expect(db.handle.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(
      1234,
    );
    db.close();
  });

  it("a blocked writer WAITS for the timeout rather than throwing immediately", () => {
    const repoRoot = tmp("fixb-busy2");
    const p = join(repoRoot, "index.sqlite");
    const seed = new Db(p);
    seed.migrate();
    seed.close();

    // Holder takes the write lock and keeps it.
    const holder = new Database(p);
    holder.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO stats (key, value) VALUES ('holder', '1')");

    setEnv("HAYVEN_BUSY_TIMEOUT_MS", "400");
    const contender = new Db(p);
    const started = Date.now();
    let threw = false;
    try {
      contender.setStat("contender", "1");
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - started;

    expect(threw).toBe(true); // the holder never lets go, so it does fail...
    // ...but only AFTER waiting. Before the fix this threw after ~0 ms, so any
    // concurrent `hayven remember`/`claim`/`ingest` failed instantly. Allow
    // generous slack for a loaded machine while still excluding "0 ms".
    expect(elapsed).toBeGreaterThanOrEqual(300);

    contender.close();
    holder.exec("ROLLBACK");
    holder.close();
  });
});

/* ------------------------------------------------------------------ */
/* B8 — hard caps on a single ingest run                               */
/* ------------------------------------------------------------------ */

describe("B8: an ingest refuses unbounded scope loudly", () => {
  it("aborts when files_total exceeds the cap, naming the cap and its override", async () => {
    const { db, repoRoot } = makeIndex();
    setEnv("HAYVEN_MAX_INGEST_FILES", "3");

    const promise = runIngest({
      db,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun([
        { type: "start", files_total: 500_000, version: "0.0.0" },
        moduleRec("src/a.ts", "a"),
        doneRec(1, 0),
      ]),
      repoRoot,
    });

    await expect(promise).rejects.toThrow(/HAYVEN_MAX_INGEST_FILES/);
    // The refusal happens on the `start` record, before anything is written, so
    // the index must be left EXACTLY as found — including UNFLAGGED. Flagging a
    // untouched index would still mean "destroyed for being large" to every
    // reader, and would wedge the next run onto the full path forever.
    expect(db.checkIndexIntegrity().ok).toBe(true);
    expect(db.ingestInProgressSince()).toBeNull();
    db.close();
  });

  it("aborts when the node count exceeds the cap", async () => {
    const { db, repoRoot } = makeIndex();
    setEnv("HAYVEN_MAX_INGEST_NODES", "2");

    await expect(
      runIngest({
        db,
        nodesDir: join(repoRoot, "nodes"),
        run: fakeRun([
          { type: "start", files_total: 1, version: "0.0.0" },
          moduleRec("src/a.ts", "a"),
          nodeRec("src/a.ts", "one"),
          nodeRec("src/a.ts", "two"),
          nodeRec("src/a.ts", "three"),
          doneRec(4, 0),
        ]),
        repoRoot,
      }),
    ).rejects.toThrow(/HAYVEN_MAX_INGEST_NODES/);
    db.close();
  });

  it("does not fire below the cap", async () => {
    const { db, repoRoot } = makeIndex();
    setEnv("HAYVEN_MAX_INGEST_FILES", "10");
    setEnv("HAYVEN_MAX_INGEST_NODES", "10");

    const result = await runIngest({
      db,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun([
        { type: "start", files_total: 2, version: "0.0.0" },
        moduleRec("src/a.ts", "a"),
        nodeRec("src/a.ts", "one"),
        doneRec(2, 0),
      ]),
      repoRoot,
      fullRebuild: true,
    });

    expect(result.nodes).toBe(2);
    expect(db.checkIndexIntegrity().ok).toBe(true);
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* integration: `migrate()` may now REFUSE a too-new index             */
/* ------------------------------------------------------------------ */

describe("cli ingest handles a schema-too-new index cleanly", () => {
  it("returns 1 with a readable message instead of stack-tracing", async () => {
    const repoRoot = tmp("fixb-toonew");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(repoRoot, ".hayven"), { recursive: true });
    // An index written by a FUTURE build: a `user_version` this build cannot
    // understand. `migrate()` refuses it rather than migrating DOWN and
    // discarding the newer schema's tables.
    const future = new Database(join(repoRoot, ".hayven", "index.sqlite"));
    future.exec("PRAGMA user_version = 9999");
    future.close();

    const errs: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      errs.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      const { runIngest: cliIngest } = await import("../src/cli/ingest.ts");
      code = await cliIngest({ positionals: [], flags: { cwd: repoRoot } });
    } finally {
      process.stderr.write = realWrite;
    }

    expect(code).toBe(1);
    const out = errs.join("");
    // It must be the SCHEMA guard that spoke — not an earlier guard short-
    // circuiting before `migrate()` is ever reached (which would make this test
    // pass for the wrong reason), and not an unhandled throw escaping the
    // command.
    expect(out).toContain("ingest aborted");
    expect(out).toContain("NEWER hayven (schema v9999)");
  });
});

/* ------------------------------------------------------------------ */
/* sanity: the sandbox never touched the developer's real state        */
/* ------------------------------------------------------------------ */

describe("sandbox tripwire", () => {
  it("wrote only under the OS temp dir", () => {
    // Every path this file creates comes from `mkdtempSync(tmpdir(), ...)`.
    // A regression that reintroduced a $HOME-relative default would show up as
    // a dir outside tmpdir() in this list.
    for (const d of dirs) {
      expect(d.startsWith(tmpdir()) || d.startsWith("/private" + tmpdir())).toBe(true);
    }
    // And nothing here ever writes a registry file.
    expect(existsSync(join(tmpdir(), "projects.json"))).toBe(false);
    writeFileSync(join(tmp("fixb-tripwire"), "ok"), "ok");
  });

  it("has $HAYVEN_HOME pointed at a sandbox, never the real home", () => {
    // The tripwire from registry.test.ts: if global state were ever resolved
    // against the developer's real `~/.hayven`, this would catch it.
    const home = process.env["HAYVEN_HOME"];
    expect(home).toBe(HAYVEN_HOME_SANDBOX);
    expect(home?.startsWith(tmpdir()) || home?.startsWith("/private" + tmpdir())).toBe(true);
    expect(existsSync(join(HAYVEN_HOME_SANDBOX, "projects.json"))).toBe(false);
  });
});
