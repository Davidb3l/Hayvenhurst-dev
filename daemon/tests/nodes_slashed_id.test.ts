/**
 * Agent-ergonomics regression: entity ids contain `/` (e.g. `conflict/oracle`).
 *
 * `GET /api/nodes/:id` and `GET /api/neighbors/:id` must resolve a slashed id
 * passed BOTH raw on the path (`…/conflict/oracle`) AND url-encoded
 * (`…/conflict%2Foracle`) — the raw shape is what an agent or human naturally
 * types into curl, and used to 404 because the slash path-split, making the
 * graph API look dead. Unknown ids return a helpful hinting 404.
 *
 * NB the Elysia gotcha (CLAUDE.md): `app.handle` needs hostname `localhost`,
 * NOT `x`/`to`, or routes 404 spuriously.
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

interface NodeResponse {
  node: { id: string; name: string };
  neighbors: { callers: unknown[]; callees: unknown[] };
  markdown: string;
}

interface NeighborResponse {
  center: string;
  nodes: Array<{ id: string; kind: string }>;
}

function buildTestApp(db: Db) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-slashid-"));
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

function seed(): Db {
  const db = new Db(":memory:");
  db.migrate();
  // A multi-segment id and a deeper one, plus a single-segment id.
  node(db, "conflict/oracle", "src/conflict/oracle.ts");
  node(db, "graph/interact/attachPanZoom", "src/graph/interact.ts");
  node(db, "loner", "src/loner.ts");
  return db;
}

describe("/api/nodes/:id resolves slashed ids raw + encoded", () => {
  it("resolves a raw slashed id (the agent-friendly path)", async () => {
    const app = buildTestApp(seed());
    const res = await app.handle(
      new Request("http://localhost/api/nodes/conflict/oracle"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as NodeResponse;
    expect(body.node.id).toBe("conflict/oracle");
  });

  it("resolves a url-encoded slashed id (the viewer/CLI path)", async () => {
    const app = buildTestApp(seed());
    const res = await app.handle(
      new Request("http://localhost/api/nodes/conflict%2Foracle"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as NodeResponse;
    expect(body.node.id).toBe("conflict/oracle");
  });

  it("raw and encoded return the SAME node", async () => {
    const app = buildTestApp(seed());
    const raw = (await (
      await app.handle(new Request("http://localhost/api/nodes/conflict/oracle"))
    ).json()) as NodeResponse;
    const enc = (await (
      await app.handle(
        new Request("http://localhost/api/nodes/conflict%2Foracle"),
      )
    ).json()) as NodeResponse;
    expect(raw.node).toEqual(enc.node);
    expect(raw.markdown).toEqual(enc.markdown);
  });

  it("resolves a deeper 3-segment raw id", async () => {
    const app = buildTestApp(seed());
    const res = await app.handle(
      new Request(
        "http://localhost/api/nodes/graph/interact/attachPanZoom",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as NodeResponse;
    expect(body.node.id).toBe("graph/interact/attachPanZoom");
  });

  it("still resolves a slash-free id", async () => {
    const app = buildTestApp(seed());
    const res = await app.handle(
      new Request("http://localhost/api/nodes/loner"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as NodeResponse;
    expect(body.node.id).toBe("loner");
  });

  it("unknown id returns a helpful hinting 404 (not a bare not-found)", async () => {
    const app = buildTestApp(seed());
    for (const path of [
      "http://localhost/api/nodes/does/not/exist",
      "http://localhost/api/nodes/nope",
      "http://localhost/api/nodes/does%2Fnot%2Fexist",
    ]) {
      const res = await app.handle(new Request(path));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; hint?: string };
      expect(body.error).toBe("node not found");
      expect(typeof body.hint).toBe("string");
      expect(body.hint).toContain("/");
    }
  });
});

describe("/api/neighbors/:id resolves slashed ids raw + encoded", () => {
  it("resolves a raw slashed center id", async () => {
    const app = buildTestApp(seed());
    const res = await app.handle(
      new Request(
        "http://localhost/api/neighbors/conflict/oracle?depth=0&cluster=off",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as NeighborResponse;
    expect(body.center).toBe("conflict/oracle");
    expect(body.nodes.some((n) => n.id === "conflict/oracle")).toBe(true);
    // Resolved (known) node, not an `unknown` stub.
    expect(
      body.nodes.find((n) => n.id === "conflict/oracle")?.kind,
    ).toBe("function");
  });

  it("resolves a url-encoded slashed center id", async () => {
    const app = buildTestApp(seed());
    const res = await app.handle(
      new Request(
        "http://localhost/api/neighbors/conflict%2Foracle?depth=0&cluster=off",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as NeighborResponse;
    expect(body.center).toBe("conflict/oracle");
    expect(
      body.nodes.find((n) => n.id === "conflict/oracle")?.kind,
    ).toBe("function");
  });

  it("raw and encoded center ids return the same center", async () => {
    const app = buildTestApp(seed());
    const raw = (await (
      await app.handle(
        new Request(
          "http://localhost/api/neighbors/conflict/oracle?depth=0&cluster=off",
        ),
      )
    ).json()) as NeighborResponse;
    const enc = (await (
      await app.handle(
        new Request(
          "http://localhost/api/neighbors/conflict%2Foracle?depth=0&cluster=off",
        ),
      )
    ).json()) as NeighborResponse;
    expect(raw.center).toBe(enc.center);
    expect(raw.nodes).toEqual(enc.nodes);
  });

  it("still handles the `*` whole-graph sentinel", async () => {
    const app = buildTestApp(seed());
    const res = await app.handle(
      new Request("http://localhost/api/neighbors/*?depth=1&cluster=off"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as NeighborResponse;
    // Seeded 3 nodes; `*` seeds them all, none is a literal `*` stub.
    expect(body.nodes.some((n) => n.id === "*")).toBe(false);
    expect(body.nodes.length).toBeGreaterThanOrEqual(3);
  });
});
