/**
 * Multi-project daemon: one app serving N projects, selected per request by
 * `?project=<alias>` (default = primary). Proves the AsyncLocalStorage facade in
 * `buildMultiProjectApp` routes each request to the RIGHT project's db — including
 * concurrent, interleaved requests (the ALS isolation that a module-level "current
 * project" variable would get wrong).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildMultiProjectApp, type ServerDependencies } from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

/** An in-memory db seeded with exactly `n` function nodes. */
function seedDb(n: number): Db {
  const db = new Db(":memory:");
  db.migrate();
  for (let i = 0; i < n; i++) {
    db.upsertNode({
      id: `mod/fn${i}`,
      name: `fn${i}`,
      qualified_name: `fn${i}`,
      kind: "function",
      language: "typescript",
      file: `src/f${i}.ts`,
      range: [1, 10],
      ast_hash: "h",
      last_seen: 0,
      logical_clock: 0,
    });
  }
  return db;
}

/** A single-project deps bundle over `db` (fresh tmp root so paths differ). */
function depsFor(db: Db): ServerDependencies {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-multi-"));
  return {
    db,
    config: DEFAULT_CONFIG,
    paths: hayvenPathsFor(repoRoot),
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used in this test");
      },
    },
  };
}

function mkMultiApp() {
  // alpha = 1 node, beta = 3 nodes — distinct counts so /api/stats reveals which
  // project answered.
  const projects = new Map<string, ServerDependencies>([
    ["alpha", depsFor(seedDb(1))],
    ["beta", depsFor(seedDb(3))],
  ]);
  return buildMultiProjectApp({
    primary: "alpha",
    projects,
    logger: createLogger({ toFile: false, toStderr: false }),
    daemonVersion: "test",
  });
}

async function statsNodes(app: ReturnType<typeof mkMultiApp>, query: string): Promise<number> {
  const res = await app.handle(new Request(`http://localhost/api/stats${query}`));
  const body = (await res.json()) as { nodes: number };
  return body.nodes;
}

describe("multi-project daemon routing", () => {
  it("routes ?project=<alias> to that project's db", async () => {
    const app = mkMultiApp();
    expect(await statsNodes(app, "?project=alpha")).toBe(1);
    expect(await statsNodes(app, "?project=beta")).toBe(3);
  });

  it("defaults to the primary project when ?project= is absent", async () => {
    const app = mkMultiApp();
    expect(await statsNodes(app, "")).toBe(1); // primary = alpha
  });

  it("falls back to the primary for an unknown project alias", async () => {
    const app = mkMultiApp();
    expect(await statsNodes(app, "?project=does-not-exist")).toBe(1);
  });

  it("isolates CONCURRENT interleaved requests (ALS, not a shared variable)", async () => {
    const app = mkMultiApp();
    // Fire many alpha/beta requests at once. If project selection leaked across
    // the shared async context, some responses would carry the wrong count.
    const jobs: Array<Promise<{ want: number; got: number }>> = [];
    for (let i = 0; i < 30; i++) {
      const alias = i % 2 === 0 ? "alpha" : "beta";
      const want = alias === "alpha" ? 1 : 3;
      jobs.push(statsNodes(app, `?project=${alias}`).then((got) => ({ want, got })));
    }
    const results = await Promise.all(jobs);
    for (const { want, got } of results) expect(got).toBe(want);
  });

  it("/api/health lists all projects and the primary", async () => {
    const app = mkMultiApp();
    const res = await app.handle(new Request("http://localhost/api/health"));
    const body = (await res.json()) as {
      primary: string;
      projects: Array<{ alias: string; root: string }>;
    };
    expect(body.primary).toBe("alpha");
    const aliases = body.projects.map((p) => p.alias).sort();
    expect(aliases).toEqual(["alpha", "beta"]);
    // Each project reports its own distinct root.
    expect(new Set(body.projects.map((p) => p.root)).size).toBe(2);
  });
});
