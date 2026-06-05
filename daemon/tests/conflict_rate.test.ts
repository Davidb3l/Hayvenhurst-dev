// Conflict-rate measurement harness — ARCHITECTURE.md §17.4, PRD §16(4).
//
// Deliverable evidence: two parallel agents on one codebase produce <3%
// semantic conflicts. This harness MUST be load-bearing — the repo has been
// burned once by a convergence test that couldn't actually fail (see the
// CHANGELOG honesty notes). Two design choices keep it honest:
//
//  1. It drives the REAL claim-registration route (`POST /api/claims` via
//     `app.handle`) over a REAL DB-backed graph — not a reimplementation of
//     the 409/202/201 decision. The adjacency lookup, the HeuristicOracle, and
//     the force flow are all the shipping code.
//
//  2. Ground truth (is a work-pair a genuine semantic conflict?) is defined by
//     the EDIT INTERACTION over the dependency graph — independent of the
//     adjacency signal the defense uses. If ground truth were "are they
//     adjacent?", the harness would be circular and pass trivially. Instead a
//     conflict is: both edit the same entity (overlap), OR one changes a
//     callee's contract that the other depends on (caller/callee break), OR
//     both mutate shared module state. Whether the DEFENSE happens to detect
//     that via adjacency is exactly what we're measuring, not what we assume.
//
// We report a per-layer attribution (naive → +A → +A+C → +A+C+B) so the PRD §7
// projection is checked against measurement, and BOTH a realized rate (with
// Layer B's type phase credited where a checker is configured) and a
// conservative rate (only syntax-manifesting breaks credited to B). The
// residual is dominated by *semantic-only* conflicts — precisely what the
// future Tier-3 LlmOracle (§17.3 / Q7) is meant to reduce.
//
// The harness is oracle-parameterized via the real `selectOracle(config)`, so
// swapping in `LlmOracle` later re-runs the same measurement unchanged.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";
import { nativeParseRunner, verifyMerge } from "../src/conflict/verify.ts";
import type { GraphNode, GraphEdge } from "../src/graph/types.ts";
import {
  mulberry32,
  buildGraph,
  makePair,
  entitiesAdjacent,
  type Graph,
  type Task,
  type ConflictClass,
} from "./fixtures/conflictScenario.ts";

// Languages with a configured typechecker in our matrix (Layer B type phase
// can catch a contract break); js/go have none → a type-manifesting break
// escapes the type phase there. (The scenario model itself — graph, work-pair,
// ground-truth, adjacency — lives in ./fixtures/conflictScenario.ts, shared
// verbatim with bench/oracle-conservatism.ts.)
const TYPED_LANGS = new Set(["typescript", "python", "rust"]);

/** Insert the graph into a daemon Db so the real route's neighbor lookup
 * (Db.outgoing/incoming) returns exactly our `neighborsOf`. */
function loadGraphIntoDb(db: Db, g: Graph): void {
  const nodes: GraphNode[] = g.entities.map((e) => ({
    id: e.id,
    name: e.id.slice(e.id.lastIndexOf("/") + 1),
    qualified_name: e.id.slice(e.id.lastIndexOf("/") + 1),
    kind: "function",
    language: e.language,
    file: `${e.module}.ts`,
    range: [1, 2],
    ast_hash: "h",
    last_seen: 1,
    logical_clock: 0,
  }));
  db.upsertNodes(nodes);
  const edges: GraphEdge[] = [];
  for (const e of g.entities) {
    for (const dst of e.callsOut) {
      edges.push({ src: e.id, dst, kind: "static_call", weight: 1, last_seen: 1 });
    }
  }
  db.upsertEdges(edges);
}

/* ── replica + real route driver ─────────────────────────────────────────── */

interface Replica {
  app: ReturnType<typeof buildApp>;
  dir: string;
}

function makeReplica(g: Graph): Replica {
  const dir = mkdtempSync(join(tmpdir(), "hayven-conflict-"));
  const paths = hayvenPathsFor(dir);
  const crdt = new CrdtState({ crdtRoot: paths.crdtDir, configFile: paths.configFile, skipHydrate: true });
  const db = new Db(":memory:");
  db.migrate();
  loadGraphIntoDb(db, g);
  const app = buildApp({
    db,
    // This harness measures the HEURISTIC oracle's §16(4) properties (its whole
    // narrative below is about the heuristic's documented adjacent-benign
    // conservatism). The shipping DEFAULT oracle is now the deterministic
    // `contract-diff` (config/defaults.ts), which reads REAL entity bodies; this
    // harness's Db is body-less synthetic (loadGraphIntoDb writes range:[1,2], no
    // source), so contract-diff has no real signature to diff here. We therefore
    // pin `heuristic-v1` explicitly — the real-body contract-diff measurement
    // lives in conflict_rate_contractdiff.test.ts. (Layers A/B are oracle-
    // independent, so the §16(4) realized-escape numbers asserted here are
    // unaffected by the default flip regardless.)
    config: { ...DEFAULT_CONFIG, conflict: { oracle: "heuristic-v1" } },
    paths,
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt,
    daemonVersion: "test",
    ingest: { current: () => null, start: async () => { throw new Error("not used"); } },
  });
  return { app, dir };
}

let claimSeq = 0;
async function postClaim(app: Replica["app"], task: Task): Promise<number> {
  const id = `claim-${claimSeq++}`;
  const res = await app.handle(
    new Request("http://localhost/api/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        agent: task.agent,
        intent: task.intent,
        scope: task.scope,
        fingerprint: `fp-${id}`,
        ttlSeconds: 3600,
      }),
    }),
  );
  (task as Task & { _claimId?: string })._claimId = res.status === 201 ? id : undefined;
  return res.status;
}

async function release(app: Replica["app"], task: Task): Promise<void> {
  const id = (task as Task & { _claimId?: string })._claimId;
  if (!id) return;
  await app.handle(new Request(`http://localhost/api/claims/${id}`, { method: "DELETE" }));
}

/* ── the measurement ─────────────────────────────────────────────────────── */

interface Tally {
  n: number;
  conflicts: number;
  nonConflicts: number;
  // a conflict pair's fate under the real defense:
  caughtByA: number; // 409 overlap
  caughtByC: number; // 202 oracle
  proceeded: number; // 201 (reached the merge stage)
  // of those that proceeded, what Layer B can do:
  bWouldCatchSyntax: number;
  bWouldCatchType: number; // only when a checker is configured for the language
  escapedSemantic: number; // proceeded + Layer B blind
  escapedTypeNoChecker: number; // type-manifesting but no checker for the lang
  // false positives, split by whether the pair was even adjacent:
  overBlockedIndependent: number; // NOT adjacent + not overlapping, yet blocked → a wiring bug
  overBlockedAdjacent: number; // adjacent-but-benign blocked → documented heuristic conservatism
  adjacentNonConflicts: number; // denominator for the conservatism rate
  byClass: Record<ConflictClass, number>;
}

async function measure(rnd: () => number, g: Graph, n: number): Promise<Tally> {
  const replica = makeReplica(g);
  const app = replica.app;
  const t: Tally = {
    n, conflicts: 0, nonConflicts: 0, caughtByA: 0, caughtByC: 0, proceeded: 0,
    bWouldCatchSyntax: 0, bWouldCatchType: 0, escapedSemantic: 0, escapedTypeNoChecker: 0,
    overBlockedIndependent: 0, overBlockedAdjacent: 0, adjacentNonConflicts: 0,
    byClass: { none: 0, overlap: 0, "caller-callee": 0, "shared-module": 0 },
  };

  try {
    for (let i = 0; i < n; i++) {
      // Pairing + ground-truth come from the shared scenario model
      // (./fixtures/conflictScenario.ts). The draw order is identical to the
      // former inline version, so the measured rate is unchanged.
      const { a, b, gt } = makePair(rnd, g);
      const ea = a.target;
      const eb = b.target;
      t.byClass[gt.class]++;
      if (gt.conflict) t.conflicts++;
      else t.nonConflicts++;

      // Real defense: A registers, then B registers against the live board.
      await postClaim(app, a);
      const bStatus = await postClaim(app, b);

      if (gt.conflict) {
        if (bStatus === 409) t.caughtByA++;
        else if (bStatus === 202) t.caughtByC++;
        else {
          t.proceeded++;
          // Reached the merge stage → Layer B is the backstop.
          if (gt.manifest === "syntax") t.bWouldCatchSyntax++;
          else if (gt.manifest === "type") {
            if (TYPED_LANGS.has(eb.language) && TYPED_LANGS.has(ea.language)) t.bWouldCatchType++;
            else t.escapedTypeNoChecker++;
          } else {
            t.escapedSemantic++; // semantic-only — Layer B blind
          }
        }
      } else {
        const adjacent = entitiesAdjacent(ea, eb, g) || ea.id === eb.id;
        if (adjacent) t.adjacentNonConflicts++;
        if (bStatus === 409 || bStatus === 202) {
          if (adjacent) t.overBlockedAdjacent++;
          else t.overBlockedIndependent++;
        }
      }

      await release(app, a);
      await release(app, b);
    }
  } finally {
    rmSync(replica.dir, { recursive: true, force: true });
  }
  return t;
}

describe("conflict-rate harness (§17.4, PRD §16(4))", () => {
  // Two independent seeds so the <3% result isn't single-seed luck. Each is a
  // fresh graph + run.
  const SEEDS: Array<{ pair: number; graph: number }> = [
    { pair: 0xc0ffee, graph: 0x5eed },
    { pair: 0x1337beef, graph: 0xabcd12 },
  ];
  const N = 1000;

  for (const seed of SEEDS) {
    test(`realized conflict rate < 3% with honest per-layer attribution (seed ${seed.pair.toString(16)})`, async () => {
      const g = buildGraph(mulberry32(seed.graph));
      const t = await measure(mulberry32(seed.pair), g, N);

      // Per-layer escape rates (fraction of ALL pairs that end in an undetected
      // conflict), in pipeline order: naive → +A (overlap 409) → +A+C (oracle
      // 202) → +A+C+B (merge-time verify). Escapes only come from conflict
      // pairs, so each added layer can only lower the rate.
      const escapedFinal = t.escapedSemantic + t.escapedTypeNoChecker;
      const rateNaive = t.conflicts / N;
      const rateA = (t.conflicts - t.caughtByA) / N;
      const rateAC = t.proceeded / N;
      const rateABC = escapedFinal / N;
      // Conservative variant: don't credit Layer B's TYPE phase at all (only
      // syntax). A stronger claim if it also clears the bar.
      const rateConservative = (t.proceeded - t.bWouldCatchSyntax) / N;

      // Two false-positive populations (see Tally): an *independent* pair (not
      // adjacent, not overlapping) blocked is a wiring BUG; an *adjacent-benign*
      // pair blocked is the heuristic's documented conservatism (the LLM oracle
      // is the precision upgrade — §17.3 / Q7).
      const conservatismRate = t.overBlockedAdjacent / Math.max(1, t.adjacentNonConflicts);

      console.log(
        `\n[conflict-rate seed=${seed.pair.toString(16)}] N=${N}  conflicts=${t.conflicts} (${(rateNaive * 100).toFixed(1)}% naive)  non-conflicts=${t.nonConflicts}` +
        `\n  by class: ${JSON.stringify(t.byClass)}` +
        `\n  per-layer realized escape rate:` +
        `\n    naive      = ${(rateNaive * 100).toFixed(2)}%` +
        `\n    +A (409)   = ${(rateA * 100).toFixed(2)}%   (caughtByA=${t.caughtByA})` +
        `\n    +A+C (202) = ${(rateAC * 100).toFixed(2)}%   (caughtByC=${t.caughtByC})` +
        `\n    +A+C+B     = ${(rateABC * 100).toFixed(2)}%   (B syntax=${t.bWouldCatchSyntax}, B type=${t.bWouldCatchType})` +
        `\n  conservative (no B type credit) = ${(rateConservative * 100).toFixed(2)}%` +
        `\n  residual escapes: semantic-only=${t.escapedSemantic}, type-but-no-checker=${t.escapedTypeNoChecker}` +
        `\n  precision: independent-overblock=${t.overBlockedIndependent} (must be 0); ` +
        `adjacent-benign conservatism=${(conservatismRate * 100).toFixed(1)}% (${t.overBlockedAdjacent}/${t.adjacentNonConflicts}) — LLM oracle's job to lower\n`,
      );

      // The deliverable (§16(4)).
      expect(rateABC).toBeLessThan(0.03);
      // The layers actually work — naive is materially worse.
      expect(rateNaive).toBeGreaterThan(0.03);
      expect(rateNaive).toBeGreaterThan(rateABC);
      // Monotonic non-increasing down the pipeline.
      expect(rateA).toBeLessThanOrEqual(rateNaive);
      expect(rateAC).toBeLessThanOrEqual(rateA);
      expect(rateABC).toBeLessThanOrEqual(rateAC);
      // Load-bearing precision invariant: truly-independent work is NEVER
      // blocked (a non-adjacent, non-overlapping pair cannot trip overlap or
      // the oracle). Anything else is a wiring bug.
      expect(t.overBlockedIndependent).toBe(0);
      // Degeneracy guard (NOT a deliverable): the heuristic over-blocks
      // adjacent-benign work — a known, reported precision cost that the Tier-3
      // LlmOracle exists to lower (§17.3 / Q7). It is ~50-60% on this
      // conflict-enriched distribution. We only assert it isn't degenerate
      // (blocking essentially ALL adjacent work, which would mean the token
      // test is dead). The real precision invariant is overBlockedIndependent===0.
      //
      // NB (BL-13, investigated): the ~50-60% conservatism is INHERENT to a
      // deterministic token oracle here — adjacent claims always share ≥2
      // structural tokens, so a strong/weak confidence split is inert, and every
      // deterministic lever that lowers it raises escape to ~2.7-2.8% on both
      // seeds. The fix is the intent-reading LlmOracle (Q7), not a band tweak.
      expect(conservatismRate).toBeLessThan(0.85);
    }, 30_000);
  }
});

/* ── Layer B backstop: REAL gate confirms a syntax-manifesting escape is
 * caught (this is what credits `bWouldCatchSyntax` above with real evidence,
 * not assumption). Skipped cleanly when the native binary is absent. The TYPE
 * phase's catch behavior is proven in verify_layerb.test.ts. ───────────────── */
function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  const here = import.meta.dir;
  for (const c of [
    join(here, "../../native/target/release/hayven-native"),
    join(here, "../../native/target/debug/hayven-native"),
  ]) if (existsSync(c)) return c;
  return null;
}
const bin = findBinary();
const maybeDescribe = bin === null ? describe.skip : describe;

maybeDescribe("Layer B backstop — a syntax-manifesting merge is really rejected", () => {
  let root: string;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("a conflict that lands a broken merge fails the real verify gate", async () => {
    root = mkdtempSync(join(tmpdir(), "hayven-conflict-b-"));
    mkdirSync(join(root, "src"), { recursive: true });
    // Model the post-merge state of a same-entity collision that produced
    // invalid syntax (two incompatible edits to one function).
    writeFileSync(join(root, "src", "merged.py"), "def handler(:\n    return  # torn merge\n");
    const native = nativeParseRunner({ binary: bin!, root, languages: ["python"], jobs: 0 });
    const res = await verifyMerge(["src/merged.py"], { root, native });
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.file === "src/merged.py" && f.phase === "syntax")).toBe(true);
  });
});
