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
import type { GraphEdge } from "../src/graph/types.ts";

function makeApp(edges: GraphEdge[] = []) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-claims-conflict-"));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(":memory:");
  db.migrate();
  for (const e of edges) db.upsertEdge(e);
  const app = buildApp({
    db,
    // These Layer-C cases exercise the HEURISTIC oracle's adjacency-conflict
    // behavior over SYNTHETIC edges with no real entity bodies. The shipping
    // default oracle is now `contract-diff` (config/defaults.ts), which reads REAL
    // bodies and would abstain on this body-less synthetic Db — so we pin the
    // heuristic explicitly here. (The real-body contract-diff behavior is measured
    // in conflict_rate_contractdiff.test.ts.)
    config: { ...DEFAULT_CONFIG, conflict: { oracle: "heuristic-v1" } },
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

interface ClaimBody {
  id: string;
  agent: string;
  intent: string;
  scope: string[];
  fingerprint: string;
  ttlSeconds: number;
  force?: boolean;
}

function post(app: ReturnType<typeof buildApp>, body: ClaimBody): Promise<Response> {
  return app.handle(
    new Request("http://localhost/api/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const edge = (src: string, dst: string): GraphEdge => ({
  src,
  dst,
  kind: "static_call",
  weight: 1,
  last_seen: 0,
});

const base = { fingerprint: "blake3:00", ttlSeconds: 600 } as const;

describe("POST /api/claims — Layer A overlap (409)", () => {
  it("rejects an incoming scope that intersects an active claim's scope", async () => {
    const { app } = makeApp();
    const first = await post(app, {
      id: "c1",
      agent: "a1",
      intent: "Work on the login handler",
      scope: ["auth/login/handler", "auth/login/validate"],
      ...base,
    });
    expect(first.status).toBe(201);

    const res = await post(app, {
      id: "c2",
      agent: "a2",
      intent: "Also touch login validate",
      scope: ["auth/login/validate", "auth/login/extra"],
      ...base,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      conflictingClaimId: string;
      overlappingEntities: string[];
    };
    expect(body.conflictingClaimId).toBe("c1");
    expect(body.overlappingEntities).toEqual(["auth/login/validate"]);
  });
});

describe("POST /api/claims — Layer C adjacency + conflict (202)", () => {
  // A graph edge connects the two scopes; intents share identifier tokens, so
  // the HeuristicOracle flags a conflict.
  const edges = [edge("auth/login/handler", "auth/session/token")];

  it("returns 202 and does NOT register when an adjacent claim conflicts", async () => {
    const { app } = makeApp(edges);
    await post(app, {
      id: "session_claim",
      agent: "a1",
      intent: "Change the session token validation contract",
      scope: ["auth/session/token"],
      ...base,
    });

    const res = await post(app, {
      id: "login_claim",
      agent: "a2",
      intent: "Refactor login to use the new session token validation",
      scope: ["auth/login/handler"],
      ...base,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; verdicts: { conflict: boolean }[] };
    expect(body.status).toBe("potential-conflict");
    expect(body.verdicts.length).toBeGreaterThan(0);
    expect(body.verdicts[0]?.conflict).toBe(true);

    // Not registered: only the first claim is on the board.
    const list = await app.handle(new Request("http://localhost/api/claims"));
    const board = (await list.json()) as { claims: { id: string }[] };
    expect(board.claims.map((c) => c.id)).toEqual(["session_claim"]);
  });

  it("registers (201) with force:true and records the overridden verdict for audit", async () => {
    const { app } = makeApp(edges);
    await post(app, {
      id: "session_claim",
      agent: "a1",
      intent: "Change the session token validation contract",
      scope: ["auth/session/token"],
      ...base,
    });

    const res = await post(app, {
      id: "login_claim",
      agent: "a2",
      intent: "Refactor login to use the new session token validation",
      scope: ["auth/login/handler"],
      force: true,
      ...base,
    });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as {
      id: string;
      overriddenVerdicts?: { conflict: boolean; oracle: string }[];
    };
    expect(dto.id).toBe("login_claim");
    expect(dto.overriddenVerdicts?.length).toBeGreaterThan(0);
    expect(dto.overriddenVerdicts?.[0]?.oracle).toBe("heuristic-v1");

    // Both claims now on the board; the audit trail survives on GET.
    const list = await app.handle(new Request("http://localhost/api/claims"));
    const board = (await list.json()) as {
      claims: { id: string; overriddenVerdicts?: unknown[] }[];
    };
    expect(board.claims.map((c) => c.id).sort()).toEqual(["login_claim", "session_claim"]);
    const login = board.claims.find((c) => c.id === "login_claim");
    expect(login?.overriddenVerdicts?.length).toBeGreaterThan(0);
  });
});

describe("POST /api/claims — non-adjacent (201)", () => {
  it("registers normally when the scope is neither overlapping nor adjacent", async () => {
    const { app } = makeApp(); // no edges
    await post(app, {
      id: "billing_claim",
      agent: "a1",
      intent: "Invoice creation",
      scope: ["billing/invoice/create"],
      ...base,
    });

    const res = await post(app, {
      id: "search_claim",
      agent: "a2",
      intent: "Build the search index",
      scope: ["search/index/build"],
      ...base,
    });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { id: string; overriddenVerdicts?: unknown[] };
    expect(dto.id).toBe("search_claim");
    expect(dto.overriddenVerdicts).toBeUndefined();
  });
});
