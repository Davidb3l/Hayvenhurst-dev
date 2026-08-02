/**
 * LANE R / R2 + R5 + R6 + R7 — ingest-side hygiene the earlier rounds left open.
 *
 * R2  TTL'd fleet memory never left disk: `pruneExpired` had zero callers, so
 *     expired notes were hidden at READ time and kept forever — and this round's
 *     reindex fix now PRESERVES `fleet_memory`, so nothing reclaimed it at all.
 * R5  `scopeForFile` elides the first `src/` segment, so `a/src/b.ts` and
 *     `a/b.ts` derive the SAME id and one file silently overwrites the other in
 *     the `nodes` primary key. Fixing the scheme is a migration (see the final
 *     report); making the collision LOUD is not, and is what these tests pin.
 * R7  The hard ingest caps must fail loudly AND leave a CONSISTENT index —
 *     including when the CALLER cleared the graph before handing us the run.
 * R6  `pruneEmptyDirs` was the one containment predicate in this branch written
 *     without a separator boundary, so a directory merely sharing a name PREFIX
 *     with `nodesDir` was inside it as far as the check was concerned.
 *
 * Hermetic: `mkdtemp` per test, a scripted `ParseRun` in place of the native
 * binary, `$HAYVEN_HOME` sandboxed (never `$HOME`).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordMemory } from "../src/db/fleet_memory.ts";
import { Db } from "../src/db/queries.ts";
import { runIngest } from "../src/graph/ingest.ts";
import { removeNodeMarkdowns } from "../src/graph/nodeWriter.ts";
import type { NativeRecord } from "../src/native/protocol.ts";
import type { ParseRun } from "../src/native/process.ts";
import type { Logger } from "../src/util/log.ts";

const dirs: string[] = [];
const envRestore: Array<[string, string | undefined]> = [];

const HAYVEN_HOME_SANDBOX = mkdtempSync(join(tmpdir(), "hayven-gapr-ing-home-"));
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

function makeIndex(): { db: Db; repoRoot: string } {
  const repoRoot = tmp("gapr-ing");
  const db = new Db(join(repoRoot, "index.sqlite"));
  db.migrate();
  return { db, repoRoot };
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

interface Captured {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields: Record<string, unknown>;
}

function capturingLogger(sink: Captured[]): Logger {
  const at =
    (level: Captured["level"]) =>
    (msg: string, fields: Record<string, unknown> = {}): void => {
      sink.push({ level, msg, fields });
    };
  const logger: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: () => logger,
  };
  return logger;
}

function memoryCount(db: Db): number {
  return db.handle.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fleet_memory").get()?.n ?? 0;
}

/* ------------------------------------------------------------------ */
/* R2 — expired fleet memory is actually reclaimed                     */
/* ------------------------------------------------------------------ */

describe("R2: a successful ingest reclaims TTL'd fleet memory", () => {
  it("deletes ONLY the expired rows, leaving live and permanent notes alone", async () => {
    const { db, repoRoot } = makeIndex();
    const hourAgo = Date.now() - 60 * 60 * 1000;
    recordMemory(db, { kind: "note", note: "expired", ttl: 60, now: hourAgo, id: "m-expired" });
    recordMemory(db, { kind: "note", note: "still live", ttl: 86_400, now: hourAgo, id: "m-live" });
    recordMemory(db, { kind: "decision", note: "forever", now: hourAgo, id: "m-perm" });
    expect(memoryCount(db)).toBe(3);

    await runIngest({
      db,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0" },
        moduleRec("src/a.ts", "a"),
        { type: "done", files_done: 1, nodes: 1, edges: 0, elapsed_ms: 1 },
      ]),
      repoRoot,
      fullRebuild: true,
    });

    expect(memoryCount(db)).toBe(2);
    const ids = db.handle
      .query<{ id: string }, []>("SELECT id FROM fleet_memory ORDER BY id")
      .all()
      .map((r) => r.id);
    // The MECHANISM: the TTL predicate, not "some rows went away". A permanent
    // note (`ttl IS NULL`) must be untouchable, or this becomes the destructive
    // surprise it was wired up specifically not to be.
    expect(ids).toEqual(["m-live", "m-perm"]);
    db.close();
  });

  it("is RATE-LIMITED, so the watcher's per-save ingests don't rescan the table", async () => {
    const { db, repoRoot } = makeIndex();
    const hourAgo = Date.now() - 60 * 60 * 1000;
    recordMemory(db, { kind: "note", note: "first", ttl: 60, now: hourAgo, id: "m-1" });

    const ingest = async (): Promise<void> => {
      await runIngest({
        db,
        nodesDir: join(repoRoot, "nodes"),
        run: fakeRun([
          { type: "start", files_total: 1, version: "0.0.0" },
          moduleRec("src/a.ts", "a"),
          { type: "done", files_done: 1, nodes: 1, edges: 0, elapsed_ms: 1 },
        ]),
        repoRoot,
      });
    };

    await ingest();
    expect(memoryCount(db)).toBe(0); // first run pruned
    const prunedAt = db.getStat("fleet_memory_pruned_at");
    expect(prunedAt).not.toBeNull();

    // A second expired note, and a second ingest immediately afterwards: the
    // hour-long window must suppress the prune entirely.
    recordMemory(db, { kind: "note", note: "second", ttl: 60, now: hourAgo, id: "m-2" });
    await ingest();
    expect(memoryCount(db)).toBe(1);
    expect(db.getStat("fleet_memory_pruned_at")).toBe(prunedAt); // window not reset

    // A stamp in the FUTURE (clock stepped back, or an index copied from a
    // machine running ahead) must not suppress the prune FOREVER — the elapsed
    // time would be negative and never clear the window again.
    db.setStat("fleet_memory_pruned_at", String(Date.now() + 365 * 24 * 60 * 60 * 1000));
    await ingest();
    expect(memoryCount(db)).toBe(0);
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* R5 — colliding entity ids are REPORTED, never silent                */
/* ------------------------------------------------------------------ */

describe("R5: two files deriving one module id is loud", () => {
  it("reports the collision, names both files, and records it on the index", async () => {
    const { db, repoRoot } = makeIndex();
    const logs: Captured[] = [];

    // `scopeForFile` elides the first `src/` segment, so both of these derive
    // the module id `a/b`. Ids are the `nodes` PRIMARY KEY.
    const result = await runIngest({
      db,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun([
        { type: "start", files_total: 2, version: "0.0.0" },
        moduleRec("a/src/b.ts", "b"),
        moduleRec("a/b.ts", "b"),
        { type: "done", files_done: 2, nodes: 2, edges: 0, elapsed_ms: 1 },
      ]),
      repoRoot,
      logger: capturingLogger(logs),
      fullRebuild: true,
    });

    // The data loss is real and pre-existing: two parsed files, ONE row.
    expect(db.counts().nodes).toBe(1);
    // ...but it is no longer SILENT.
    expect(result.idCollisions).toBe(1);
    expect(db.getStat("last_ingest_id_collisions")).toBe("1");

    const warn = logs.find((l) => l.level === "warn" && l.msg.includes("COLLISION"));
    expect(warn).toBeDefined();
    expect(warn!.fields["id"]).toBe("a/b");
    // Both sides must be named — one file path alone does not tell you what
    // overwrote what.
    expect([warn!.fields["file"], warn!.fields["collidesWith"]].sort()).toEqual([
      "a/b.ts",
      "a/src/b.ts",
    ]);
    expect(logs.some((l) => l.level === "error" && l.msg.includes("COLLISION"))).toBe(true);
    db.close();
  });

  it("stays quiet (0 collisions) when ids are unique", async () => {
    const { db, repoRoot } = makeIndex();
    const logs: Captured[] = [];
    const result = await runIngest({
      db,
      nodesDir: join(repoRoot, "nodes"),
      run: fakeRun([
        { type: "start", files_total: 2, version: "0.0.0" },
        moduleRec("a/src/b.ts", "b"),
        moduleRec("a/src/c.ts", "c"),
        { type: "done", files_done: 2, nodes: 2, edges: 0, elapsed_ms: 1 },
      ]),
      repoRoot,
      logger: capturingLogger(logs),
      fullRebuild: true,
    });
    expect(result.idCollisions).toBe(0);
    expect(db.counts().nodes).toBe(2);
    expect(logs.some((l) => l.msg.includes("COLLISION"))).toBe(false);
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* R7 — the caps fail loudly and leave a CONSISTENT index              */
/* ------------------------------------------------------------------ */

describe("R7: a refused ingest leaves a consistent index", () => {
  it("keeps the index FLAGGED when the CALLER cleared the graph before the refusal", async () => {
    // `cli/daemon.ts` clears the graph itself and then calls `runIngest`. The
    // refusal path retracted the in-progress marker whenever IT had written
    // nothing — but `endIngest()` retracts the HANDLE's token, which the
    // caller's `clearGraph()` had stamped. So a scope refusal un-flagged an
    // index the caller had just EMPTIED, and (with no prior watermark to arm
    // the second detector) a zero-node graph read `{ok:true}`.
    const { db, repoRoot } = makeIndex();
    setEnv("HAYVEN_MAX_INGEST_FILES", "1");

    db.clearGraph(); // the caller's destructive step, on this same handle
    expect(db.counts().nodes).toBe(0);
    // The watermark detector is deliberately NOT armed here, so the assertion
    // below can only pass via the in-progress marker.
    expect(db.getStat("last_ingest_nodes")).toBeNull();

    await expect(
      runIngest({
        db,
        nodesDir: join(repoRoot, "nodes"),
        run: fakeRun([{ type: "start", files_total: 500, version: "0.0.0" }]),
        repoRoot,
      }),
    ).rejects.toThrow(/HAYVEN_MAX_INGEST_FILES/);

    const integrity = db.checkIndexIntegrity();
    expect(integrity.ok).toBe(false);
    expect(integrity.reason).toBe("ingest-interrupted");
    expect(db.ingestInProgressSince()).not.toBeNull();
    db.close();
  });

  it("enforces the EDGE cap, and a refusal that wrote nothing leaves the index untouched", async () => {
    const { db, repoRoot } = makeIndex();
    setEnv("HAYVEN_MAX_INGEST_EDGES", "1");

    await expect(
      runIngest({
        db,
        nodesDir: join(repoRoot, "nodes"),
        run: fakeRun([
          { type: "start", files_total: 1, version: "0.0.0" },
          moduleRec("src/a.ts", "a"),
          callRec("src/a.ts", "a", "x", 1),
          callRec("src/a.ts", "a", "y", 2),
          callRec("src/a.ts", "a", "z", 3),
          { type: "done", files_done: 1, nodes: 1, edges: 3, elapsed_ms: 1 },
        ]),
        repoRoot,
      }),
    ).rejects.toThrow(/HAYVEN_MAX_INGEST_EDGES/);

    // Nothing flushed (the node buffer holds 1000 before it writes), so the
    // index must be exactly as it was: not partial, and NOT flagged — a good
    // index reported broken purely for being large is what wedged the next run
    // onto the full path forever.
    expect(db.counts().nodes).toBe(0);
    expect(db.counts().edges).toBe(0);
    expect(db.checkIndexIntegrity().ok).toBe(true);
    expect(db.ingestInProgressSince()).toBeNull();
    // A refused run must never claim a successful ingest happened.
    expect(db.getStat("last_ingest_at")).toBeNull();
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* R6 — containment needs a separator boundary                         */
/* ------------------------------------------------------------------ */

describe("R6: markdown reclaim never escapes nodesDir via a shared name prefix", () => {
  it("touches neither the FILE nor the DIRECTORY of an id that resolves outside nodesDir", () => {
    const root = tmp("gapr-prune");
    const nodesDir = join(root, "nodes");
    const sibling = join(root, "nodesX"); // shares the `nodes` prefix, is NOT inside it
    mkdirSync(nodesDir, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const outsideFile = join(sibling, "thing.md");
    writeFileSync(outsideFile, "x", "utf8");

    // Node ids are path-derived and `nodeMarkdownPath` preserves `.`, so `..`
    // survives sanitization and `join` resolves this id OUTSIDE nodesDir. Two
    // separate containment holes met here: the unlink had no boundary check at
    // all, and `pruneEmptyDirs` used a bare `startsWith(root)` that read
    // `…/nodesX` as inside `…/nodes` — the `/foo` matching `/foobar` shape.
    const removed = removeNodeMarkdowns(nodesDir, ["../nodesX/thing"]);
    expect(removed).toBe(0); // nothing outside nodesDir is ours to delete
    expect(existsSync(outsideFile)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
    expect(existsSync(nodesDir)).toBe(true);
  });

  it("still prunes a genuinely-empty directory INSIDE nodesDir", () => {
    const root = tmp("gapr-prune-in");
    const nodesDir = join(root, "nodes");
    const inner = join(nodesDir, "pkg", "sub");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "thing.md"), "x", "utf8");

    expect(removeNodeMarkdowns(nodesDir, ["pkg/sub/thing"])).toBe(1);
    expect(existsSync(inner)).toBe(false); // emptied → reclaimed
    expect(existsSync(nodesDir)).toBe(true); // never the root itself
  });
});
