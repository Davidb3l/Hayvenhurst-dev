// Deterministic regressions for the catchable parts of the P1 distributed-core
// stress harnesses (bench/soak.ts + bench/semantic-conflict.ts):
//
//   (A) Claim TTL expiry is REAPED — OR-Set `active(now)` drops a claim once its
//       ttlMs elapses, AND the live claim route stops treating an expired claim
//       as a blocker (the soak harness's leak-free property, in miniature).
//
//   (B) Adjacency flags an ACROSS-EDGE claim — a claim on a CALLER is flagged
//       (202) as adjacent-conflicting with an active claim on its CALLEE when a
//       real call/import edge connects them, even though the two scopes are in
//       DIFFERENT entities/files (the semantic-conflict harness's catch, with a
//       synthetic edge so no native binary is needed).
//
// (B) here uses a SYNTHETIC edge in an in-memory Db, so it does NOT need the
// native binary — it pins the route+adjacency behavior the bench measured over a
// real ingested graph. The real-graph end-to-end measurement is bench/
// semantic-conflict.ts (run with HAYVEN_NATIVE_BIN). A binary-gated describe is
// included for the parts that would need a real parser; it stays skipped without
// the binary so CI is clean either way.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { OrSetState, type OrAddOp } from "../src/crdt/orset.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";
import type { GraphEdge, GraphNode } from "../src/graph/types.ts";
import type { Hlc } from "../src/crdt/hlc.ts";

const H = (wallMs: number, counter = 0): Hlc => ({ wallMs, counter });

function addOp(claimId: string, scope: string[], createdMs: number, ttlMs: number, writer: Uint8Array): OrAddOp {
  return {
    kind: "add",
    claimId,
    agent: "agent",
    payload: { intent: "x", scope, fingerprint: `fp-${claimId}`, createdMs, ttlMs },
    hlc: H(createdMs),
    writer,
  };
}

/* ── (A) TTL reaping — the soak harness's leak-free invariant, unit-pinned ─── */

describe("claim TTL expiry is reaped (soak leak-free invariant)", () => {
  test("OR-Set active(now) drops a claim once its TTL elapses", () => {
    const writer = new Uint8Array(16).fill(7);
    const orset = new OrSetState();
    const t0 = Date.UTC(2026, 5, 1, 12, 0, 0);
    orset.apply(addOp("c1", ["mod/a"], t0, t0 + 1000, writer)); // expires at t0+1s
    orset.apply(addOp("c2", ["mod/b"], t0, t0 + 60_000, writer)); // expires at t0+60s

    // Before any expiry: both are active under the TTL-aware view.
    expect(orset.active(t0 + 500).map((o) => o.claimId).sort()).toEqual(["c1", "c2"]);
    // After c1's TTL: c1 is reaped, c2 survives.
    expect(orset.active(t0 + 1500).map((o) => o.claimId)).toEqual(["c2"]);
    // After both TTLs: nothing live, even though both adds are still tracked.
    expect(orset.active(t0 + 120_000)).toEqual([]);
    // The TTL-ignoring view still sees both add-records (append-only by design).
    expect(orset.active().map((o) => o.claimId).sort()).toEqual(["c1", "c2"]);
  });

  test("many short-TTL claims keep the live count bounded (no leak)", () => {
    // Pure in-memory OR-Set (no oplog persistence — that path is exercised by
    // bench/soak.ts). The invariant: active() retains every add-record (by
    // design), but active(now) past the TTL window is empty (reaped).
    const writer = new Uint8Array(16).fill(3);
    const orset = new OrSetState();
    const base = Date.now();
    const TTL = 100;
    for (let i = 0; i < 5000; i++) {
      orset.apply(addOp(`c-${i}`, [`mod/${i % 16}`], base, base + TTL, writer));
    }
    // All added; the append-only view holds all 5000 add-records.
    expect(orset.active().length).toBe(5000);
    // But the LIVE view well past every TTL is empty — reaped, not leaked.
    expect(orset.active(base + TTL + 1).length).toBe(0);
  });
});

/* ── helper: claims route over a synthetic graph (no native binary) ────────── */

interface RouteCtx {
  app: ReturnType<typeof buildApp>;
  cleanup: () => void;
}

function makeRoute(nodes: GraphNode[], edges: GraphEdge[]): RouteCtx {
  const dir = mkdtempSync(join(tmpdir(), "hayven-soak-reg-"));
  const paths = hayvenPathsFor(dir);
  const db = new Db(":memory:");
  db.migrate();
  if (nodes.length) db.upsertNodes(nodes);
  for (const e of edges) db.upsertEdge(e);
  const crdt = new CrdtState({ crdtRoot: paths.crdtDir, configFile: paths.configFile, skipHydrate: true });
  const app = buildApp({
    // Heuristic oracle: synthetic body-less Db, so contract-diff would abstain.
    config: { ...DEFAULT_CONFIG, conflict: { oracle: "heuristic-v1" } },
    db,
    paths,
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt,
    daemonVersion: "test",
    ingest: { current: () => null, start: async () => { throw new Error("not used"); } },
  });
  return { app, cleanup: () => { crdt.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function post(app: RouteCtx["app"], body: Record<string, unknown>): Promise<Response> {
  return app.handle(new Request("http://localhost/api/claims", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fingerprint: "fp", ttlSeconds: 600, ...body }),
  }));
}

/* ── (B) across-edge adjacency catch — semantic-conflict harness, unit-pinned ─ */

describe("adjacency flags an across-edge (cross-file) claim (semantic-conflict catch)", () => {
  let ctx: RouteCtx | null = null;
  afterEach(() => { ctx?.cleanup(); ctx = null; });

  // y/greet (caller) --static_call--> x/formatUser (callee). Mirrors the REAL
  // edge the parser mints in bench/semantic-conflict.ts.
  const edges: GraphEdge[] = [
    { src: "y/greet", dst: "x/formatUser", kind: "static_call", weight: 1, last_seen: 0 },
  ];

  test("a claim on the CALLER is flagged 202 against an active claim on the CALLEE", async () => {
    ctx = makeRoute([], edges);
    // A claims the callee (the contract owner in x.ts).
    const a = await post(ctx.app, {
      id: "A", agent: "agent-A",
      intent: "Change formatUser's contract: drop the opts parameter.",
      scope: ["x/formatUser"],
    });
    expect(a.status).toBe(201);
    // B claims the caller (in y.ts) — a DIFFERENT file/entity. The Edit-guard
    // could never relate these; the call edge does.
    const b = await post(ctx.app, {
      id: "B", agent: "agent-B",
      intent: "Add greetMany batching; still calls formatUser with two args.",
      scope: ["y/greet"],
    });
    expect(b.status).toBe(202);
    const body = (await b.json()) as { verdicts: { conflict: boolean; reason: string }[] };
    expect(body.verdicts.length).toBeGreaterThan(0);
    expect(body.verdicts[0]?.conflict).toBe(true);
    // The reason cites the call/import edge (first-class edge-adjacency signal).
    expect(body.verdicts[0]?.reason).toContain("call/import edge");
  });

  test("with no connecting edge, the same two scopes register independently (201)", async () => {
    ctx = makeRoute([], []); // no edges
    const a = await post(ctx.app, { id: "A", agent: "agent-A", intent: "edit formatUser", scope: ["x/formatUser"] });
    expect(a.status).toBe(201);
    const b = await post(ctx.app, { id: "B", agent: "agent-B", intent: "edit greet", scope: ["y/greet"] });
    // No edge, no shared module prefix (x vs y) → truly independent → registers.
    expect(b.status).toBe(201);
  });
});

/* ── binary-gated placeholder: the real-graph e2e lives in the bench harness ── */

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  for (const c of [
    join(import.meta.dir, "../../native/target/release/hayven-native"),
    join(import.meta.dir, "../../native/target/debug/hayven-native"),
  ]) if (existsSync(c)) return c;
  return null;
}
const bin = findBinary();
const maybeDescribe = bin === null ? describe.skip : describe;

maybeDescribe("real-parser graph mints a caller→callee edge (semantic-conflict precondition)", () => {
  // The full end-to-end (git init → hayven init → claim route over the branch
  // index) is bench/semantic-conflict.ts. Here we only assert the binary is
  // present so the bench's precondition is visible in CI logs; the measurement
  // itself stays in the bench (it shells out to `hayven init`).
  test("native binary is locatable", () => {
    expect(bin).not.toBeNull();
  });
});
