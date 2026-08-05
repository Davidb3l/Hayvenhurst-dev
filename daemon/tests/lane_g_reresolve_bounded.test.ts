import { describe, expect, test } from "bun:test";

import { Db } from "../src/db/queries.ts";
import { reresolveAllEdges } from "../src/graph/ingest.ts";
import type { GraphNode } from "../src/graph/types.ts";

/**
 * Lane G: `reresolveAllEdges` is now BOUNDED by the unresolved set, not the
 * graph: it fetches the `?:` edges first (returning immediately when there are
 * none) and materializes only the candidate nodes whose name/qualified_name
 * matches an unresolved name, instead of SELECTing every node in the graph
 * into three JS maps after every one-file save.
 *
 * The bounding is an OPTIMIZATION ONLY: same rewrites in, same rewrites out.
 * This suite pins the old semantics behaviorally: the unambiguous case
 * resolves, the AMBIGUOUS case stays unresolved, the missing-target case stays
 * unresolved, the self-loop guard holds, import edges are never name-resolved,
 * and the zero-unresolved warm-graph case returns 0 without touching `nodes`.
 */

function node(
  id: string,
  name: string,
  file: string,
  kind: GraphNode["kind"] = "function",
  qualifiedName?: string,
): GraphNode {
  return {
    id,
    name,
    qualified_name: qualifiedName ?? name,
    kind,
    language: "typescript",
    file,
    range: [1, 5],
    ast_hash: `hash-${id}`,
    last_seen: 0,
    logical_clock: 0,
  };
}

describe("lane G: reresolveAllEdges bounded pass preserves resolution semantics", () => {
  test("unambiguous resolves, ambiguous and missing stay `?:`, self-loop and import guards hold, amid resolved noise", () => {
    const db = new Db(":memory:");
    db.migrate();

    db.upsertNodes([
      // The caller whose unresolved edges are under test.
      node("src/b/caller/callB", "callB", "src/b/caller.ts"),
      // Unambiguous target for `?:f`.
      node("src/a/target/f", "f", "src/a/target.ts"),
      // AMBIGUOUS pair for `?:dup` (two distinct ids share the name in the
      // same implicit package).
      node("src/a/one/dup", "dup", "src/a/one.ts"),
      node("src/a/two/dup", "dup", "src/a/two.ts"),
      // Resolved NOISE nodes, never candidates (no `?:` edge names them).
      // Under the old whole-table scan these were indexed anyway; the bounded
      // pass must produce identical outcomes without them.
      node("src/n/noise/n1", "n1", "src/n/noise.ts"),
      node("src/n/noise/n2", "n2", "src/n/noise.ts"),
      node("src/n/noise/n3", "n3", "src/n/noise.ts"),
    ]);

    const edges = [
      // Resolves: `f` is unique.
      { src: "src/b/caller/callB", dst: "?:f", kind: "static_call" as const, weight: 3, last_seen: 0 },
      // Stays: `dup` is AMBIGUOUS (two candidates, same package).
      { src: "src/b/caller/callB", dst: "?:dup", kind: "static_call" as const, weight: 1, last_seen: 0 },
      // Stays: `ghost` matches nothing.
      { src: "src/b/caller/callB", dst: "?:ghost", kind: "static_call" as const, weight: 1, last_seen: 0 },
      // Stays: `callB` uniquely names the CALLER itself (the self-loop guard).
      { src: "src/b/caller/callB", dst: "?:callB", kind: "static_call" as const, weight: 1, last_seen: 0 },
      // Stays: an import's `?:` payload is a module SPECIFIER, excluded even
      // though a same-named unique entity exists (`f` here would be a false
      // rewire; the lane A guard, re-pinned under the bounded shape).
      { src: "src/b/caller/callB", dst: "?:f", kind: "import" as const, weight: 1, last_seen: 0 },
      // Resolved noise edges among the noise nodes, untouched throughout.
      { src: "src/n/noise/n1", dst: "src/n/noise/n2", kind: "static_call" as const, weight: 1, last_seen: 0 },
      { src: "src/n/noise/n2", dst: "src/n/noise/n3", kind: "references" as const, weight: 1, last_seen: 0 },
    ];
    for (const e of edges) db.upsertEdge(e);

    const fixed = reresolveAllEdges(db);
    expect(fixed).toBe(1); // only `?:f` (static_call) resolves

    const dsts = db
      .outgoing("src/b/caller/callB")
      .map((e) => `${e.kind}→${e.dst}`)
      .sort();
    expect(dsts).toEqual([
      "import→?:f", // import guard: specifier never name-resolved
      "static_call→?:callB", // self-loop guard
      "static_call→?:dup", // AMBIGUOUS stays unresolved
      "static_call→?:ghost", // missing target stays unresolved
      "static_call→src/a/target/f", // the one legitimate rewrite
    ]);
    // The rewrite preserved the edge's weight (delete + upsert, not a reset).
    const rewritten = db
      .outgoing("src/b/caller/callB")
      .find((e) => e.dst === "src/a/target/f");
    expect(rewritten?.weight).toBe(3);

    // Noise edges untouched.
    expect(db.outgoing("src/n/noise/n1").map((e) => e.dst)).toEqual(["src/n/noise/n2"]);
    expect(db.outgoing("src/n/noise/n2").map((e) => e.dst)).toEqual(["src/n/noise/n3"]);

    // Idempotent: a second pass has nothing new to resolve.
    expect(reresolveAllEdges(db)).toBe(0);

    db.close();
  });

  test("zero unresolved edges returns 0 WITHOUT querying the nodes table (the warm-graph early return)", () => {
    const db = new Db(":memory:");
    db.migrate();

    // A healthy graph: nodes plus fully-resolved edges, no `?:` anywhere.
    db.upsertNodes([
      node("src/a/x/one", "one", "src/a/x.ts"),
      node("src/a/x/two", "two", "src/a/x.ts"),
    ]);
    db.upsertEdge({ src: "src/a/x/one", dst: "src/a/x/two", kind: "static_call", weight: 1, last_seen: 0 });

    // Count queries through a wrapped handle. `query` is a prototype method on
    // bun:sqlite's Database, so an own-property shadow intercepts every call
    // this pass makes; deleting it afterwards restores the prototype method.
    const sqls: string[] = [];
    const handle = db.handle as unknown as {
      query: (sql: string, ...rest: unknown[]) => unknown;
    };
    const original = handle.query.bind(db.handle);
    handle.query = (sql: string, ...rest: unknown[]) => {
      sqls.push(sql);
      return original(sql, ...rest);
    };
    try {
      expect(reresolveAllEdges(db)).toBe(0);
    } finally {
      delete (handle as { query?: unknown }).query;
    }

    // It looked at the edges (the `?:` prefix scan) and NOTHING else; in
    // particular, no node materialization of any kind.
    expect(sqls.some((s) => s.includes("FROM edges"))).toBe(true);
    expect(sqls.some((s) => s.includes("FROM nodes"))).toBe(false);

    db.close();
  });
});
