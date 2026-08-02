/**
 * Project-addressed MUTATIONS on a shared multi-project daemon:
 *   1. The `x-hayven-project` header routes a mutating request (POST
 *      /api/claims) to THAT project's CRDT — not the primary's.
 *   2. A mutation carrying an explicit selector the daemon does NOT serve is
 *      REFUSED (404), never silently routed to the primary — the safety
 *      property behind `assertDaemonServesProject` (a stale alias must not
 *      write into the wrong project's op-log).
 *   3. A mutation with NO selector at all is REFUSED (400) on a multi-project
 *      daemon, rather than silently landing in whichever project happens to be
 *      primary. This used to route to the primary with only a log line, which
 *      is the same wrong-repo write as (2) with the evidence removed: a `claim`
 *      or `node body` meant for repo B entered repo A's op-log, and neither
 *      side ever saw an error. The refusal is lifted by any of: an
 *      `x-hayven-project` alias, a `?project=` selector, a verified
 *      `x-hayven-primary-root`, or the daemon serving exactly one project.
 *   4. READS are deliberately UNCHANGED: header selects, unknown falls back to
 *      the primary (multi_project.test.ts pins the `?project=` variant). A read
 *      answered from the wrong index is a wrong answer the caller can see and
 *      re-issue; a write is not recoverable, so only writes are refused.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import {
  buildMultiProjectApp,
  PRIMARY_ROOT_HEADER,
  type ServerDependencies,
} from "../src/daemon/server.ts";
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

  it("REFUSES (400) an un-addressed POST instead of writing it into the primary", async () => {
    const { app } = mkApp();
    const res = await postClaim(app, "claim_primary", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("?project=");
    // THE REGRESSION GUARD. A revert to "route to the primary and warn" turns
    // the status assertion red, but this is the assertion that states the actual
    // safety property: the un-addressed write reached NO project's op-log. It
    // fails whether the fall-through comes back as a 201, a 200, or silently.
    expect(await listClaims(app, "alpha")).toEqual([]);
    expect(await listClaims(app, "beta")).toEqual([]);
  });

  it("ACCEPTS an un-addressed POST when the daemon serves exactly ONE project", async () => {
    // Nothing to disambiguate, so the refusal must not fire — this is the case
    // `cli/_shared.ts` relies on when `/api/health` reports a bare `root` and
    // `projectHeader()` therefore has no alias to send.
    const app = buildMultiProjectApp({
      primary: "solo",
      projects: new Map<string, ServerDependencies>([["solo", depsFor()]]),
      logger: createLogger({ toFile: false, toStderr: false }),
      daemonVersion: "test",
    });
    const res = await postClaim(app, "claim_solo", {});
    expect(res.status).toBe(201);
    expect(await listClaims(app, "solo")).toEqual(["claim_solo"]);
  });

  it("ACCEPTS an un-addressed POST that proves the primary's root", async () => {
    const { app, projects } = mkApp();
    const res = await postClaim(app, "claim_primary", {
      [PRIMARY_ROOT_HEADER]: projects.get("alpha")!.paths.repoRoot,
    });
    expect(res.status).toBe(201);
    expect(await listClaims(app, "alpha")).toEqual(["claim_primary"]);
    expect(await listClaims(app, "beta")).toEqual([]);
  });

  it("REFUSES an un-addressed POST whose primary-root claim is stale", async () => {
    const { app, projects } = mkApp();
    const res = await postClaim(app, "claim_primary", {
      [PRIMARY_ROOT_HEADER]: projects.get("beta")!.paths.repoRoot, // not the primary
    });
    expect(res.status).toBe(400);
    expect(await listClaims(app, "alpha")).toEqual([]);
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
    // Seed through the PRIMARY explicitly. The mutation half of this contract
    // now requires a selector; the READ half deliberately does not, and that
    // asymmetry is what this test pins.
    await postClaim(app, "claim_primary", { "x-hayven-project": "alpha" });
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
