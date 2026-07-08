/**
 * Project-addressed MUTATIONS on a shared multi-project daemon:
 *   1. The `x-hayven-project` header routes a mutating request (POST
 *      /api/claims) to THAT project's CRDT — not the primary's.
 *   2. A mutation carrying an explicit selector the daemon does NOT serve is
 *      REFUSED (404), never silently routed to the primary — the safety
 *      property behind `assertDaemonServesProject` (a stale alias must not
 *      write into the wrong project's op-log).
 *   3. Reads keep the legacy behavior: header selects, unknown falls back to
 *      the primary (multi_project.test.ts pins the `?project=` variant).
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

function depsFor(): ServerDependencies {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-hdr-"));
  const db = new Db(":memory:");
  db.migrate();
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

function mkApp() {
  const projects = new Map<string, ServerDependencies>([
    ["alpha", depsFor()],
    ["beta", depsFor()],
  ]);
  const app = buildMultiProjectApp({
    primary: "alpha",
    projects,
    logger: createLogger({ toFile: false, toStderr: false }),
    daemonVersion: "test",
  });
  return { app, projects };
}

function postClaim(app: ReturnType<typeof mkApp>["app"], id: string, headers: Record<string, string>) {
  return app.handle(
    new Request("http://localhost/api/claims", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        id,
        agent: "test",
        intent: "routing test",
        scope: [`scope/${id}`],
        fingerprint: "test",
        ttlSeconds: 60,
      }),
    }),
  );
}

async function listClaims(
  app: ReturnType<typeof mkApp>["app"],
  alias: string,
): Promise<string[]> {
  const res = await app.handle(
    new Request(`http://localhost/api/claims?project=${alias}`),
  );
  const body = (await res.json()) as { claims: Array<{ id: string }> };
  return body.claims.map((c) => c.id);
}

describe("x-hayven-project mutation routing", () => {
  it("routes a POST to the header-selected project's CRDT, not the primary", async () => {
    const { app } = mkApp();
    const res = await postClaim(app, "claim_beta", { "x-hayven-project": "beta" });
    expect(res.status).toBe(201);
    expect(await listClaims(app, "beta")).toEqual(["claim_beta"]);
    expect(await listClaims(app, "alpha")).toEqual([]); // primary untouched
  });

  it("routes an un-addressed POST to the primary (unchanged default)", async () => {
    const { app } = mkApp();
    const res = await postClaim(app, "claim_primary", {});
    expect(res.status).toBe(201);
    expect(await listClaims(app, "alpha")).toEqual(["claim_primary"]);
    expect(await listClaims(app, "beta")).toEqual([]);
  });

  it("REFUSES (404) a mutation addressed to a project it does not serve", async () => {
    const { app } = mkApp();
    const res = await postClaim(app, "claim_stale", { "x-hayven-project": "gone" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("gone");
    // CRITICAL: the refused mutation reached NO project's CRDT.
    expect(await listClaims(app, "alpha")).toEqual([]);
    expect(await listClaims(app, "beta")).toEqual([]);
  });

  it("REFUSES (404) an unknown ?project= selector on a DELETE", async () => {
    const { app } = mkApp();
    const res = await app.handle(
      new Request("http://localhost/api/claims/whatever?project=gone", { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("gone");
  });

  it("a READ with an unknown selector still falls back to the primary", async () => {
    const { app } = mkApp();
    await postClaim(app, "claim_primary", {});
    const res = await app.handle(
      new Request("http://localhost/api/claims", {
        headers: { "x-hayven-project": "gone" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claims: Array<{ id: string }> };
    expect(body.claims.map((c) => c.id)).toEqual(["claim_primary"]);
  });

  it("a READ with a known header selects that project", async () => {
    const { app } = mkApp();
    await postClaim(app, "claim_beta", { "x-hayven-project": "beta" });
    const res = await app.handle(
      new Request("http://localhost/api/claims", {
        headers: { "x-hayven-project": "beta" },
      }),
    );
    const body = (await res.json()) as { claims: Array<{ id: string }> };
    expect(body.claims.map((c) => c.id)).toEqual(["claim_beta"]);
  });
});
