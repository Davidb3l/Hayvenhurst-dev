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

interface ClaimDto {
  id: string;
  agent: string;
  intent: string;
  scope: string[];
  fingerprint: string;
  created: number;
  ttl: number;
  status: "active" | "expired";
}

interface ClaimsResponse {
  claims: ClaimDto[];
  total: number;
  active: number;
  expired: number;
}

function makeApp() {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-claims-"));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(":memory:");
  db.migrate();
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

async function postClaim(
  app: ReturnType<typeof buildApp>,
  body: { id: string; agent: string; intent: string; scope: string[]; fingerprint: string; ttlSeconds: number },
): Promise<Response> {
  return app.handle(
    new Request("http://localhost/api/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("/api/claims", () => {
  it("returns an empty board when no claims exist", async () => {
    const { app } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/claims"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClaimsResponse;
    expect(body).toEqual({ claims: [], total: 0, active: 0, expired: 0 });
  });

  it("returns active claims posted through the API and counts them correctly", async () => {
    // Before the Week 6 CRDT cutover (ARCHITECTURE.md §12/§14) this test
    // wrote rows straight into the SQL `claims` table and read them back via
    // GET. After the cutover GET reads from the OR-Set, so the seed must
    // also go through POST — that's the only path that updates both the
    // CRDT (source of truth) and the SQL cache.
    const { app } = makeApp();
    const res1 = await postClaim(app, {
      id: "claim_active",
      agent: "agent_3",
      intent: "Adding rate limiting to login flow",
      scope: ["auth/login_handler", "auth/validate_session"],
      fingerprint: "blake3:9c2d",
      ttlSeconds: 60,
    });
    expect(res1.status).toBe(201);

    const res = await app.handle(new Request("http://localhost/api/claims"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClaimsResponse;

    expect(body.total).toBe(1);
    expect(body.active).toBe(1);
    expect(body.expired).toBe(0);

    const byId = Object.fromEntries(body.claims.map((c) => [c.id, c]));
    expect(byId["claim_active"]?.status).toBe("active");
    expect(byId["claim_active"]?.scope).toEqual([
      "auth/login_handler",
      "auth/validate_session",
    ]);
    expect(byId["claim_active"]?.agent).toBe("agent_3");
  });

  it("derives `expired` status when the ttl has lapsed since the POST", async () => {
    // Smallest legal ttl is 1 second; we wait it out so the status flips.
    const { app } = makeApp();
    await postClaim(app, {
      id: "claim_brief",
      agent: "agent_x",
      intent: "Brief claim",
      scope: ["auth/login"],
      fingerprint: "blake3:1111",
      ttlSeconds: 1,
    });
    await new Promise((r) => setTimeout(r, 1100));
    const res = await app.handle(new Request("http://localhost/api/claims"));
    const body = (await res.json()) as ClaimsResponse;
    expect(body.expired).toBe(1);
    expect(body.active).toBe(0);
    expect(body.claims[0]?.status).toBe("expired");
  });
});
