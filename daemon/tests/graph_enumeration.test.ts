/**
 * ROADMAP Tier 1.2 + Tier 3: exhaustive enumeration + transitive blast radius.
 *
 * Seeds a small in-memory graph (nodes + import/call edges) and asserts:
 *   - `importers` returns ALL importers (not capped to a ranked top-N).
 *   - `refs`      returns callers ∪ importers, complete.
 *   - `impact`    returns the transitive dependent set with correct depths AND
 *                 terminates on a cycle.
 * Both the pure helpers (`db/graph_walk.ts`) and the HTTP routes
 * (`/api/importers|refs|impact`) are exercised.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { EdgeKind } from "../src/graph/types.ts";
import { Db } from "../src/db/queries.ts";
import {
  impactOf,
  importersOf,
  MAX_IMPACT_DEPTH,
  refsOf,
  refsSummary,
} from "../src/db/graph_walk.ts";
import { buildApp } from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

function node(db: Db, id: string) {
  db.upsertNode({
    id,
    name: id.split("/").pop() ?? id,
    qualified_name: id,
    kind: "function",
    language: "typescript",
    file: `${id}.ts`,
    range: [1, 10],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

function edge(db: Db, src: string, dst: string, kind: EdgeKind) {
  db.upsertEdge({ src, dst, kind, weight: 1, last_seen: 0 });
}

function weightedEdge(
  db: Db,
  src: string,
  dst: string,
  kind: EdgeKind,
  weight: number,
) {
  db.upsertEdge({ src, dst, kind, weight, last_seen: 0 });
}

/**
 * Refactor fixture (the VirixiaField gap): `refactorTarget` is called by THREE
 * caller entities, but one of them (`heavyCaller`) calls it 4 times — so the
 * caller-entity count (3) is DISTINCT from the textual call-site count
 * (4 + 1 + 1 = 6). This is exactly the 22-callers-vs-29-call-sites mismatch a
 * signature-change refactor must see.
 */
function seedRefactor(db: Db) {
  db.migrate();
  node(db, "refactorTarget");
  for (const c of ["heavyCaller", "lightA", "lightB", "modImporter"]) node(db, c);
  weightedEdge(db, "heavyCaller", "refactorTarget", "static_call", 4);
  weightedEdge(db, "lightA", "refactorTarget", "static_call", 1);
  weightedEdge(db, "lightB", "refactorTarget", "static_call", 1);
  weightedEdge(db, "modImporter", "refactorTarget", "import", 1);
}

function buildTestApp(db: Db) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-graphenum-"));
  const paths = hayvenPathsFor(repoRoot);
  return buildApp({
    db,
    config: DEFAULT_CONFIG,
    paths,
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used");
      },
    },
  });
}

/**
 * Fixture graph. `target` is imported by 5 modules and called by 2 callers, and
 * sits at the bottom of a transitive call chain with a cycle in it.
 *
 *   import edges  : imp0..imp4 --import--> target            (5 importers)
 *   call edges    : c1 --static_call--> target               (direct caller)
 *                   c2 --static_call--> target               (direct caller)
 *                   c1a --static_call--> c1                  (depth-2 of target)
 *                   c1a1 --static_call--> c1a                (depth-3 of target)
 *   cycle         : cyc_a -> cyc_b -> cyc_a (and cyc_b -> target)
 */
function seed(db: Db) {
  db.migrate();
  node(db, "target");
  for (let i = 0; i < 5; i++) {
    node(db, `imp${i}`);
    edge(db, `imp${i}`, "target", "import");
  }
  for (const c of ["c1", "c2", "c1a", "c1a1", "cyc_a", "cyc_b"]) node(db, c);
  edge(db, "c1", "target", "static_call");
  edge(db, "c2", "target", "static_call");
  edge(db, "c1a", "c1", "static_call");
  edge(db, "c1a1", "c1a", "static_call");
  // Cycle: cyc_a <-> cyc_b, with cyc_b also a (transitive) dependent of target.
  edge(db, "cyc_b", "target", "static_call");
  edge(db, "cyc_a", "cyc_b", "static_call");
  edge(db, "cyc_b", "cyc_a", "static_call");
}

describe("graph_walk helpers (exhaustive enumeration)", () => {
  it("importersOf returns ALL importers, not a ranked top-N", () => {
    const db = new Db(":memory:");
    seed(db);
    const imps = importersOf(db, "target").map((e) => e.src);
    expect(imps).toEqual(["imp0", "imp1", "imp2", "imp3", "imp4"]);
    // It only counts import edges, never call edges.
    expect(importersOf(db, "target").every((e) => e.kind === "import")).toBe(true);
  });

  it("refsOf returns callers ∪ importers, complete", () => {
    const db = new Db(":memory:");
    seed(db);
    const refs = refsOf(db, "target");
    const callers = refs.filter((r) => r.via === "call").map((r) => r.id).sort();
    const importers = refs.filter((r) => r.via === "import").map((r) => r.id).sort();
    expect(callers).toEqual(["c1", "c2", "cyc_b"]);
    expect(importers).toEqual(["imp0", "imp1", "imp2", "imp3", "imp4"]);
    // Total = union of both, nothing dropped.
    expect(refs.length).toBe(callers.length + importers.length);
  });

  it("impactOf returns the transitive dependent set with correct depths", () => {
    const db = new Db(":memory:");
    seed(db);
    const res = impactOf(db, "target");
    const byId = new Map(res.hits.map((h) => [h.id, h.depth]));
    // Direct dependents (depth 1): the 5 importers, c1, c2, cyc_b.
    expect(byId.get("c1")).toBe(1);
    expect(byId.get("c2")).toBe(1);
    expect(byId.get("cyc_b")).toBe(1);
    expect(byId.get("imp0")).toBe(1);
    // Transitive call chain: c1a (depth 2), c1a1 (depth 3).
    expect(byId.get("c1a")).toBe(2);
    expect(byId.get("c1a1")).toBe(3);
    // cyc_a is reachable only through the cycle cyc_b->cyc_a, at depth 2.
    expect(byId.get("cyc_a")).toBe(2);
    // Root excluded.
    expect(byId.has("target")).toBe(false);
    // Total distinct dependents.
    expect(res.hits.length).toBe(5 /*imp*/ + 3 /*c1,c2,cyc_b*/ + 2 /*c1a,c1a1*/ + 1 /*cyc_a*/);
  });

  it("impactOf terminates on a cycle (does not loop forever)", () => {
    const db = new Db(":memory:");
    db.migrate();
    node(db, "a");
    node(db, "b");
    // Pure 2-cycle a <-> b. Walking impact(a) must terminate.
    edge(db, "a", "b", "static_call");
    edge(db, "b", "a", "static_call");
    const res = impactOf(db, "a");
    // b is the only dependent, reached at depth 1; a (the root) is excluded.
    expect(res.hits.map((h) => h.id)).toEqual(["b"]);
    expect(res.capped).toBe(false);
  });

  it("impactOf respects an explicit depth cap and reports capped", () => {
    const db = new Db(":memory:");
    seed(db);
    const res = impactOf(db, "target", 1);
    // depth=1 → only the direct dependents (8: 5 imp + c1 + c2 + cyc_b).
    expect(res.depth).toBe(1);
    expect(res.hits.every((h) => h.depth === 1)).toBe(true);
    expect(res.hits.length).toBe(8);
    // The frontier was still expanding (c1a etc. exist) → capped.
    expect(res.capped).toBe(true);
  });

  it("impactOf does NOT report capped when the deepest node sits exactly at the cap", () => {
    // Chain target <- c1 <- c2, with c2 a leaf. impactOf(target, 2) reaches c2
    // at depth 2 (== cap) but c2 has NO further unvisited dependents, so the
    // walk was COMPLETE — capped must be false (not a misleading "deeper
    // dependents may exist"). Regression for the `d===cap && next.length>0`
    // false positive.
    const db = new Db(":memory:");
    db.migrate();
    node(db, "target");
    node(db, "c1");
    node(db, "c2");
    edge(db, "c1", "target", "static_call");
    edge(db, "c2", "c1", "static_call");
    const res = impactOf(db, "target", 2);
    expect(res.hits.map((h) => h.id).sort()).toEqual(["c1", "c2"]);
    expect(res.capped).toBe(false);
  });

  it("impactOf reports capped when there genuinely is depth past the cap", () => {
    // Same chain extended: target <- c1 <- c2 <- c3. impactOf(target, 2) stops
    // with c2 in the frontier, and c2 HAS an unvisited dependent (c3) → capped.
    const db = new Db(":memory:");
    db.migrate();
    for (const n of ["target", "c1", "c2", "c3"]) node(db, n);
    edge(db, "c1", "target", "static_call");
    edge(db, "c2", "c1", "static_call");
    edge(db, "c3", "c2", "static_call");
    const res = impactOf(db, "target", 2);
    expect(res.hits.map((h) => h.id).sort()).toEqual(["c1", "c2"]);
    expect(res.capped).toBe(true);
  });

  it("impactOf reaches further than a single hop (Tier-3 differentiator)", () => {
    const db = new Db(":memory:");
    seed(db);
    const oneHop = impactOf(db, "target", 1).hits.length;
    const unbounded = impactOf(db, "target", MAX_IMPACT_DEPTH).hits.length;
    expect(unbounded).toBeGreaterThan(oneHop);
  });

  it("refsSummary distinguishes caller entities from textual call sites", () => {
    const db = new Db(":memory:");
    seedRefactor(db);
    const s = refsSummary(db, "refactorTarget");
    // 3 caller ENTITIES (heavyCaller, lightA, lightB) ...
    expect(s.callerCount).toBe(3);
    // ... but 6 textual call SITES (4 + 1 + 1) — the refactor count.
    expect(s.callSites).toBe(6);
    // They are deliberately NOT equal: that's the gap this surfaces.
    expect(s.callSites).not.toBe(s.callerCount);
    // Importers + import sites tracked separately.
    expect(s.importerCount).toBe(1);
    expect(s.importSites).toBe(1);
  });

  it("refsSummary callSites equals the sum of caller weights", () => {
    const db = new Db(":memory:");
    seedRefactor(db);
    const callers = refsOf(db, "refactorTarget").filter((r) => r.via === "call");
    const sum = callers.reduce((acc, r) => acc + r.weight, 0);
    expect(refsSummary(db, "refactorTarget").callSites).toBe(sum);
  });
});

describe("graph routes (HTTP)", () => {
  async function get(app: ReturnType<typeof buildApp>, path: string) {
    const res = await app.handle(new Request(`http://localhost${path}`));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any };
  }

  it("GET /api/importers returns every importer", async () => {
    const db = new Db(":memory:");
    seed(db);
    const app = buildTestApp(db);
    const { status, body } = await get(app, "/api/importers?id=target");
    expect(status).toBe(200);
    expect(body.count).toBe(5);
    expect((body.importers as Array<{ id: string }>).map((i) => i.id).sort()).toEqual([
      "imp0",
      "imp1",
      "imp2",
      "imp3",
      "imp4",
    ]);
  });

  it("GET /api/refs returns callers ∪ importers", async () => {
    const db = new Db(":memory:");
    seed(db);
    const app = buildTestApp(db);
    const { status, body } = await get(app, "/api/refs?id=target");
    expect(status).toBe(200);
    expect(body.count).toBe(8);
    expect((body.callers as unknown[]).length).toBe(3);
    expect((body.importers as unknown[]).length).toBe(5);
  });

  it("GET /api/refs reports callSites (summed weights) distinct from callerCount", async () => {
    const db = new Db(":memory:");
    seedRefactor(db);
    const app = buildTestApp(db);
    const { status, body } = await get(app, "/api/refs?id=refactorTarget");
    expect(status).toBe(200);
    expect(body.callerCount).toBe(3);
    expect(body.callSites).toBe(6);
    expect(body.callSites).not.toBe(body.callerCount);
    expect(body.importerCount).toBe(1);
    expect(body.importSites).toBe(1);
    // Backward-compatible: per-edge weight still present.
    const heavy = (body.callers as Array<{ id: string; weight: number }>).find(
      (c) => c.id === "heavyCaller",
    );
    expect(heavy?.weight).toBe(4);
  });

  it("GET /api/importers reports importSites (summed weights)", async () => {
    const db = new Db(":memory:");
    seedRefactor(db);
    const app = buildTestApp(db);
    const { body } = await get(app, "/api/importers?id=refactorTarget");
    expect(body.count).toBe(1);
    expect(body.importSites).toBe(1);
  });

  it("GET /api/impact returns the transitive set with depths", async () => {
    const db = new Db(":memory:");
    seed(db);
    const app = buildTestApp(db);
    const { status, body } = await get(app, "/api/impact?id=target");
    expect(status).toBe(200);
    expect(body.count).toBe(11);
    expect(body.max_depth_reached).toBe(3);
    expect(body.capped).toBe(false);
  });

  it("GET /api/impact?depth=1 caps and flags it", async () => {
    const db = new Db(":memory:");
    seed(db);
    const app = buildTestApp(db);
    const { body } = await get(app, "/api/impact?id=target&depth=1");
    expect(body.count).toBe(8);
    expect(body.capped).toBe(true);
  });

  it("GET /api/importers?id=missing 404s with an error body", async () => {
    const db = new Db(":memory:");
    db.migrate();
    node(db, "lonely");
    const app = buildTestApp(db);
    const { status } = await get(app, "/api/importers?id=does/not/exist");
    expect(status).toBe(404);
  });

  it("GET /api/importers without id 400s", async () => {
    const db = new Db(":memory:");
    seed(db);
    const app = buildTestApp(db);
    const { status } = await get(app, "/api/importers");
    expect(status).toBe(400);
  });

  it("GET /api/importers?id=<slash-typo> that only FUZZY-matches 404s (typo guard)", async () => {
    // `wrong/dump_cookie` is not an exact id, but FTS resolves it to
    // `pkg/dump_cookie`. A `/`-looking id must NOT silently answer for a
    // different node — parity with the impact/refs/importers CLI guard.
    const db = new Db(":memory:");
    db.migrate();
    node(db, "pkg/dump_cookie");
    node(db, "other/thing");
    const app = buildTestApp(db);
    const { status } = await get(app, "/api/importers?id=wrong/dump_cookie");
    expect(status).toBe(404);
  });

  it("GET /api/impact?id=<slash-typo> that only FUZZY-matches 404s (typo guard)", async () => {
    const db = new Db(":memory:");
    db.migrate();
    node(db, "pkg/dump_cookie");
    const app = buildTestApp(db);
    const { status } = await get(app, "/api/impact?id=wrong/dump_cookie");
    expect(status).toBe(404);
  });

  it("GET /api/importers?id=<bare-term> still fuzzy-resolves (200, echoes resolved)", async () => {
    // A bare term (no `/`) is a loose query — keep the convenience.
    const db = new Db(":memory:");
    db.migrate();
    node(db, "pkg/dump_cookie");
    const app = buildTestApp(db);
    const { status, body } = await get(app, "/api/importers?id=dump_cookie");
    expect(status).toBe(200);
    expect(body.resolved).toBe("pkg/dump_cookie");
  });
});
