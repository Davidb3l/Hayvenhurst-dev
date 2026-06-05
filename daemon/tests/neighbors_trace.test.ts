/**
 * §6 neighbors graph × §7 resolved runtime-trace edges.
 *
 * `collectRaw` (daemon/src/daemon/routes/stats.ts) merges resolved trace edges
 * — calls the static parser missed but the runtime observed — into the same BFS
 * that walks static `outgoing`/`incoming`. These tests pin the contract:
 *   - a resolved trace edge ADDS a pair the static graph lacks (kind:"trace_call");
 *   - a pair with BOTH static and trace appears ONCE, static winning;
 *   - NO trace observations → output identical to the pre-change static-only path;
 *   - scope filter + module collapse keep working with trace edges present.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

interface NeighborResponse {
  center: string;
  cluster_level: "function" | "module";
  nodes: Array<{ id: string; name: string; kind: string; count?: number }>;
  edges: Array<{ src: string; dst: string; weight: number; kind?: string }>;
  total_raw_nodes: number;
}

function mkApp(db: Db): ReturnType<typeof buildApp> {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-trace-neighbors-"));
  const paths = hayvenPathsFor(repoRoot);
  return buildApp({
    db,
    config: DEFAULT_CONFIG,
    paths,
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used in this test");
      },
    },
  });
}

/** Index a node whose unambiguous `name`/`qualified_name` the resolver can hit. */
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

async function getNeighbors(
  app: ReturnType<typeof buildApp>,
  id: string,
  qs: string,
): Promise<NeighborResponse> {
  const res = await app.handle(
    new Request(`http://localhost/api/neighbors/${encodeURIComponent(id)}?${qs}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as NeighborResponse;
}

describe("/api/neighbors/:id trace-augmented edges", () => {
  it("merges a resolved trace edge the static graph lacks (kind:trace_call)", async () => {
    const db = new Db(":memory:");
    db.migrate();
    // Three indexed nodes with distinct bare names so runtime names resolve
    // unambiguously: A→aFn, B→bFn, C→cFn.
    seedNode(db, "src/a/A", "aFn", "src/a/A.ts");
    seedNode(db, "src/b/B", "bFn", "src/b/B.ts");
    seedNode(db, "src/c/C", "cFn", "src/c/C.ts");

    // STATIC edge A→B.
    db.upsertEdge({
      src: "src/a/A",
      dst: "src/b/B",
      kind: "static_call",
      weight: 4,
      last_seen: 0,
    });

    // RESOLVED trace edge A→C (no static A→C). Runtime names resolve via the
    // bare-name index: "aFn" → src/a/A, "cFn" → src/c/C.
    db.insertObservations([
      { src: "aFn", dst: "cFn", ts: 1, observed: 9, weight: 9, source: "py" },
    ]);

    const app = mkApp(db);
    const body = await getNeighbors(app, "src/a/A", "depth=1&cluster=off");

    expect(body.cluster_level).toBe("function");
    // C is pulled into the node set via the trace edge.
    expect(body.nodes.map((n) => n.id).sort()).toEqual(["src/a/A", "src/b/B", "src/c/C"]);

    const ab = body.edges.find((e) => e.src === "src/a/A" && e.dst === "src/b/B");
    const ac = body.edges.find((e) => e.src === "src/a/A" && e.dst === "src/c/C");
    expect(ab).toEqual({ src: "src/a/A", dst: "src/b/B", weight: 4, kind: "static_call" });
    expect(ac).toEqual({ src: "src/a/A", dst: "src/c/C", weight: 9, kind: "trace_call" });
    expect(body.edges.length).toBe(2);
  });

  it("static wins when a pair has BOTH static and trace edges (appears once)", async () => {
    const db = new Db(":memory:");
    db.migrate();
    seedNode(db, "src/a/A", "aFn", "src/a/A.ts");
    seedNode(db, "src/b/B", "bFn", "src/b/B.ts");

    db.upsertEdge({
      src: "src/a/A",
      dst: "src/b/B",
      kind: "static_call",
      weight: 4,
      last_seen: 0,
    });
    // Trace observation resolving to the SAME pair A→B.
    db.insertObservations([
      { src: "aFn", dst: "bFn", ts: 1, observed: 9, weight: 9, source: "py" },
    ]);

    const app = mkApp(db);
    const body = await getNeighbors(app, "src/a/A", "depth=1&cluster=off");

    const abEdges = body.edges.filter((e) => e.src === "src/a/A" && e.dst === "src/b/B");
    expect(abEdges).toHaveLength(1);
    expect(abEdges[0]).toEqual({ src: "src/a/A", dst: "src/b/B", weight: 4, kind: "static_call" });
  });

  it("trace incoming edge pulls a runtime-only caller into the neighborhood", async () => {
    const db = new Db(":memory:");
    db.migrate();
    seedNode(db, "src/a/A", "aFn", "src/a/A.ts");
    seedNode(db, "src/c/C", "cFn", "src/c/C.ts");
    // Trace edge C→A. Centering on A, the trace INCOMING traversal must reach C.
    db.insertObservations([
      { src: "cFn", dst: "aFn", ts: 1, observed: 3, weight: 3, source: "py" },
    ]);

    const app = mkApp(db);
    const body = await getNeighbors(app, "src/a/A", "depth=1&cluster=off");

    expect(body.nodes.map((n) => n.id).sort()).toEqual(["src/a/A", "src/c/C"]);
    expect(body.edges).toEqual([
      { src: "src/c/C", dst: "src/a/A", weight: 3, kind: "trace_call" },
    ]);
  });

  it("NO trace observations → output identical to the static-only path (regression guard)", async () => {
    // Two dbs seeded identically; one ALSO has unresolvable observations (raw
    // names that match no node, so resolvedSrc/Dst stay null and never join).
    const build = (withNoise: boolean): Db => {
      const db = new Db(":memory:");
      db.migrate();
      seedNode(db, "src/a/A", "aFn", "src/a/A.ts");
      seedNode(db, "src/b/B", "bFn", "src/b/B.ts");
      db.upsertEdge({
        src: "src/a/A",
        dst: "src/b/B",
        kind: "static_call",
        weight: 4,
        last_seen: 0,
      });
      if (withNoise) {
        // Names that resolve to nothing in the index → both endpoints null.
        db.insertObservations([
          { src: "noSuchCaller", dst: "noSuchCallee", ts: 1, observed: 2, weight: 2, source: "py" },
        ]);
      }
      return db;
    };

    const baseline = await getNeighbors(mkApp(build(false)), "src/a/A", "depth=2&cluster=auto");
    const withNoise = await getNeighbors(mkApp(build(true)), "src/a/A", "depth=2&cluster=auto");
    expect(withNoise).toEqual(baseline);
  });

  it("module collapse + scope filter handle trace edges with no special-casing", async () => {
    const db = new Db(":memory:");
    db.migrate();
    // src/auth has two nodes; src/db has one. A static intra-auth edge plus a
    // resolved trace edge from auth → db.
    seedNode(db, "src/auth/login", "login", "src/auth/login.ts");
    seedNode(db, "src/auth/verify", "verify", "src/auth/verify.ts");
    seedNode(db, "src/db/query", "query", "src/db/query.ts");

    db.upsertEdge({
      src: "src/auth/login",
      dst: "src/auth/verify",
      kind: "static_call",
      weight: 2,
      last_seen: 0,
    });
    // Trace edge login → query (cross-module, static parser missed it).
    db.insertObservations([
      { src: "login", dst: "query", ts: 1, observed: 5, weight: 5, source: "py" },
    ]);

    const app = mkApp(db);

    // Module collapse: trace edge contributes a src/auth → src/db cluster edge.
    const mod = await getNeighbors(app, "src/auth/login", "depth=1&cluster=module");
    expect(mod.cluster_level).toBe("module");
    expect(mod.nodes.map((n) => n.id).sort()).toEqual(["src/auth", "src/db"]);
    const authToDb = mod.edges.find((e) => e.src === "src/auth" && e.dst === "src/db");
    expect(authToDb).toEqual({ src: "src/auth", dst: "src/db", weight: 5, kind: "cluster" });
    // Intra-auth static edge collapses into the node count, not an edge.
    expect(mod.edges.every((e) => e.src !== e.dst)).toBe(true);

    // Scope filter: scope=src/auth drops the out-of-scope trace endpoint (db).
    const scoped = await getNeighbors(app, "src/auth/login", "depth=1&cluster=off&scope=src/auth");
    expect(scoped.nodes.map((n) => n.id).sort()).toEqual(["src/auth/login", "src/auth/verify"]);
    expect(scoped.edges).toEqual([
      { src: "src/auth/login", dst: "src/auth/verify", weight: 2, kind: "static_call" },
    ]);
  });
});
