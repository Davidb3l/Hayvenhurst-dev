import { describe, expect, it, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/db/queries.ts";
import { readGitHead, reresolveAllEdges, resolveEdges, runIngest } from "../src/graph/ingest.ts";
import type { GraphNode, RawEdge } from "../src/graph/types.ts";
import type { NativeRecord } from "../src/native/protocol.ts";
import type { ParseRun } from "../src/native/process.ts";

function fakeRun(records: NativeRecord[]): ParseRun {
  async function* iter(): AsyncIterable<NativeRecord> {
    for (const r of records) yield r;
  }
  return {
    records: iter(),
    wait: async () => 0,
    kill: async () => undefined,
    recentStderr: () => [],
  };
}

describe("resolveEdges", () => {
  const nodes: GraphNode[] = [
    {
      id: "auth/loginHandler",
      name: "loginHandler",
      qualified_name: "loginHandler",
      kind: "function",
      language: "typescript",
      file: "src/auth/login.ts",
      range: [1, 10],
      ast_hash: "x",
      last_seen: 0,
      logical_clock: 0,
    },
    {
      id: "auth/validate_session",
      name: "validate_session",
      qualified_name: "validate_session",
      kind: "function",
      language: "typescript",
      file: "src/auth/login.ts",
      range: [11, 20],
      ast_hash: "y",
      last_seen: 0,
      logical_clock: 0,
    },
  ];

  it("resolves same-file dst_name lookups", () => {
    const raw: RawEdge[] = [
      { src_file: "src/auth/login.ts", src_name: "loginHandler", dst_name: "validate_session", kind: "static_call" },
    ];
    const { resolved, unresolved } = resolveEdges(nodes, raw);
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.dst).toBe("auth/validate_session");
    expect(unresolved.length).toBe(0);
  });

  it("marks unknown dst_names as unresolved", () => {
    const raw: RawEdge[] = [
      { src_file: "src/auth/login.ts", src_name: "loginHandler", dst_name: "mystery", kind: "static_call" },
    ];
    const { resolved, unresolved } = resolveEdges(nodes, raw);
    expect(resolved.length).toBe(0);
    expect(unresolved[0]?.dst).toBe("?:mystery");
  });

  it("treats an AMBIGUOUS qualified-name dst as unresolved (not a bogus 'ambiguous' id)", () => {
    // Two distinct entities share qualified_name `helper` across sibling files
    // (and across files so the same-file lookup can't pin it). A cross-file
    // edge to `helper` must NOT resolve to the literal sentinel — it must fall
    // through to `?:helper`.
    const ambiguousNodes: GraphNode[] = [
      {
        id: "a/one/helper", name: "helper", qualified_name: "helper", kind: "function",
        language: "ts", file: "src/a/one.ts", range: [1, 2], ast_hash: "h1",
        last_seen: 0, logical_clock: 0,
      },
      {
        id: "a/two/helper", name: "helper", qualified_name: "helper", kind: "function",
        language: "ts", file: "src/a/two.ts", range: [1, 2], ast_hash: "h2",
        last_seen: 0, logical_clock: 0,
      },
      {
        id: "a/caller/run", name: "run", qualified_name: "run", kind: "function",
        language: "ts", file: "src/a/caller.ts", range: [1, 2], ast_hash: "h3",
        last_seen: 0, logical_clock: 0,
      },
    ];
    const raw: RawEdge[] = [
      { src_file: "src/a/caller.ts", src_name: "run", dst_name: "helper", kind: "static_call" },
    ];
    const { resolved, unresolved } = resolveEdges(ambiguousNodes, raw);
    expect(resolved.length).toBe(0);
    expect(unresolved.length).toBe(1);
    expect(unresolved[0]?.dst).toBe("?:helper");
    // And under no circumstances a literal-sentinel dst.
    expect(resolved.some((e) => e.dst === "ambiguous" || e.dst.includes("ambiguous"))).toBe(false);
  });

  it("treats an AMBIGUOUS bare-name dst as unresolved when qualified is unique-miss", () => {
    // dst matches by `name` across two distinct ids → ambiguous-by-name. No
    // qualified-name match (different qn), no same-file. Must be `?:`.
    const ambiguousNodes: GraphNode[] = [
      {
        id: "a/one/Foo.helper", name: "helper", qualified_name: "Foo.helper", kind: "method",
        language: "ts", file: "src/a/one.ts", range: [1, 2], ast_hash: "h1",
        last_seen: 0, logical_clock: 0,
      },
      {
        id: "a/two/Bar.helper", name: "helper", qualified_name: "Bar.helper", kind: "method",
        language: "ts", file: "src/a/two.ts", range: [1, 2], ast_hash: "h2",
        last_seen: 0, logical_clock: 0,
      },
      {
        id: "a/caller/run", name: "run", qualified_name: "run", kind: "function",
        language: "ts", file: "src/a/caller.ts", range: [1, 2], ast_hash: "h3",
        last_seen: 0, logical_clock: 0,
      },
    ];
    const raw: RawEdge[] = [
      { src_file: "src/a/caller.ts", src_name: "run", dst_name: "helper", kind: "static_call" },
    ];
    const { resolved, unresolved } = resolveEdges(ambiguousNodes, raw);
    expect(resolved.length).toBe(0);
    expect(unresolved[0]?.dst).toBe("?:helper");
  });

  it("a module node does NOT shadow a same-named callable into AMBIGUOUS (sympify-in-sympify.py)", () => {
    // The idScheme collision case: a function named after its own file. The
    // module node (`sympify`, kind:module, qn:sympify) and the function node
    // (`sympify/sympify`, kind:function, qn:sympify) share a qualified_name. A
    // call `sympify(...)` from another file must resolve to the CALLABLE
    // (`sympify/sympify`), not go AMBIGUOUS because the module collides on the
    // name — modules are import targets, never call dsts. Regression for the
    // pending spawned task ("function whose name == its module basename ... refs
    // can't find it").
    const collisionNodes: GraphNode[] = [
      {
        id: "sympify", name: "sympify", qualified_name: "sympify", kind: "module",
        language: "python", file: "src/sympify.py", range: [1, 3], ast_hash: "m1",
        last_seen: 0, logical_clock: 0,
      },
      {
        id: "sympify/sympify", name: "sympify", qualified_name: "sympify", kind: "function",
        language: "python", file: "src/sympify.py", range: [1, 2], ast_hash: "f1",
        last_seen: 0, logical_clock: 0,
      },
      {
        id: "use_sympify/driver", name: "driver", qualified_name: "driver", kind: "function",
        language: "python", file: "src/use_sympify.py", range: [1, 3], ast_hash: "d1",
        last_seen: 0, logical_clock: 0,
      },
    ];
    const raw: RawEdge[] = [
      { src_file: "src/use_sympify.py", src_name: "driver", dst_name: "sympify", kind: "static_call" },
    ];
    const { resolved, unresolved } = resolveEdges(collisionNodes, raw);
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.dst).toBe("sympify/sympify"); // the function, NOT the module
    expect(unresolved.length).toBe(0);
  });
});

describe("runIngest", () => {
  it("inserts nodes, resolves edges, and writes markdown", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-ingest-"));
    const db = new Db(":memory:");
    db.migrate();
    const records: NativeRecord[] = [
      { type: "start", files_total: 1, version: "0.0.0-test" },
      {
        type: "node",
        file: "src/auth/login.ts",
        name: "loginHandler",
        qualified_name: "loginHandler",
        kind: "function",
        language: "typescript",
        range: [1, 10],
        ast_hash: "abc",
      },
      {
        type: "node",
        file: "src/auth/login.ts",
        name: "validate_session",
        qualified_name: "validate_session",
        kind: "function",
        language: "typescript",
        range: [11, 20],
        ast_hash: "def",
      },
      {
        type: "edge",
        src_file: "src/auth/login.ts",
        src_name: "loginHandler",
        dst_name: "validate_session",
        kind: "static_call",
      },
      { type: "progress", files_done: 1 },
      { type: "done", files_done: 1, nodes: 2, edges: 1, elapsed_ms: 5 },
    ];
    const result = await runIngest({ db, nodesDir: tmp, run: fakeRun(records) });
    expect(result.nodes).toBe(2);
    expect(result.edges).toBe(1);
    expect(result.unresolvedEdges).toBe(0);
    expect(db.getNode("auth/loginHandler")?.name).toBe("loginHandler");
    expect(db.outgoing("auth/loginHandler")[0]?.dst).toBe("auth/validate_session");
    db.close();
  });
});

describe("BL-10: cross-file edge re-resolution after an incremental ingest", () => {
  // Module node for a file, so the entity-id scheme prefixes the module name.
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

  test("a caller in an UNCHANGED file re-resolves `?:f` to the new id after `f` is ingested", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-bl10-"));
    const db = new Db(":memory:");
    db.migrate();

    // ─── Step 1: ingest ONLY file B (the unchanged-later caller). It calls
    // `f`, which doesn't exist in this batch → edge resolves to `?:f`.
    await runIngest({
      db,
      nodesDir: tmp,
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0-test" },
        moduleRec("src/b/caller.ts", "caller"),
        fnRec("src/b/caller.ts", "callB"),
        {
          type: "edge",
          src_file: "src/b/caller.ts",
          src_name: "callB",
          dst_name: "f",
          kind: "static_call",
        },
        { type: "progress", files_done: 1 },
        { type: "done", files_done: 1, nodes: 2, edges: 1, elapsed_ms: 1 },
      ]),
    });

    // B's caller points at the unresolved sentinel.
    const callerId = "b/caller/callB";
    expect(db.outgoing(callerId).map((e) => e.dst)).toEqual(["?:f"]);

    // ─── Step 2: incremental ingest of ONLY file A, which now defines `f`.
    // The within-batch resolver only sees A's nodes, so B's `?:f` is NOT
    // touched here — exactly the BL-10 gap.
    await runIngest({
      db,
      nodesDir: tmp,
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0-test" },
        moduleRec("src/a/target.ts", "target"),
        fnRec("src/a/target.ts", "f"),
        { type: "progress", files_done: 1 },
        { type: "done", files_done: 1, nodes: 2, edges: 0, elapsed_ms: 1 },
      ]),
    });

    const fId = "a/target/f";
    expect(db.getNode(fId)?.name).toBe("f");
    // Still stale before the re-resolve pass.
    expect(db.outgoing(callerId).map((e) => e.dst)).toEqual(["?:f"]);

    // ─── Step 3: the BL-10 whole-set re-resolve pass.
    const fixed = reresolveAllEdges(db);
    expect(fixed).toBe(1);

    // B's caller now points at A's `f` — no longer unresolved.
    const after = db.outgoing(callerId).map((e) => e.dst);
    expect(after).toEqual([fId]);
    expect(after).not.toContain("?:f");
    // The edge metadata (kind/weight) survived the rewrite.
    expect(db.outgoing(callerId)[0]?.kind).toBe("static_call");

    // ─── Idempotence: a second pass finds nothing new to resolve.
    expect(reresolveAllEdges(db)).toBe(0);

    db.close();
  });

  test("leaves a still-unresolvable `?:` edge alone, and never resolves to an AMBIGUOUS name", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-bl10-amb-"));
    const db = new Db(":memory:");
    db.migrate();

    // Caller B references `g`, which never gets defined → stays `?:g`.
    // Two distinct `dup` entities exist in sibling files → `dup` is ambiguous;
    // a caller referencing `dup` must NOT resolve to either.
    await runIngest({
      db,
      nodesDir: tmp,
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0-test" },
        moduleRec("src/b/caller.ts", "caller"),
        fnRec("src/b/caller.ts", "callB"),
        { type: "edge", src_file: "src/b/caller.ts", src_name: "callB", dst_name: "g", kind: "static_call" },
        { type: "edge", src_file: "src/b/caller.ts", src_name: "callB", dst_name: "dup", kind: "static_call" },
        { type: "progress", files_done: 1 },
        { type: "done", files_done: 1, nodes: 2, edges: 2, elapsed_ms: 1 },
      ]),
    });

    // Now ingest two sibling files that both define `dup` (qualified_name dup).
    await runIngest({
      db,
      nodesDir: tmp,
      run: fakeRun([
        { type: "start", files_total: 2, version: "0.0.0-test" },
        moduleRec("src/a/one.ts", "one"),
        fnRec("src/a/one.ts", "dup"),
        moduleRec("src/a/two.ts", "two"),
        fnRec("src/a/two.ts", "dup"),
        { type: "progress", files_done: 2 },
        { type: "done", files_done: 2, nodes: 4, edges: 0, elapsed_ms: 1 },
      ]),
    });

    const fixed = reresolveAllEdges(db);
    expect(fixed).toBe(0); // neither `?:g` (missing) nor `?:dup` (ambiguous) resolves
    const dsts = db.outgoing("b/caller/callB").map((e) => e.dst).sort();
    expect(dsts).toEqual(["?:dup", "?:g"]);

    db.close();
  });
});

describe("ingest git-HEAD stat (shared contract with the freshness lane)", () => {
  const minimalRun = (): ParseRun =>
    fakeRun([
      { type: "start", files_total: 0, version: "0.0.0-test" },
      { type: "done", files_done: 0, nodes: 0, edges: 0, elapsed_ms: 1 },
    ]);

  it("writes last_ingest_git_head from `git rev-parse HEAD` in a git repo", async () => {
    const repo = mkdtempSync(join(tmpdir(), "hayven-githead-repo-"));
    const git = (args: string[]): void => {
      const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      if (!p.success) throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
    };
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.t"]);
    git(["config", "user.name", "t"]);
    git(["commit", "--allow-empty", "-q", "-m", "init"]);
    const expected = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" })
      .stdout.toString()
      .trim();

    const tmp = mkdtempSync(join(tmpdir(), "hayven-githead-nodes-"));
    const db = new Db(":memory:");
    db.migrate();
    await runIngest({ db, nodesDir: tmp, run: minimalRun(), repoRoot: repo });
    expect(db.getStat("last_ingest_git_head")).toBe(expected);
    expect(db.getStat("last_ingest_at")).not.toBeNull();
    db.close();
  });

  it("does NOT write the stat (and does not throw) when repoRoot is not a git repo", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "hayven-githead-norepo-"));
    const tmp = mkdtempSync(join(tmpdir(), "hayven-githead-nodes2-"));
    const db = new Db(":memory:");
    db.migrate();
    await runIngest({ db, nodesDir: tmp, run: minimalRun(), repoRoot: notRepo });
    expect(db.getStat("last_ingest_git_head")).toBeNull();
    expect(db.getStat("last_ingest_at")).not.toBeNull();
    db.close();
  });

  it("readGitHead returns null for a non-git directory and never throws", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "hayven-githead-unit-"));
    expect(readGitHead(notRepo)).toBeNull();
    expect(readGitHead(join(notRepo, "does-not-exist"))).toBeNull();
  });
});
