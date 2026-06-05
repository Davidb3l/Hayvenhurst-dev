// QA consistency pass (INFO/LOW). Four small, non-breaking contract fixes:
//
//   1. GET /api/search — a present-but-effectively-empty `q` (e.g. punctuation
//      that sanitizes to nothing) returns 200 {hits:[],count:0}, NOT 400 and
//      NOT 500. A *missing* `q` still returns 400. FTS metachars never reach a
//      MATCH (no injection 500s).
//   2. /api/* 404 body shape is uniform: an unknown /api/* route and a 404 from
//      a real route both return {error, code} (Elysia's NOT_FOUND shape), not
//      the viewer fallthrough's old {error:"not found"}.
//   3. PUT /api/nodes/:id/body rejects oversized bodies (> 1 MiB) with 413
//      before they enter the CRDT/Merkle sync path.
//   4. `hayven neighbors` edge count == the DISTINCT (src,dst,kind) count — an
//      edge whose both ends are in the frontier is no longer double-counted.
//
// Routes are driven via app.handle(new Request("http://localhost/api/...")).
// NB: `localhost` is load-bearing — app.handle is hostname-sensitive (CLAUDE.md
// "Dev gotchas"); other hostnames 404 even on registered routes.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { walk } from "../src/cli/neighbors.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

function makeApp(seed?: (db: Db) => void) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-api-consistency-"));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(":memory:");
  db.migrate();
  seed?.(db);
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
  return { app, db };
}

function node(db: Db, id: string, file = `${id}.ts`) {
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

interface SearchResponse {
  query: string;
  count: number;
  hits: unknown[];
}

describe("GET /api/search — empty-query handling is consistent", () => {
  it("a MISSING `q` returns 400", async () => {
    const { app } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/search"));
    expect(res.status).toBe(400);
  });

  it("a present-but-empty `q` returns 200 with no results (not 400)", async () => {
    const { app } = makeApp((db) => node(db, "src/a/widget"));
    const res = await app.handle(new Request("http://localhost/api/search?q="));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.count).toBe(0);
    expect(body.hits).toEqual([]);
  });

  it("a punctuation-only `q` that FTS-sanitizes to empty returns 200, not 400/500", async () => {
    const { app } = makeApp((db) => node(db, "src/a/widget"));
    // `!@#` strips to nothing in escapeFtsQuery; previously 200 (vs 400 for
    // missing) — the inconsistency this fix resolves. Must never 500 on
    // metachars (FTS-injection safety).
    const res = await app.handle(
      new Request(`http://localhost/api/search?q=${encodeURIComponent("!@#")}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.count).toBe(0);
    expect(body.hits).toEqual([]);
  });

  it("FTS metachars (quotes, NEAR, prefix*) are safe — 200, never 500", async () => {
    const { app } = makeApp((db) => node(db, "src/a/widget"));
    for (const meta of ['" OR "', "widget*", "NEAR(a b)", '"unterminated', "((("]) {
      const res = await app.handle(
        new Request(`http://localhost/api/search?q=${encodeURIComponent(meta)}`),
      );
      expect(res.status).toBe(200);
    }
  });

  it("a real `q` still returns hits (no regression)", async () => {
    const { app } = makeApp((db) => node(db, "auth/loginHandler", "src/auth/login.ts"));
    const res = await app.handle(new Request("http://localhost/api/search?q=login"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ id: string }> };
    expect(body.hits.length).toBeGreaterThan(0);
  });
});

describe("/api/* 404 body shape is unified", () => {
  it("an unknown /api/* path and a matched-route-miss share the {error, code} shape", async () => {
    const { app } = makeApp();

    // (a) Unknown /api/* path — falls through to viewer's /* catch-all.
    //     Pre-fix this returned the viewer's {error:"not found"} shape.
    const unknown = await app.handle(new Request("http://localhost/api/totally-unknown"));
    expect(unknown.status).toBe(404);
    const unknownBody = (await unknown.json()) as { error?: string; code?: string };

    // (b) A matched-route-miss: an existing GET route hit with the wrong method
    //     → Elysia's own NOT_FOUND ({error, code}) via the server onError.
    const routeMiss = await app.handle(
      new Request("http://localhost/api/health", { method: "DELETE" }),
    );
    expect(routeMiss.status).toBe(404);
    const routeBody = (await routeMiss.json()) as { error?: string; code?: string };

    // Both bodies carry a string `error` and a string `code`.
    expect(typeof unknownBody.error).toBe("string");
    expect(typeof unknownBody.code).toBe("string");
    expect(typeof routeBody.error).toBe("string");
    expect(typeof routeBody.code).toBe("string");

    // The shapes match: identical key set AND identical body.
    expect(Object.keys(unknownBody).sort()).toEqual(Object.keys(routeBody).sort());
    expect(unknownBody).toEqual(routeBody);

    // And both are the unified {error:"NOT_FOUND", code:"NOT_FOUND"} shape,
    // NOT the old viewer fallthrough {error:"not found"}.
    expect(unknownBody).toEqual({ error: "NOT_FOUND", code: "NOT_FOUND" });
  });

  it("an unknown /api/* path never serves HTML (no SPA shell leak)", async () => {
    const { app } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/nope"));
    expect(res.status).toBe(404);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).not.toContain("text/html");
  });
});

describe("PUT /api/nodes/:id/body — oversized body is rejected", () => {
  async function putBody(app: ReturnType<typeof buildApp>, id: string, body: string): Promise<Response> {
    return app.handle(
      new Request(`http://localhost/api/nodes/${encodeURIComponent(id)}/body`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      }),
    );
  }

  it("a > 1 MiB body is rejected with 413 (before any CRDT write)", async () => {
    const id = "auth/loginHandler";
    const { app } = makeApp((db) => node(db, id, "src/auth/login.ts"));
    // 2 MiB body — well over the 1 MiB cap. Rejection happens before the wire
    // bridge / recordLww, so this test needs no native binary.
    const huge = "x".repeat(2 * 1024 * 1024);
    const res = await putBody(app, id, huge);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("too large");
  });

  it("a small body is NOT size-rejected (still hits the normal 400/404/200 path)", async () => {
    const { app } = makeApp((db) => node(db, "auth/loginHandler", "src/auth/login.ts"));
    // Unknown node → 404, proving a small body sails past the size gate (the
    // 413 cap is independent of the native-gated success path).
    const res = await putBody(app, "does/not/exist", "a normal body");
    expect(res.status).toBe(404);
  });
});

describe("hayven neighbors — edge count == distinct (src,dst,kind)", () => {
  it("an edge whose both ends are in the frontier is counted ONCE, not twice", () => {
    const db = new Db(":memory:");
    db.migrate();
    // a → b. With depth>=1 both a and b enter the frontier, so the a→b edge is
    // discovered as a's outgoing AND b's incoming. Pre-fix that emitted it
    // twice; the dedupe collapses it to one distinct edge.
    node(db, "src/a", "src/a.ts");
    node(db, "src/b", "src/b.ts");
    db.upsertEdge({ src: "src/a", dst: "src/b", kind: "static_call", weight: 1, last_seen: 0 });

    const graph = walk(db, "src/a", 2);
    db.close();

    const distinct = new Set(graph.edges.map((e) => `${e.src}\x00${e.dst}\x00${e.kind}`));
    expect(graph.edges.length).toBe(distinct.size);
    expect(graph.edges.length).toBe(1);
  });

  it("parallel edges of different kinds between the same pair are kept distinct", () => {
    const db = new Db(":memory:");
    db.migrate();
    node(db, "src/a", "src/a.ts");
    node(db, "src/b", "src/b.ts");
    db.upsertEdge({ src: "src/a", dst: "src/b", kind: "static_call", weight: 1, last_seen: 0 });
    db.upsertEdge({ src: "src/a", dst: "src/b", kind: "import", weight: 1, last_seen: 0 });

    const graph = walk(db, "src/a", 2);
    db.close();

    const distinct = new Set(graph.edges.map((e) => `${e.src}\x00${e.dst}\x00${e.kind}`));
    expect(graph.edges.length).toBe(distinct.size);
    // Two distinct kinds → two edges, each counted once.
    expect(graph.edges.length).toBe(2);
  });

  it("a larger graph: every reported edge is distinct", () => {
    const db = new Db(":memory:");
    db.migrate();
    for (const n of ["a", "b", "c", "d"]) node(db, `src/${n}`, `src/${n}.ts`);
    // A cycle + a fan — several edges whose both endpoints are reachable.
    db.upsertEdge({ src: "src/a", dst: "src/b", kind: "static_call", weight: 1, last_seen: 0 });
    db.upsertEdge({ src: "src/b", dst: "src/c", kind: "static_call", weight: 1, last_seen: 0 });
    db.upsertEdge({ src: "src/c", dst: "src/a", kind: "static_call", weight: 1, last_seen: 0 });
    db.upsertEdge({ src: "src/a", dst: "src/d", kind: "import", weight: 1, last_seen: 0 });

    const graph = walk(db, "src/a", 3);
    db.close();

    const distinct = new Set(graph.edges.map((e) => `${e.src}\x00${e.dst}\x00${e.kind}`));
    expect(graph.edges.length).toBe(distinct.size);
    expect(graph.edges.length).toBe(4);
  });
});
