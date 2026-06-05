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

const MODULES = ["src/auth", "src/api", "src/db", "src/util", "src/web"];
const NODES_PER_MODULE = 120;
const TOTAL_NODES = MODULES.length * NODES_PER_MODULE; // 600
const TOTAL_EDGES = 1000;

function seedSyntheticGraph(): { app: ReturnType<typeof buildApp>; centerId: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-cluster-"));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(":memory:");
  db.migrate();

  // 600 nodes across 5 modules.
  for (let m = 0; m < MODULES.length; m++) {
    const mod = MODULES[m]!;
    for (let i = 0; i < NODES_PER_MODULE; i++) {
      const id = `${mod}/fn_${i}`;
      db.upsertNode({
        id,
        name: `fn_${i}`,
        qualified_name: id,
        kind: "function",
        language: "typescript",
        file: `${mod}/file_${i}.ts`,
        range: [1, 10],
        ast_hash: "h",
        last_seen: 0,
        logical_clock: 0,
      });
    }
  }

  // Deterministic 1000-edge web that fans out from the center node, then
  // sprays across module pairs so cluster=auto collapses to multiple
  // inter-module edges (one per directed pair).
  const centerId = `${MODULES[0]}/fn_0`;
  let edgesAdded = 0;

  // Fan: center → every other node in its module so all 120 land in depth=1.
  for (let i = 1; i < NODES_PER_MODULE && edgesAdded < TOTAL_EDGES; i++) {
    db.upsertEdge({
      src: centerId,
      dst: `${MODULES[0]}/fn_${i}`,
      kind: "static_call",
      weight: 1,
      last_seen: 0,
    });
    edgesAdded++;
  }

  // From the center, reach into each other module so cluster=auto sees them.
  for (let m = 1; m < MODULES.length && edgesAdded < TOTAL_EDGES; m++) {
    for (let i = 0; i < NODES_PER_MODULE && edgesAdded < TOTAL_EDGES; i++) {
      db.upsertEdge({
        src: centerId,
        dst: `${MODULES[m]}/fn_${i}`,
        kind: "static_call",
        weight: 1,
        last_seen: 0,
      });
      edgesAdded++;
    }
  }

  // Pad with intra-module edges so the total edge count is exactly 1000.
  // These collapse to self-loops when clustering and are dropped, but they
  // still cost in the function-level view.
  let pad = 0;
  while (edgesAdded < TOTAL_EDGES) {
    const m = pad % MODULES.length;
    const i = pad % NODES_PER_MODULE;
    const j = (pad + 1) % NODES_PER_MODULE;
    db.upsertEdge({
      src: `${MODULES[m]}/fn_${i}`,
      dst: `${MODULES[m]}/fn_${j}`,
      kind: "static_call",
      weight: 1,
      last_seen: 0,
    });
    edgesAdded++;
    pad++;
  }

  const app = buildApp({
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
  return { app, centerId };
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

describe("/api/neighbors/:id clustering", () => {
  it("cluster=off returns raw function-level nodes (all 600 reachable)", async () => {
    const { app, centerId } = seedSyntheticGraph();
    const body = await getNeighbors(app, centerId, "depth=2&cluster=off");
    expect(body.cluster_level).toBe("function");
    // The fan reaches every node in every module at depth=1.
    expect(body.nodes.length).toBe(TOTAL_NODES);
    expect(body.total_raw_nodes).toBe(TOTAL_NODES);
  });

  it("cluster=auto collapses to module-level when neighborhood exceeds 500 nodes", async () => {
    const { app, centerId } = seedSyntheticGraph();
    const body = await getNeighbors(app, centerId, "depth=2&cluster=auto");
    expect(body.cluster_level).toBe("module");
    expect(body.nodes.length).toBe(MODULES.length);
    // total_raw_nodes still reports the unclustered count for the viewer's
    // >2k degradation check.
    expect(body.total_raw_nodes).toBe(TOTAL_NODES);

    // Every module-node carries a count.
    for (const n of body.nodes) {
      expect(n.kind).toBe("module");
      expect(typeof n.count).toBe("number");
      expect(n.count).toBeGreaterThan(0);
    }
    expect(body.nodes.map((n) => n.id).sort()).toEqual([...MODULES].sort());

    // Edge weights are summed across collapsed function edges. Each non-center
    // module receives NODES_PER_MODULE (120) edges from the center module.
    const byPair = Object.fromEntries(body.edges.map((e) => [`${e.src}→${e.dst}`, e.weight]));
    for (let m = 1; m < MODULES.length; m++) {
      const key = `${MODULES[0]}→${MODULES[m]}`;
      expect(byPair[key]).toBe(NODES_PER_MODULE);
    }
    // No self-loops in module view (intra-module collapse).
    expect(body.edges.every((e) => e.src !== e.dst)).toBe(true);
  });

  it("cluster=module forces module-level even below the auto threshold", async () => {
    // Tiny graph: 3 nodes in one module, 2 nodes in another, one edge between.
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-cluster-small-"));
    const paths = hayvenPathsFor(repoRoot);
    const db = new Db(":memory:");
    db.migrate();
    for (let i = 0; i < 3; i++) {
      db.upsertNode({
        id: `src/a/fn_${i}`,
        name: `fn_${i}`,
        qualified_name: `src/a/fn_${i}`,
        kind: "function",
        language: "typescript",
        file: `src/a/f${i}.ts`,
        range: [1, 10],
        ast_hash: "h",
        last_seen: 0,
        logical_clock: 0,
      });
    }
    for (let i = 0; i < 2; i++) {
      db.upsertNode({
        id: `src/b/fn_${i}`,
        name: `fn_${i}`,
        qualified_name: `src/b/fn_${i}`,
        kind: "function",
        language: "typescript",
        file: `src/b/f${i}.ts`,
        range: [1, 10],
        ast_hash: "h",
        last_seen: 0,
        logical_clock: 0,
      });
    }
    db.upsertEdge({
      src: "src/a/fn_0",
      dst: "src/b/fn_0",
      kind: "static_call",
      weight: 7,
      last_seen: 0,
    });

    const app = buildApp({
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

    const body = await getNeighbors(app, "src/a/fn_0", "depth=1&cluster=module");
    expect(body.cluster_level).toBe("module");
    expect(body.nodes.map((n) => n.id).sort()).toEqual(["src/a", "src/b"]);
    expect(body.edges).toEqual([
      { src: "src/a", dst: "src/b", weight: 7, kind: "cluster" },
    ]);
    expect(body.total_raw_nodes).toBe(2);
  });

  it("cluster=auto on a tiny neighborhood stays at function-level", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-cluster-auto-small-"));
    const paths = hayvenPathsFor(repoRoot);
    const db = new Db(":memory:");
    db.migrate();
    db.upsertNode({
      id: "src/a/fn_0",
      name: "fn_0",
      qualified_name: "src/a/fn_0",
      kind: "function",
      language: "typescript",
      file: "src/a/f0.ts",
      range: [1, 10],
      ast_hash: "h",
      last_seen: 0,
      logical_clock: 0,
    });

    const app = buildApp({
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
    const body = await getNeighbors(app, "src/a/fn_0", "depth=1&cluster=auto");
    expect(body.cluster_level).toBe("function");
    expect(body.nodes.length).toBe(1);
  });

  it("scope=<prefix> filters nodes to only those inside the prefix", async () => {
    const { app, centerId } = seedSyntheticGraph();
    // Without scope: cluster=off pulls all 600 nodes.
    // With scope=src/auth: only that module's 120 nodes survive, and only
    // edges where both endpoints fall inside the scope are kept.
    const body = await getNeighbors(
      app,
      centerId,
      "depth=2&cluster=off&scope=src/auth",
    );
    expect(body.cluster_level).toBe("function");
    expect(body.nodes.length).toBe(NODES_PER_MODULE);
    expect(body.nodes.every((n) => n.id.startsWith("src/auth/"))).toBe(true);
    expect(
      body.edges.every(
        (e) => e.src.startsWith("src/auth/") && e.dst.startsWith("src/auth/"),
      ),
    ).toBe(true);
    // total_raw_nodes reflects the post-scope count, not the unfiltered one.
    expect(body.total_raw_nodes).toBe(NODES_PER_MODULE);
  });

  it("scope anchors on path boundary (does not match prefixes like `authentication`)", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-scope-anchor-"));
    const paths = hayvenPathsFor(repoRoot);
    const db = new Db(":memory:");
    db.migrate();
    db.upsertNode({
      id: "auth/x",
      name: "x",
      qualified_name: "x",
      kind: "function",
      language: "typescript",
      file: "src/auth/file.ts",
      range: [1, 5],
      ast_hash: "h",
      last_seen: 0,
      logical_clock: 0,
    });
    db.upsertNode({
      id: "authentication/y",
      name: "y",
      qualified_name: "y",
      kind: "function",
      language: "typescript",
      file: "src/authentication/file.ts",
      range: [1, 5],
      ast_hash: "h",
      last_seen: 0,
      logical_clock: 0,
    });
    db.upsertEdge({
      src: "auth/x",
      dst: "authentication/y",
      kind: "static_call",
      weight: 1,
      last_seen: 0,
    });

    const app = buildApp({
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

    const body = await getNeighbors(app, "auth/x", "depth=1&cluster=off&scope=auth");
    expect(body.nodes.map((n) => n.id).sort()).toEqual(["auth/x"]);
    // The edge to authentication/y must be dropped because the dst is out of scope.
    expect(body.edges.length).toBe(0);
  });
});
