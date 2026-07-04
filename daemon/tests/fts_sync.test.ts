// FTS5 sync regression for the P2 scale fix: bulk node deletes bypass the
// per-row `nodes_fts_ad` trigger (which full-scans the trigram FTS table per
// node — O(deleted × total) — the measured 26s/30min+ pathology at 135K nodes)
// and do the FTS delete SET-BASED instead. These tests pin the CORRECTNESS the
// speed fix must preserve: nodes_fts stays exactly in sync, no ghost rows, and
// the triggers are restored so later inserts/deletes still mirror.
import { describe, expect, test } from "bun:test";

import { Db } from "../src/db/queries.ts";
import { searchFts } from "../src/db/fts.ts";
import type { GraphNode } from "../src/graph/types.ts";

function node(id: string, name: string, file: string): GraphNode {
  return {
    id,
    name,
    qualified_name: name,
    kind: "function",
    language: "typescript",
    file,
    range: [1, 3],
    ast_hash: "h",
    last_seen: 1,
    logical_clock: 0,
  };
}

function ftsCount(db: Db): number {
  return (db.handle.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM nodes_fts").get()?.c) ?? 0;
}

describe("FTS stays in sync across bulk deletes (trigger-bypass fix)", () => {
  test("deleteNodesByFile removes the file's FTS rows and leaves no ghosts", () => {
    const db = new Db(":memory:");
    db.migrate();
    db.upsertNode(node("a/zzztopfunc", "zzztopfunc", "a.ts"));
    db.upsertNode(node("a/qqqhelper", "qqqhelper", "a.ts"));
    db.upsertNode(node("b/wwwbottom", "wwwbottom", "b.ts"));
    expect(ftsCount(db)).toBe(3);
    expect(searchFts(db.handle, "zzztopfunc").length).toBeGreaterThan(0);

    db.deleteNodesByFile("a.ts");

    // a.ts's nodes (and their FTS rows) are gone — assert directly that NO
    // nodes_fts row remains for an a.ts id (the precise no-ghost check; a search
    // assertion would be muddied by trigram overlap between unrelated names).
    expect(db.counts().nodes).toBe(1);
    expect(ftsCount(db)).toBe(1);
    const ghosts = (db.handle
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM nodes_fts WHERE id LIKE 'a/%'")
      .get()?.c) ?? 0;
    expect(ghosts).toBe(0); // pre-fix the per-row trigger desync risk lived here
    // b.ts is untouched and still searchable.
    expect(searchFts(db.handle, "wwwbottom").length).toBeGreaterThan(0);
    db.close();
  });

  test("the AFTER-INSERT trigger is restored, so a re-insert re-populates FTS", () => {
    const db = new Db(":memory:");
    db.migrate();
    db.upsertNode(node("a/x", "symbolX", "a.ts"));
    db.deleteNodesByFile("a.ts"); // drops + recreates the triggers internally
    // A fresh insert AFTER the bypass must still mirror into FTS (trigger back on).
    db.upsertNode(node("a/y", "symbolY", "a.ts"));
    expect(ftsCount(db)).toBe(1);
    expect(searchFts(db.handle, "symbolY").length).toBeGreaterThan(0);
    db.close();
  });

  test("clearGraph empties nodes, edges, and FTS — then re-ingest re-populates", () => {
    const db = new Db(":memory:");
    db.migrate();
    db.upsertNode(node("a/c", "clearMe", "a.ts"));
    db.upsertEdge({ src: "a/c", dst: "a/d", kind: "static_call", weight: 1, last_seen: 1 });
    expect(ftsCount(db)).toBe(1);

    db.clearGraph();

    expect(db.counts().nodes).toBe(0);
    expect(db.counts().edges).toBe(0);
    expect(ftsCount(db)).toBe(0);
    expect(searchFts(db.handle, "clearMe")).toHaveLength(0);

    // The FTS table + triggers survived the DROP+recreate: a post-clear insert
    // mirrors into FTS and is searchable.
    db.upsertNode(node("a/e", "afterClear", "a.ts"));
    expect(ftsCount(db)).toBe(1);
    expect(searchFts(db.handle, "afterClear").length).toBeGreaterThan(0);
    db.close();
  });
});
