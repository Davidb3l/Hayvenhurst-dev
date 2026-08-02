/**
 * E11 — does the multi-project request pin SURVIVE an `await` inside a handler?
 *
 * `buildMultiProjectApp`'s `onRequest` selects the request's project with
 * `AsyncLocalStorage.enterWith()`, not `run()`. The repo's only prior
 * concurrency cover (`multi_project.test.ts`) drives a fully SYNCHRONOUS
 * handler, so it cannot see the case that actually matters: a route like
 * `routes/claims.ts` awaits an oracle and only THEN writes to `deps.crdt` /
 * `deps.db`. If the pin were lost (or worse, replaced by a concurrent request's
 * project) across that await, a claim would land in the WRONG project's op-log
 * with no error at all.
 *
 * This test drives an ASYNC route (`GET /api/context/...` → awaits) plus a
 * direct ALS harness that mimics the same shape, under heavy interleaving.
 */
import { describe, expect, it } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Elysia } from "elysia";

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

function depsFor(db: Db): ServerDependencies {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-als-"));
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

describe("E11: project pinning across an await", () => {
  it("keeps the pin across an await under interleaved concurrent requests (raw ALS shape)", async () => {
    // Mirrors `buildMultiProjectApp` exactly: enterWith in onRequest, then an
    // async handler that reads the store BEFORE and AFTER a real await.
    const als = new AsyncLocalStorage<{ name: string }>();
    const app = new Elysia()
      .onRequest(({ request }) => {
        als.enterWith({ name: new URL(request.url).searchParams.get("p") ?? "primary" });
        return undefined;
      })
      .get("/async", async () => {
        const before = als.getStore()?.name ?? "none";
        await new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * 5)));
        const mid = als.getStore()?.name ?? "none";
        await Promise.resolve();
        const after = als.getStore()?.name ?? "none";
        return { before, mid, after };
      });

    const jobs: Array<Promise<void>> = [];
    const bad: string[] = [];
    for (let i = 0; i < 60; i++) {
      const want = i % 2 === 0 ? "alpha" : "beta";
      jobs.push(
        app
          .handle(new Request(`http://localhost/async?p=${want}`))
          .then((r) => r.json() as Promise<{ before: string; mid: string; after: string }>)
          .then((r) => {
            if (r.before !== want || r.mid !== want || r.after !== want) {
              bad.push(`want=${want} got=${JSON.stringify(r)}`);
            }
          }),
      );
    }
    await Promise.all(jobs);
    expect(bad).toEqual([]);
  });

  it("lands an interleaved WRITE in the right project's op-log (POST /api/claims)", async () => {
    // The write that matters: `POST /api/claims` is an async handler whose
    // `deps.crdt.applyOr(...)` / `deps.db.handle` writes happen AFTER the body
    // has been awaited. A lost or swapped pin here puts a claim into the WRONG
    // project's op-log and SQL cache with no error anywhere.
    const projects = new Map<string, ServerDependencies>([
      ["alpha", depsFor(seedDb(1))],
      ["beta", depsFor(seedDb(7))],
    ]);
    const app = buildMultiProjectApp({
      primary: "alpha",
      projects,
      logger: createLogger({ toFile: false, toStderr: false }),
      daemonVersion: "test",
    });

    const post = (alias: string, id: string): Promise<Response> =>
      app.handle(
        new Request(`http://localhost/api/claims?project=${alias}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id,
            agent: `agent-${alias}`,
            intent: "test",
            // Distinct scopes so no claim ever overlaps/adjoins another (which
            // would turn a 201 into a 409/202 and mask the routing question).
            scope: [`${alias}/${id}`],
            fingerprint: "f",
            ttlSeconds: 600,
          }),
        }),
      );

    const jobs: Array<Promise<Response>> = [];
    for (let i = 0; i < 30; i++) {
      jobs.push(post("alpha", `a${i}`));
      jobs.push(post("beta", `b${i}`));
    }
    const responses = await Promise.all(jobs);
    for (const r of responses) expect(r.status).toBe(201);

    const idsIn = async (alias: string): Promise<string[]> => {
      const res = await app.handle(new Request(`http://localhost/api/claims?project=${alias}`));
      const body = (await res.json()) as { claims: Array<{ id: string }> };
      return body.claims.map((c) => c.id).sort();
    };

    // Every `a*` claim must be in alpha and NOWHERE else; likewise `b*` in beta.
    const alpha = await idsIn("alpha");
    const beta = await idsIn("beta");
    expect(alpha.every((id) => id.startsWith("a"))).toBe(true);
    expect(beta.every((id) => id.startsWith("b"))).toBe(true);
    expect(alpha).toHaveLength(30);
    expect(beta).toHaveLength(30);
  });
});
