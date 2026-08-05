/**
 * LANE C regression tests — the streaming ingest (KNOWN_ISSUES #2).
 *
 * `runIngest` used to hold the whole repo's `GraphNode[]` and `RawEdge[]` in
 * heap for the entire run; both now spill to a throwaway on-disk store and are
 * replayed in pages. The rework is deliberately BEHAVIOUR-PRESERVING, so the
 * risk it carries is not "a visibly different result" — it is SILENT: a paging
 * bug that drops the tail of the graph, a spill that loses an optional field
 * the resolver depends on, or a resolve that starts before the node set is
 * complete and therefore invents a FALSE EDGE. Every test here targets one of
 * those, and each was mutation-tested by breaking that exact mechanism in
 * `graph/ingest.ts` / `db/queries.ts` and confirming a red run.
 *
 * Hermetic: every index and nodes dir is its own `mkdtemp`, the native binary
 * is a scripted `ParseRun`, and `$HAYVEN_HOME` is sandboxed (never `$HOME` —
 * Bun resolves `os.homedir()` once per process, so mutating `$HOME` at runtime
 * does nothing and the test would rewrite the developer's real registry).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IngestSpill, Db } from "../src/db/queries.ts";
import { runIngest } from "../src/graph/ingest.ts";
import type { NativeRecord } from "../src/native/protocol.ts";
import type { ParseRun } from "../src/native/process.ts";

const HAYVEN_HOME_SANDBOX = mkdtempSync(join(tmpdir(), "hayven-lanec-home-"));
process.env["HAYVEN_HOME"] = HAYVEN_HOME_SANDBOX;

const dirs: string[] = [];
const envRestore: Array<[string, string | undefined]> = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of envRestore.splice(0)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
function setEnv(k: string, v: string): void {
  envRestore.push([k, process.env[k]]);
  process.env[k] = v;
}
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `hayven-${prefix}-`));
  dirs.push(d);
  return d;
}
function makeIndex(): { db: Db; repoRoot: string; nodesDir: string } {
  const repoRoot = tmp("lanec");
  const db = new Db(join(repoRoot, "index.sqlite"));
  db.migrate();
  return { db, repoRoot, nodesDir: join(repoRoot, "nodes") };
}
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
function fnRec(file: string, name: string): NativeRecord {
  return {
    type: "node",
    file,
    name,
    qualified_name: name,
    kind: "function",
    language: "typescript",
    range: [1, 5],
    ast_hash: `fn-${file}-${name}`,
  };
}
function doneRec(nodes: number, edges: number): NativeRecord {
  return { type: "done", files_done: 1, nodes, edges, elapsed_ms: 1 };
}

/** Node/edge batches flush every 1000 records, so anything that must cross a
 *  page boundary needs more than that. */
const OVER_ONE_PAGE = 1400;

describe("LANE C: node records stream to disk, and NOTHING resolves until they are all in", () => {
  it("a callee defined in a LATER batch than the caller still goes AMBIGUOUS, not a false edge", async () => {
    // THE FALSE-EDGE GUARD, and the reason the spill exists at all rather than
    // a resolve-as-you-go loop. `dup` is defined in TWO files. Judged over the
    // complete node set it is ambiguous and the call must stay `?:dup`. Judged
    // one batch at a time it looks UNIQUE in the batch that holds the first
    // definition, and the edge resolves to whichever file happened to be
    // flushed first — a fabricated call edge, silently, with no failure
    // anywhere. The two definitions are deliberately >1000 records apart so
    // they land in different node batches and different spill pages.
    const { db, repoRoot, nodesDir } = makeIndex();
    const records: NativeRecord[] = [
      { type: "start", files_total: 3, version: "0.0.0" },
      moduleRec("src/first.ts", "first"),
      fnRec("src/first.ts", "dup"),
    ];
    // Filler in its own file, enough to push the second `dup` past a page.
    records.push(moduleRec("src/filler.ts", "filler"));
    for (let i = 0; i < OVER_ONE_PAGE; i++) {
      records.push(fnRec("src/filler.ts", `filler_${i}`));
    }
    records.push(moduleRec("src/second.ts", "second"));
    records.push(fnRec("src/second.ts", "dup"));
    // The caller lives in a THIRD file, so no same-file lookup can rescue it.
    records.push(moduleRec("src/caller.ts", "caller"));
    records.push(fnRec("src/caller.ts", "callIt"));
    records.push({
      type: "edge",
      src_file: "src/caller.ts",
      src_name: "callIt",
      dst_name: "dup",
      kind: "static_call",
    } as NativeRecord);
    records.push(doneRec(OVER_ONE_PAGE + 7, 1));

    await runIngest({ db, nodesDir, run: fakeRun(records), repoRoot, fullRebuild: true });

    // Both definitions survive as distinct nodes...
    expect(db.getNode("src/first/dup")).not.toBeNull();
    expect(db.getNode("src/second/dup")).not.toBeNull();
    // ...and the call names NEITHER of them. Assert the exact dst, not merely
    // "some edge exists": the bug this pins produces a perfectly well-formed
    // edge pointing at the wrong entity.
    const outgoing = db.outgoing("src/caller/callIt").map((e) => e.dst);
    expect(outgoing).toEqual(["?:dup"]);
    expect(outgoing).not.toContain("src/first/dup");
    expect(outgoing).not.toContain("src/second/dup");
    db.close();
  });

  it("writes markdown for every node, including ones past the first replay page", async () => {
    // A paging bug (a replay that stops after one page, or an `after` cursor
    // that never advances) loses the TAIL of the repo's markdown silently —
    // the ingest still reports success and the SQLite rows are all there.
    const { db, repoRoot, nodesDir } = makeIndex();
    const records: NativeRecord[] = [
      { type: "start", files_total: 1, version: "0.0.0" },
      moduleRec("src/a.ts", "a"),
    ];
    for (let i = 0; i < OVER_ONE_PAGE; i++) records.push(fnRec("src/a.ts", `fn_${i}`));
    records.push(doneRec(OVER_ONE_PAGE + 1, 0));

    await runIngest({ db, nodesDir, run: fakeRun(records), repoRoot, fullRebuild: true });

    // First, last, and one just past the 1000-record page boundary.
    expect(existsSync(join(nodesDir, "src", "a", "fn_0.md"))).toBe(true);
    expect(existsSync(join(nodesDir, "src", "a", "fn_1000.md"))).toBe(true);
    expect(existsSync(join(nodesDir, "src", "a", `fn_${OVER_ONE_PAGE - 1}.md`))).toBe(true);
    expect(readdirSync(join(nodesDir, "src", "a")).length).toBe(OVER_ONE_PAGE);
    db.close();
  });
});

describe("LANE C: the raw-edge spill is a LOSSLESS round-trip", () => {
  it("preserves the optional fields Tier-2 resolution and call sites depend on", async () => {
    // The resolver's accuracy rests on fields that are OPTIONAL and were added
    // additively: `local` (import witness), `import_aliases`, `receiver` /
    // `receiver_chain`, and `line`/`col`. A spill that writes a hand-listed
    // column set drops whichever field the next contributor forgets, and the
    // symptom is not an error — it is fewer, or wrong, edges. This exercises
    // all of them through one run.
    const { db, repoRoot, nodesDir } = makeIndex();
    const records: NativeRecord[] = [
      { type: "start", files_total: 2, version: "0.0.0" },
      moduleRec("src/lib.ts", "lib"),
      fnRec("src/lib.ts", "checkAccess"),
      moduleRec("src/app.ts", "app"),
      fnRec("src/app.ts", "run"),
      // `import { checkAccess as ca } from "./lib"` — the ALIAS pair is what
      // lets `ca()` resolve to `src/lib/checkAccess` rather than a
      // non-existent `src/lib/ca`.
      {
        type: "edge",
        src_file: "src/app.ts",
        src_name: "app",
        dst_name: "./lib",
        kind: "import",
        local: ["ca"],
        import_aliases: [{ local: "ca", imported: "checkAccess" }],
      } as unknown as NativeRecord,
      // The aliased bare call, carrying its 1-based call-site coordinates.
      {
        type: "edge",
        src_file: "src/app.ts",
        src_name: "run",
        dst_name: "ca",
        kind: "static_call",
        line: 42,
        col: 7,
      } as unknown as NativeRecord,
      doneRec(4, 2),
    ];

    await runIngest({ db, nodesDir, run: fakeRun(records), repoRoot, fullRebuild: true });

    // The import witness + alias table survived: the call resolved to the
    // EXPORTED name under the imported module.
    expect(db.outgoing("src/app/run").map((e) => e.dst)).toEqual(["src/lib/checkAccess"]);
    // ...and `line`/`col` survived with it, to the exact coordinate.
    const sites = db.callSitesOf("src/lib/checkAccess");
    expect(sites.length).toBe(1);
    expect([sites[0]?.file, sites[0]?.line, sites[0]?.col]).toEqual(["src/app.ts", 42, 7]);
    db.close();
  });

  it("replays raw edges in insertion order across pages, summing every occurrence's weight", async () => {
    // Occurrences of one (src, dst, kind) are folded into a single row with the
    // weights summed. A replay that skips a page, or double-yields one, changes
    // that total — and a wrong `weight` silently corrupts every weight-ordered
    // ranking rather than failing.
    const { db, repoRoot, nodesDir } = makeIndex();
    const records: NativeRecord[] = [
      { type: "start", files_total: 1, version: "0.0.0" },
      moduleRec("src/a.ts", "a"),
      fnRec("src/a.ts", "one"),
      fnRec("src/a.ts", "two"),
    ];
    for (let i = 0; i < OVER_ONE_PAGE; i++) {
      records.push({
        type: "edge",
        src_file: "src/a.ts",
        src_name: "one",
        dst_name: "two",
        kind: "static_call",
        line: i + 1,
        col: 1,
      } as NativeRecord);
    }
    records.push(doneRec(3, OVER_ONE_PAGE));

    await runIngest({ db, nodesDir, run: fakeRun(records), repoRoot, fullRebuild: true });

    const edges = db.outgoing("src/a/one");
    expect(edges.length).toBe(1);
    expect(edges[0]?.weight).toBe(OVER_ONE_PAGE);
    // One call site per occurrence, every line distinct and none lost.
    const sites = db.callSitesOf("src/a/two");
    expect(sites.length).toBe(OVER_ONE_PAGE);
    expect(new Set(sites.map((s) => s.line)).size).toBe(OVER_ONE_PAGE);
    db.close();
  });
});

describe("LANE C: call sites are deleted BEFORE the run streams its own back in", () => {
  it("an incremental re-ingest keeps the sites it just derived", async () => {
    // Sites now stream into the table DURING resolution instead of being
    // collected into one array and inserted afterwards, so the per-file DELETE
    // had to move ahead of the resolve loop. If it stays behind it deletes
    // exactly the rows this run just wrote — `refs --sites` then reports
    // nothing for the file you just saved, and the ingest still says it
    // succeeded.
    const { db, repoRoot, nodesDir } = makeIndex();
    // A pre-existing site in ANOTHER file, which must survive untouched.
    db.insertCallSites([
      { dst: "src/b/target", src: "src/b/caller", kind: "static_call", file: "src/b.ts", line: 9, col: 1 },
    ]);

    const records: NativeRecord[] = [
      { type: "start", files_total: 1, version: "0.0.0" },
      moduleRec("src/a.ts", "a"),
      fnRec("src/a.ts", "one"),
      fnRec("src/a.ts", "two"),
      {
        type: "edge",
        src_file: "src/a.ts",
        src_name: "one",
        dst_name: "two",
        kind: "static_call",
        line: 12,
        col: 3,
      } as NativeRecord,
      doneRec(3, 1),
    ];
    // Scoped run (no `fullRebuild`) — the per-file delete path.
    await runIngest({ db, nodesDir, run: fakeRun(records), repoRoot });

    const own = db.callSitesOf("src/a/two");
    expect(own.length).toBe(1);
    expect([own[0]?.file, own[0]?.line, own[0]?.col]).toEqual(["src/a.ts", 12, 3]);
    // The other file's site is still there.
    expect(db.callSitesOf("src/b/target").length).toBe(1);
    db.close();
  });
});

describe("LANE C: the spill is a throwaway and never outlives the run", () => {
  function spillFiles(): string[] {
    return readdirSync(tmpdir()).filter((f) => f.startsWith("hayven-spill-"));
  }

  it("removes its temp file after a SUCCESSFUL ingest", async () => {
    const before = new Set(spillFiles());
    const { db, repoRoot, nodesDir } = makeIndex();
    await runIngest({
      db,
      nodesDir,
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0" },
        moduleRec("src/a.ts", "a"),
        fnRec("src/a.ts", "one"),
        doneRec(2, 0),
      ]),
      repoRoot,
      fullRebuild: true,
    });
    expect(spillFiles().filter((f) => !before.has(f))).toEqual([]);
    db.close();
  });

  it("removes its temp file after a hard-cap ABORT too", async () => {
    // The abort path throws from the middle of the drain. A spill left behind
    // there is the worst case: the run that refuses a home directory is exactly
    // the one that would have written the biggest overflow file.
    setEnv("HAYVEN_MAX_INGEST_NODES", "1");
    const before = new Set(spillFiles());
    const { db, repoRoot, nodesDir } = makeIndex();
    await expect(
      runIngest({
        db,
        nodesDir,
        run: fakeRun([
          { type: "start", files_total: 1, version: "0.0.0" },
          moduleRec("src/a.ts", "a"),
          fnRec("src/a.ts", "one"),
          fnRec("src/a.ts", "two"),
          doneRec(3, 0),
        ]),
        repoRoot,
        fullRebuild: true,
      }),
      // The refusal must still name the cap AND its override.
    ).rejects.toThrow(/HAYVEN_MAX_INGEST_NODES/);
    expect(spillFiles().filter((f) => !before.has(f))).toEqual([]);
    db.close();
  });
});

describe("LANE C: IngestSpill itself", () => {
  it("replays rows in insertion order, in pages, and can filter edges by kind", () => {
    const spill = IngestSpill.open("unit");
    try {
      // Two appends, so the seq counter has to survive across transactions.
      spill.appendEdges([
        { kind: "import", n: 1 },
        { kind: "static_call", n: 2 },
      ] as unknown as Array<{ kind: string }>);
      spill.appendEdges([
        { kind: "import", n: 3 },
        { kind: "static_call", n: 4 },
      ] as unknown as Array<{ kind: string }>);
      expect(spill.counts.edges).toBe(4);

      const all: number[] = [];
      for (const page of spill.edges<{ n: number }>(1)) all.push(...page.map((r) => r.n));
      expect(all).toEqual([1, 2, 3, 4]);

      const imports: number[] = [];
      for (const page of spill.edges<{ n: number }>(1, "import")) {
        imports.push(...page.map((r) => r.n));
      }
      expect(imports).toEqual([1, 3]);
    } finally {
      spill.destroy();
    }
  });

  it("round-trips nested optional shapes without dropping a field", () => {
    // The whole reason rows are stored as a JSON round-trip rather than a
    // column list: nothing here is enumerated anywhere, so a field added later
    // cannot go missing.
    const spill = IngestSpill.open("unit");
    try {
      const row = {
        kind: "static_call",
        receiver_chain: ["api", "client"],
        import_aliases: [{ local: "ca", imported: "checkAccess" }],
        local: ["a", "b"],
        line: 3,
        col: 9,
      };
      spill.appendEdges([row]);
      const [page] = [...spill.edges<typeof row>(10)];
      expect(page?.[0]).toEqual(row);
    } finally {
      spill.destroy();
    }
  });

  it("destroy() is idempotent and unlinks the file", () => {
    const spill = IngestSpill.open("unit");
    spill.appendNodes([{ a: 1 }]);
    expect(existsSync(spill.path)).toBe(true);
    spill.destroy();
    expect(existsSync(spill.path)).toBe(false);
    spill.destroy(); // must not throw
  });
});
