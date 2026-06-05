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

interface SearchResponse {
  query: string;
  count: number;
  hits: unknown[];
}

function buildTestApp(db: Db) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-robust-"));
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

function node(db: Db, id: string, file: string) {
  db.upsertNode({
    id,
    name: id.split("/").pop() ?? id,
    qualified_name: id,
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

describe("/api/neighbors/:id robustness", () => {
  it("depth=0 returns center-only (1 node, 0 deeper) and is not coerced to 1", async () => {
    const db = new Db(":memory:");
    db.migrate();
    node(db, "src/a/center", "src/a/center.ts");
    node(db, "src/a/callee", "src/a/callee.ts");
    db.upsertEdge({
      src: "src/a/center",
      dst: "src/a/callee",
      kind: "static_call",
      weight: 1,
      last_seen: 0,
    });
    const app = buildTestApp(db);

    // depth=0 must mean center-only: the falsy-zero bug used to force this to 1.
    const body = await getNeighbors(app, "src/a/center", "depth=0&cluster=off");
    expect(body.nodes.length).toBe(1);
    expect(body.nodes[0]!.id).toBe("src/a/center");
    expect(body.total_raw_nodes).toBe(1);

    // Sanity: depth=1 DOES reach the callee, proving 0 != 1.
    const deeper = await getNeighbors(app, "src/a/center", "depth=1&cluster=off");
    expect(deeper.nodes.length).toBe(2);
  });

  it("missing depth defaults to 1 (one hop)", async () => {
    const db = new Db(":memory:");
    db.migrate();
    node(db, "src/a/center", "src/a/center.ts");
    node(db, "src/a/callee", "src/a/callee.ts");
    db.upsertEdge({
      src: "src/a/center",
      dst: "src/a/callee",
      kind: "static_call",
      weight: 1,
      last_seen: 0,
    });
    const app = buildTestApp(db);
    const body = await getNeighbors(app, "src/a/center", "cluster=off");
    expect(body.nodes.length).toBe(2);
  });

  it("function-mode edges carry the required `kind` discriminator", async () => {
    const db = new Db(":memory:");
    db.migrate();
    node(db, "src/a/caller", "src/a/caller.ts");
    node(db, "src/a/callee", "src/a/callee.ts");
    db.upsertEdge({
      src: "src/a/caller",
      dst: "src/a/callee",
      kind: "static_call",
      weight: 3,
      last_seen: 0,
    });
    const app = buildTestApp(db);

    const body = await getNeighbors(app, "src/a/caller", "depth=1&cluster=off");
    expect(body.cluster_level).toBe("function");
    expect(body.edges.length).toBe(1);
    const edge = body.edges[0]!;
    expect(edge.kind).toBe("static_call");
    // Every edge must carry a kind (it's a required viewer discriminator).
    expect(body.edges.every((e) => typeof e.kind === "string" && e.kind.length > 0)).toBe(
      true,
    );
  });

  it('neighbors("*") returns a multi-node module-level overview, not a single `*` stub', async () => {
    const db = new Db(":memory:");
    db.migrate();
    // Seed >CLUSTER_AUTO_THRESHOLD (500) nodes across several modules so
    // cluster=auto collapses to a module-level overview.
    const modules = ["src/auth", "src/api", "src/db", "src/util", "src/web"];
    const perModule = 120; // 600 total
    for (const mod of modules) {
      for (let i = 0; i < perModule; i++) {
        node(db, `${mod}/fn_${i}`, `${mod}/file_${i}.ts`);
      }
    }
    // A few cross-module edges so the overview has real edges.
    db.upsertEdge({
      src: "src/auth/fn_0",
      dst: "src/api/fn_0",
      kind: "static_call",
      weight: 1,
      last_seen: 0,
    });
    db.upsertEdge({
      src: "src/api/fn_1",
      dst: "src/db/fn_2",
      kind: "import",
      weight: 1,
      last_seen: 0,
    });
    const app = buildTestApp(db);

    const body = await getNeighbors(app, "*", "depth=1&cluster=auto");
    // NOT a single synthesized `*` stub.
    expect(body.nodes.length).toBeGreaterThan(1);
    expect(body.nodes.some((n) => n.id === "*")).toBe(false);
    // Whole-graph seed → all 600 raw nodes considered.
    expect(body.total_raw_nodes).toBe(modules.length * perModule);
    // Above the 500 threshold cluster=auto collapses to module level.
    expect(body.cluster_level).toBe("module");
    expect(body.nodes.map((n) => n.id).sort()).toEqual([...modules].sort());
    // The cross-module edges survive collapse (as `cluster` edges).
    expect(body.edges.length).toBeGreaterThan(0);
  });

  it("a genuinely-unknown specific id still returns its 1-node stub (only `*` is the overview)", async () => {
    const db = new Db(":memory:");
    db.migrate();
    node(db, "src/a/real", "src/a/real.ts");
    const app = buildTestApp(db);

    const body = await getNeighbors(app, "does/not/exist", "depth=1&cluster=off");
    expect(body.nodes.length).toBe(1);
    expect(body.nodes[0]!.id).toBe("does/not/exist");
    expect(body.nodes[0]!.kind).toBe("unknown");
  });
});

describe("/api/search robustness", () => {
  it("limit=0 returns a small bounded result, not the default 20", async () => {
    const db = new Db(":memory:");
    db.migrate();
    // Seed >20 matching nodes so a falsy-zero default of 20 would be visible.
    for (let i = 0; i < 40; i++) {
      node(db, `src/a/widget_${i}`, `src/a/widget_${i}.ts`);
    }
    const app = buildTestApp(db);

    const res = await app.handle(
      new Request("http://localhost/api/search?q=widget&limit=0"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    // The falsy-zero bug returned up to 20; the floor-to-1 clamp caps at 1.
    expect(body.count).toBeLessThanOrEqual(1);
  });

  it("limit=abc falls back to the default 20", async () => {
    const db = new Db(":memory:");
    db.migrate();
    for (let i = 0; i < 40; i++) {
      node(db, `src/a/widget_${i}`, `src/a/widget_${i}.ts`);
    }
    const app = buildTestApp(db);

    const res = await app.handle(
      new Request("http://localhost/api/search?q=widget&limit=abc"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.count).toBe(20);
  });
});
