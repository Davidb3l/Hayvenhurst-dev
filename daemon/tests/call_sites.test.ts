/**
 * Line-precise call sites (`hayven refs --sites`) + the Python idScheme
 * collision fix, end to end through the SYNTHETIC path.
 *
 * The native binary may not yet emit `line`/`col` when this runs, so every test
 * here drives the line/col path with SYNTHETIC protocol records and synthetic
 * RawEdges (feeding `parseLine`/`resolveEdges` directly) — none depend on the
 * real binary emitting offsets.
 *
 * Coverage:
 *   1. protocol: `parseLine` carries `line`/`col` only when finite; older
 *      payloads (no fields) round-trip byte-identically.
 *   2. resolveEdges: a resolved call edge with line/col yields a per-occurrence
 *      CallSite; absent line/col yields no site; import edges never do.
 *   3. Db: insertCallSites / callSitesOf (ordered) / clearCallSites /
 *      deleteCallSitesByFile.
 *   4. graph_walk.sitesOf maps rows to {file,line,col,caller,kind}.
 *   5. idScheme collision: a function whose name == its module basename gets a
 *      DISTINCT id and a call to it resolves to the FUNCTION, not the module.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseLine } from "../src/native/protocol.ts";
import { resolveEdges } from "../src/graph/ingest.ts";
import { deriveEntityId } from "../src/graph/idScheme.ts";
import type { GraphNode, RawEdge } from "../src/graph/types.ts";
import { Db } from "../src/db/queries.ts";
import { sitesOf } from "../src/db/graph_walk.ts";

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "hayven-call-sites-"));
  const db = new Db(join(dir, "index.db"));
  db.migrate();
  return db;
}

function mod(file: string, id: string): GraphNode {
  const name = id.split("/").pop()!;
  return {
    id,
    name,
    qualified_name: name,
    kind: "module",
    language: "python",
    file,
    range: [1, 1],
    ast_hash: `mod-${file}`,
    last_seen: 0,
    logical_clock: 0,
  };
}

function entity(
  file: string,
  id: string,
  name: string,
  qualifiedName: string,
  kind: GraphNode["kind"] = "function",
): GraphNode {
  return {
    id,
    name,
    qualified_name: qualifiedName,
    kind,
    language: "python",
    file,
    range: [1, 5],
    ast_hash: `e-${id}`,
    last_seen: 0,
    logical_clock: 0,
  };
}

describe("protocol: edge line/col (additive, defensive)", () => {
  it("carries line/col when present and finite", () => {
    const rec = parseLine(
      JSON.stringify({
        type: "edge",
        src_file: "src/a.ts",
        src_name: "caller",
        dst_name: "callee",
        kind: "static_call",
        line: 42,
        col: 7,
      }),
    );
    expect(rec.type).toBe("edge");
    if (rec.type === "edge") {
      expect(rec.line).toBe(42);
      expect(rec.col).toBe(7);
    }
  });

  it("omits line/col when absent (older binaries) — byte-identical shape", () => {
    const rec = parseLine(
      JSON.stringify({
        type: "edge",
        src_file: "src/a.ts",
        src_name: "caller",
        dst_name: "callee",
        kind: "static_call",
      }),
    );
    expect(rec).toEqual({
      type: "edge",
      src_file: "src/a.ts",
      src_name: "caller",
      dst_name: "callee",
      kind: "static_call",
    });
  });

  it("drops non-finite line/col defensively", () => {
    const rec = parseLine(
      JSON.stringify({
        type: "edge",
        src_file: "src/a.ts",
        src_name: "caller",
        dst_name: "callee",
        kind: "static_call",
        line: "nope",
        col: null,
      }),
    );
    if (rec.type === "edge") {
      expect(rec.line).toBeUndefined();
      expect(rec.col).toBeUndefined();
    }
  });
});

describe("resolveEdges: per-occurrence call sites", () => {
  const nodes: GraphNode[] = [
    mod("src/app.ts", "app"),
    entity("src/app.ts", "app/main", "main", "main"),
    entity("src/app.ts", "app/helper", "helper", "helper"),
  ];

  it("emits a CallSite for a resolved call edge carrying line/col", () => {
    const edges: RawEdge[] = [
      {
        src_file: "src/app.ts",
        src_name: "main",
        dst_name: "helper",
        kind: "static_call",
        line: 12,
        col: 3,
      },
    ];
    const { resolved, sites } = resolveEdges(nodes, edges, { repoRoot: "" });
    expect(resolved).toHaveLength(1);
    expect(sites).toEqual([
      {
        dst: "app/helper",
        src: "app/main",
        kind: "static_call",
        file: "src/app.ts",
        line: 12,
        col: 3,
      },
    ]);
  });

  it("emits ONE site per occurrence (two edge records → two sites, weight summed at DB)", () => {
    const edges: RawEdge[] = [
      { src_file: "src/app.ts", src_name: "main", dst_name: "helper", kind: "static_call", line: 12, col: 3 },
      { src_file: "src/app.ts", src_name: "main", dst_name: "helper", kind: "static_call", line: 19, col: 9 },
    ];
    const { sites } = resolveEdges(nodes, edges, { repoRoot: "" });
    expect(sites.map((s) => `${s.line}:${s.col}`)).toEqual(["12:3", "19:9"]);
  });

  it("produces NO site when line/col are absent", () => {
    const edges: RawEdge[] = [
      { src_file: "src/app.ts", src_name: "main", dst_name: "helper", kind: "static_call" },
    ];
    const { resolved, sites } = resolveEdges(nodes, edges, { repoRoot: "" });
    expect(resolved).toHaveLength(1);
    expect(sites).toHaveLength(0);
  });

  it("never produces a site for an import edge even if line/col leak in", () => {
    const importNodes: GraphNode[] = [
      mod("src/app.ts", "app"),
      mod("src/lib.ts", "lib"),
    ];
    const edges: RawEdge[] = [
      {
        src_file: "src/app.ts",
        src_name: "app",
        dst_name: "./lib.ts",
        kind: "import",
        line: 1,
        col: 1,
      } as RawEdge,
    ];
    const { sites } = resolveEdges(importNodes, edges, { repoRoot: "" });
    expect(sites).toHaveLength(0);
  });
});

describe("Db.call_sites round-trip", () => {
  it("inserts, reads ordered by (file,line,col), clears, and deletes by file", () => {
    const db = freshDb();
    try {
      db.insertCallSites([
        { dst: "app/helper", src: "app/main", kind: "static_call", file: "src/app.ts", line: 19, col: 9 },
        { dst: "app/helper", src: "app/main", kind: "static_call", file: "src/app.ts", line: 12, col: 3 },
        { dst: "app/helper", src: "app/other", kind: "static_call", file: "src/b.ts", line: 4, col: 1 },
      ]);
      const rows = db.callSitesOf("app/helper");
      // Ordered by file, then line, then col.
      expect(rows.map((r) => `${r.file}:${r.line}:${r.col}`)).toEqual([
        "src/app.ts:12:3",
        "src/app.ts:19:9",
        "src/b.ts:4:1",
      ]);

      // deleteCallSitesByFile removes only the named file's sites.
      const removed = db.deleteCallSitesByFile(["src/app.ts"]);
      expect(removed).toBe(2);
      expect(db.callSitesOf("app/helper").map((r) => r.file)).toEqual(["src/b.ts"]);

      // clearCallSites empties the table entirely.
      db.clearCallSites();
      expect(db.callSitesOf("app/helper")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("sitesOf maps rows to {file,line,col,caller,kind}", () => {
    const db = freshDb();
    try {
      db.insertCallSites([
        { dst: "app/helper", src: "app/main", kind: "static_call", file: "src/app.ts", line: 12, col: 3 },
      ]);
      expect(sitesOf(db, "app/helper")).toEqual([
        { file: "src/app.ts", line: 12, col: 3, caller: "app/main", kind: "static_call" },
      ]);
      // Unknown symbol → empty, complete (never a top-N).
      expect(sitesOf(db, "nope")).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("idScheme collision: function named same as its module", () => {
  it("deriveEntityId gives the FUNCTION a distinct id from the MODULE node", () => {
    // The module node arrives with NO moduleName (kind:"module").
    const moduleId = deriveEntityId("src/parse/sympify.py", "sympify", { kind: "module" });
    // The function `sympify` in `sympify.py` supplies moduleName="sympify".
    const fnId = deriveEntityId("src/parse/sympify.py", "sympify", {
      moduleName: "sympify",
      kind: "function",
    });
    expect(moduleId).toBe("parse/sympify");
    expect(fnId).toBe("parse/sympify/sympify");
    expect(fnId).not.toBe(moduleId);
  });

  it("does NOT regress the module node id (parse/hash/hash must not appear)", () => {
    // Module node: no moduleName supplied.
    expect(deriveEntityId("src/parse/hash.rs", "hash", { kind: "module" })).toBe("parse/hash");
    // Legacy callers that pass moduleName but NO kind keep the old shape too
    // (the kind-undefined branch preserves `parse/hash`, not `parse/hash/hash`).
    expect(deriveEntityId("src/parse/hash.rs", "hash", { moduleName: "hash" })).toBe("parse/hash");
  });

  it("an import-pinned bare call resolves to the FUNCTION node, not the module", () => {
    // `from sympify import sympify; sympify()` — two nodes named `sympify`:
    // the module (parse/sympify) and the function (parse/sympify/sympify).
    const nodes: GraphNode[] = [
      mod("src/parse/sympify.py", "parse/sympify"),
      entity(
        "src/parse/sympify.py",
        "parse/sympify/sympify",
        "sympify",
        "sympify",
      ),
      mod("src/parse/caller.py", "parse/caller"),
      entity("src/parse/caller.py", "parse/caller/run", "run", "run"),
    ];
    const edges: RawEdge[] = [
      {
        src_file: "src/parse/caller.py",
        src_name: "caller",
        dst_name: "./sympify.py",
        kind: "import",
        local: ["sympify"],
      },
      {
        src_file: "src/parse/caller.py",
        src_name: "run",
        dst_name: "sympify",
        kind: "static_call",
        line: 8,
        col: 5,
      },
    ];
    const { resolved, sites } = resolveEdges(nodes, edges, { repoRoot: "" });
    const call = resolved.find((e) => e.kind === "static_call");
    // Resolves to the FUNCTION (the callable), not the module node.
    expect(call?.dst).toBe("parse/sympify/sympify");
    // And the line-precise site points at the function id too.
    expect(sites).toEqual([
      {
        dst: "parse/sympify/sympify",
        src: "parse/caller/run",
        kind: "static_call",
        file: "src/parse/caller.py",
        line: 8,
        col: 5,
      },
    ]);
  });

  it("the function node EXISTS with a distinct id (no UPSERT clobber in the Db)", () => {
    const db = freshDb();
    try {
      const moduleNode = mod("src/parse/sympify.py", "parse/sympify");
      const fnNode = entity(
        "src/parse/sympify.py",
        "parse/sympify/sympify",
        "sympify",
        "sympify",
      );
      db.upsertNode(moduleNode);
      db.upsertNode(fnNode);
      // Both nodes survive — distinct primary keys, no clobber.
      expect(db.getNode("parse/sympify")?.kind).toBe("module");
      expect(db.getNode("parse/sympify/sympify")?.kind).toBe("function");
    } finally {
      db.close();
    }
  });
});
