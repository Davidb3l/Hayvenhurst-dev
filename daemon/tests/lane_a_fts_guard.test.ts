import { describe, expect, test } from "bun:test";

import { Db } from "../src/db/queries.ts";
import type { GraphNode } from "../src/graph/types.ts";

/**
 * Regression: the no-FTS degradation path must be COMPLETE.
 *
 * `migrate()` guards every FTS5 object behind `ftsAvailable(db)` — on a SQLite
 * build without FTS5+trigram, `nodes_fts` and its sync triggers are simply
 * never created. But `clearGraph()` / `withoutFtsTriggers` / the set-based FTS
 * delete in `deleteNodesByFile` used to execute FTS SQL UNCONDITIONALLY, so
 * the first full reingest on such a build threw `no such table: nodes_fts`
 * inside the wipe transaction.
 *
 * There is no existing suite pattern for booting Bun's SQLite without FTS5
 * (the linked library always has it), so this test SIMULATES the no-FTS state
 * the honest way: drop the FTS table + triggers exactly as a no-FTS `migrate`
 * would have left them (i.e. absent), and pin the Db's cached `ftsAvailable`
 * probe to `false` so every guard sees what it would see on a real no-FTS
 * build. The guard logic itself — not the SQLite build — is what's under test.
 */

function node(id: string, file: string, name: string): GraphNode {
  return {
    id,
    name,
    qualified_name: name,
    kind: "function",
    language: "typescript",
    file,
    range: [1, 5],
    ast_hash: `h-${id}`,
    last_seen: 0,
    logical_clock: 0,
  };
}

/** Put a migrated Db into the state a no-FTS `migrate()` produces. */
function simulateNoFts(db: Db): void {
  db.handle.exec(
    "DROP TRIGGER IF EXISTS nodes_fts_ai;" +
      "DROP TRIGGER IF EXISTS nodes_fts_ad;" +
      "DROP TRIGGER IF EXISTS nodes_fts_au;" +
      "DROP TABLE IF EXISTS nodes_fts;",
  );
  // Pin the cached probe: on a real no-FTS build `ftsAvailable` returns false;
  // here the linked SQLite does have FTS5, so the cache is the seam.
  (db as unknown as { ftsProbe: boolean | null }).ftsProbe = false;
}

function hasNodesFtsTable(db: Db): boolean {
  const row = db.handle
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get("nodes_fts");
  return (row?.n ?? 0) > 0;
}

describe("lane A: no-FTS degradation in clearGraph / deleteNodesByFile", () => {
  test("clearGraph on a no-FTS build wipes the graph without touching FTS SQL", () => {
    const db = new Db(":memory:");
    db.migrate();
    simulateNoFts(db);

    db.upsertNodes([node("a/one/f", "src/a/one.ts", "f"), node("a/two/g", "src/a/two.ts", "g")]);
    expect(db.counts().nodes).toBe(2);

    // Pre-fix this threw `no such table: nodes_fts` inside the transaction.
    expect(() => db.clearGraph()).not.toThrow();
    expect(db.counts().nodes).toBe(0);
    expect(db.counts().edges).toBe(0);
    // The FTS table must NOT have been recreated — this build "doesn't have"
    // FTS5, so `FTS_SQL` would have thrown; its absence proves it was skipped.
    expect(hasNodesFtsTable(db)).toBe(false);

    // clearGraph without a following runIngest requires endIngest on the same
    // handle (its documented contract), so the index isn't left flagged.
    db.endIngest();
    db.close();
  });

  test("deleteNodesByFile on a no-FTS build deletes rows without FTS SQL", () => {
    const db = new Db(":memory:");
    db.migrate();
    simulateNoFts(db);

    db.upsertNodes([node("a/one/f", "src/a/one.ts", "f"), node("a/two/g", "src/a/two.ts", "g")]);

    // Pre-fix the set-based `DELETE FROM nodes_fts …` threw here.
    let removed = 0;
    expect(() => {
      removed = db.deleteNodesByFile("src/a/one.ts");
    }).not.toThrow();
    expect(removed).toBe(1);
    expect(db.getNode("a/one/f")).toBeNull();
    expect(db.getNode("a/two/g")?.name).toBe("g");
    db.close();
  });

  test("control: with FTS available, clearGraph still recreates the empty FTS table", () => {
    const db = new Db(":memory:");
    db.migrate();
    db.upsertNodes([node("a/one/f", "src/a/one.ts", "f")]);

    db.clearGraph();
    expect(db.counts().nodes).toBe(0);
    // The FTS-capable path is unchanged: `nodes_fts` is dropped and recreated
    // empty, ready for the repopulating ingest's INSERT trigger.
    expect(hasNodesFtsTable(db)).toBe(true);

    db.endIngest();
    db.close();
  });
});
