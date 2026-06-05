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

function makeApp() {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-server-"));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(":memory:");
  db.migrate();
  db.upsertNode({
    id: "auth/loginHandler",
    name: "loginHandler",
    qualified_name: "loginHandler",
    kind: "function",
    language: "typescript",
    file: "src/auth/login.ts",
    range: [1, 10],
    ast_hash: "abc",
    summary: "Handles user login",
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
  return { app, db };
}

describe("HTTP server", () => {
  it("/api/health returns ok", async () => {
    const { app } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/health"));
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe("test");
  });

  it("/api/nodes/:id returns 404 for unknown nodes", async () => {
    const { app } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/nodes/unknown"));
    expect(res.status).toBe(404);
  });

  it("/api/nodes/:id returns the node markdown", async () => {
    const { app } = makeApp();
    const res = await app.handle(
      new Request("http://localhost/api/nodes/" + encodeURIComponent("auth/loginHandler")),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markdown: string };
    expect(body.markdown).toContain("loginHandler");
  });

  it("/api/search returns FTS hits", async () => {
    const { app } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/search?q=login"));
    const body = (await res.json()) as { hits: Array<{ id: string }> };
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits[0]?.id).toBe("auth/loginHandler");
  });

  it("/api/stats returns counts", async () => {
    const { app } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/stats"));
    const body = (await res.json()) as { nodes: number };
    expect(body.nodes).toBe(1);
  });
});
