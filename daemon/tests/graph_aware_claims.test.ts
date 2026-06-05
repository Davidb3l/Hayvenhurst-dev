// Tier 2.1 (graph-aware claim scoping) + Tier 2.2 (semantic / adjacency-based
// overlap detection). ROADMAP §"Tier 2".
//
// Two things under test:
//   2.1 — a claim's SUGGESTED scope includes the import/call neighbors of the
//         claimed ids (advisory; the registered scope is unchanged).
//   2.2 — two claims on ADJACENT (edge-connected) nodes are flagged as a SOFT
//         (202) conflict; two claims on UNRELATED nodes are NOT flagged
//         (independence preserved — the §16(4) non-negotiable).
//
// The pure-function cases use the stub `NeighborLookup` pattern from
// adjacency.test.ts. The route-level cases drive the REAL `POST /api/claims`
// over a real DB-backed graph (synthetic edges), pinning the HEURISTIC oracle
// the same way claims_conflict.test.ts does (the shipping default is
// contract-diff, which abstains on body-less synthetic nodes).
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  edgeAdjacency,
  isAdjacent,
  suggestScope,
  type NeighborLookup,
} from "../src/conflict/adjacency.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";
import type { GraphEdge } from "../src/graph/types.ts";

/** Build a neighbor lookup from an explicit adjacency map (stub pattern). */
function stubNeighbors(map: Record<string, string[]>): NeighborLookup {
  return (id) => map[id] ?? [];
}
const noNeighbors: NeighborLookup = () => [];

// ── 2.1 — suggestScope (pure) ────────────────────────────────────────────────

describe("Tier 2.1 — suggestScope includes import/call neighbors", () => {
  it("returns the claimed ids plus their one-hop graph neighbors", () => {
    // foo.ts imports/calls foo/types.ts and foo/util.ts — the unclaimed-but-
    // needed neighbors the dogfooding gap missed.
    const neighbors = stubNeighbors({
      "foo/foo": ["foo/types", "foo/util"],
    });
    const { claimed, suggested } = suggestScope(["foo/foo"], neighbors);
    expect(claimed).toEqual(["foo/foo"]);
    expect(suggested.sort()).toEqual(["foo/types", "foo/util"]);
  });

  it("excludes ids already in the claimed scope", () => {
    const neighbors = stubNeighbors({
      "a/x": ["a/y", "b/z"],
      "a/y": ["a/x"], // a/x is already claimed → not suggested
    });
    const { suggested } = suggestScope(["a/x", "a/y"], neighbors);
    expect(suggested).toEqual(["b/z"]);
  });

  it("suggests nothing when the claimed ids have no neighbors", () => {
    const { suggested } = suggestScope(["lonely/node"], noNeighbors);
    expect(suggested).toEqual([]);
  });
});

// ── 2.2 — edgeAdjacency vs module-prefix adjacency (pure) ────────────────────

describe("Tier 2.2 — edgeAdjacency is a first-class call/import signal", () => {
  it("is true when a real graph edge connects the two scopes", () => {
    const neighbors = stubNeighbors({ "auth/login/handler": ["auth/session/token"] });
    expect(edgeAdjacency(["auth/login/handler"], ["auth/session/token"], neighbors)).toBe(true);
  });

  it("detects the edge in the reverse direction too", () => {
    const neighbors = stubNeighbors({ "auth/session/token": ["auth/login/handler"] });
    expect(edgeAdjacency(["auth/login/handler"], ["auth/session/token"], neighbors)).toBe(true);
  });

  it("is FALSE for mere module co-location (no edge) — distinct from isAdjacent", () => {
    // Same module prefix, no edge: edgeAdjacency=false, isAdjacent=true.
    expect(edgeAdjacency(["auth/login/handler"], ["auth/login/validate"], noNeighbors)).toBe(false);
    expect(isAdjacent(["auth/login/handler"], ["auth/login/validate"], noNeighbors)).toBe(true);
  });

  it("is FALSE for genuinely unrelated scopes", () => {
    expect(edgeAdjacency(["auth/login/handler"], ["billing/invoice/create"], noNeighbors)).toBe(false);
  });
});

// ── Route-level: real POST /api/claims ───────────────────────────────────────

function makeApp(edges: GraphEdge[] = []) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-graph-aware-claims-"));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(":memory:");
  db.migrate();
  for (const e of edges) db.upsertEdge(e);
  const app = buildApp({
    db,
    // Pin the heuristic: synthetic edges have no real entity bodies, so the
    // shipping contract-diff default would abstain. (Same rationale as
    // claims_conflict.test.ts.)
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

describe("Tier 2.1 — POST /api/claims surfaces suggestedScope on 201", () => {
  it("includes the claimed id's import/call neighbors as suggestedScope", async () => {
    // payments/charge calls payments/types and payments/gateway.
    const { app } = makeApp([
      edge("payments/charge", "payments/types"),
      edge("payments/charge", "payments/gateway"),
    ]);
    const res = await post(app, {
      id: "charge_claim",
      agent: "a1",
      intent: "Rework the charge flow",
      scope: ["payments/charge"],
      ...base,
    });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { id: string; scope: string[]; suggestedScope?: string[] };
    // Registered scope is unchanged (SUGGEST, not auto-claim).
    expect(dto.scope).toEqual(["payments/charge"]);
    expect((dto.suggestedScope ?? []).sort()).toEqual(["payments/gateway", "payments/types"]);
  });

  it("omits suggestedScope when the claimed id has no neighbors", async () => {
    const { app } = makeApp(); // no edges
    const res = await post(app, {
      id: "lonely_claim",
      agent: "a1",
      intent: "Touch an isolated node",
      scope: ["isolated/node"],
      ...base,
    });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { suggestedScope?: string[] };
    expect(dto.suggestedScope).toBeUndefined();
  });
});

describe("Tier 2.2 — adjacency is a soft (202) conflict, independence preserved", () => {
  it("flags two claims on edge-connected nodes as a 202 (soft, force-able) conflict", async () => {
    const { app } = makeApp([edge("auth/login/handler", "auth/session/token")]);
    const first = await post(app, {
      id: "session_claim",
      agent: "a1",
      intent: "Change the session token validation contract",
      scope: ["auth/session/token"],
      ...base,
    });
    expect(first.status).toBe(201);

    const res = await post(app, {
      id: "login_claim",
      agent: "a2",
      intent: "Refactor login to use the new session token validation",
      scope: ["auth/login/handler"],
      ...base,
    });
    // SOFT conflict (202), NOT a hard 409 — never blocks, force-able.
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      verdicts: { conflict: boolean; reason: string }[];
    };
    expect(body.status).toBe("potential-conflict");
    expect(body.verdicts.length).toBeGreaterThan(0);
    expect(body.verdicts[0]?.conflict).toBe(true);
    // Tier 2.2: the reason names the call/import edge as the signal.
    expect(body.verdicts[0]?.reason).toContain("call/import edge");
  });

  it("does NOT flag two claims on UNRELATED nodes — registers freely (201)", async () => {
    const { app } = makeApp(); // no edges connecting anything
    const first = await post(app, {
      id: "billing_claim",
      agent: "a1",
      intent: "Invoice creation",
      scope: ["billing/invoice/create"],
      ...base,
    });
    expect(first.status).toBe(201);

    const res = await post(app, {
      id: "search_claim",
      agent: "a2",
      intent: "Build the search index",
      scope: ["search/index/build"],
      ...base,
    });
    // Truly-independent work is NEVER blocked.
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { id: string };
    expect(dto.id).toBe("search_claim");
  });
});
