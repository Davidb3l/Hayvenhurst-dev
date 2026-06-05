// Real-body conflict-rate harness for the OPT-IN contract-diff oracle.
// ARCHITECTURE.md §17.3/§17.4, PRD §16(4), CLAUDE.md item 6(b) — the default-flip
// sign-off measurement.
//
// WHY THIS EXISTS (and why it is NOT conflict_rate.test.ts)
// --------------------------------------------------------
// conflict_rate.test.ts drives the real claim route over a SYNTHETIC graph whose
// Db has NO real entity bodies (loadGraphIntoDb writes range:[1,2], no source).
// The contract-diff oracle reads REAL signatures (tree-sitter over real bodies)
// ∩ the REAL edge index — on a body-less Db it ABSTAINS (entitiesFor resolves an
// empty body → no callable surface), so it cannot show its value there. To decide
// the default flip we need to measure it on REAL bodies + a REAL edge index.
//
// This test:
//   1. Builds the REAL entity graph from THIS repo's own `.hayven` index +
//      source on disk (reuse `buildRealGraph` from bench/oracle-discrimination.ts
//      — exported). Each entity carries its real body and a reconstructed
//      cross-file reference set (the real "caller depends on callee" relation).
//   2. Builds a `DbLike` over that graph (getNode → file/range; outgoing/incoming
//      → the reconstructed reference edges) and runs `selectOracle` EXACTLY as the
//      daemon does — with `conflict.oracle:"contract-diff"`, a locatable binary,
//      the Db, and the repoRoot — so the oracle under test is the SHIPPING wiring
//      (real `buildSignatureIndex` + `dbEntityResolver` + `dbEdgeIndex`), not a
//      hand-built stub.
//   3. Runs the SAME `selectOracle()` heuristic on the SAME scenarios as the
//      baseline, and measures for BOTH: realized conflict rate, independent
//      over-block count (MUST be 0), adjacent-benign conservatism, and conflict
//      escape rate.
//
// Ground truth is the edit-interaction over the REAL reference graph
// (generateRealScenarios / realGroundTruth in oracle-discrimination.ts), NOT the
// adjacency signal the oracle uses — so the measurement is not circular.
//
// SAFE WITHOUT THE BINARY: when $HAYVEN_NATIVE_BIN is absent (or no `.hayven`
// index), the whole describe block `.skip`s — the contract-diff oracle requires a
// native binary, and its absence is exactly the no-binary path that MUST keep
// falling back to the heuristic (asserted in contract_diff_oracle.test.ts).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { selectOracle, HeuristicOracle, type ClaimConflictOracle } from "../src/conflict/oracle.ts";
import { ContractDiffClaimOracle } from "../src/conflict/contract_diff_oracle.ts";
import type { DbLike } from "../src/conflict/native_signatures.ts";
import { mulberry32 } from "./fixtures/conflictScenario.ts";
import {
  buildRealGraph,
  generateRealScenarios,
  type RealScenario,
  type RealEntity,
} from "../../bench/oracle-discrimination.ts";

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

const REPO_ROOT = join(import.meta.dir, "../..");
const HAYVEN_DIR = join(REPO_ROOT, ".hayven");

/**
 * A `DbLike` over the REAL graph, so `selectOracle`'s production wiring
 * (`dbEntityResolver` + `dbEdgeIndex`) resolves real bodies and real edges.
 *
 *  - `getNode(id)` returns the real file + 1-based inclusive line range, so
 *    `dbEntityResolver` slices the SAME real body `buildRealGraph` used. We carry
 *    the range on each entity (see graphWithRanges).
 *  - `outgoing`/`incoming` expose the reconstructed cross-file reference edges as
 *    the daemon's static edge index would (so `dbEdgeIndex.dependsOn` fires on the
 *    same dependency relation the ground truth uses).
 */
interface RangedEntity extends RealEntity {
  rangeStart: number;
  rangeEnd: number;
}

function dbLikeFromGraph(entities: RangedEntity[]): DbLike {
  const byId = new Map(entities.map((e) => [e.id, e]));
  // Outgoing reference edges = the entity's reconstructed imports set.
  // Incoming = the reverse index.
  const incomingMap = new Map<string, string[]>();
  for (const e of entities) {
    for (const dst of e.imports) {
      (incomingMap.get(dst) ?? incomingMap.set(dst, []).get(dst)!).push(e.id);
    }
  }
  return {
    getNode(id) {
      const e = byId.get(id);
      if (!e) return null;
      const qn = e.id.slice(e.id.lastIndexOf("/") + 1);
      return {
        id: e.id,
        name: e.name,
        qualified_name: qn,
        kind: e.kind,
        language: e.language,
        file: e.file,
        range_start: e.rangeStart,
        range_end: e.rangeEnd,
      };
    },
    outgoing(id) {
      const e = byId.get(id);
      if (!e) return [];
      return [...e.imports].map((dst) => ({ dst }));
    },
    incoming(id) {
      return (incomingMap.get(id) ?? []).map((src) => ({ src }));
    },
  };
}

interface Tally {
  label: string;
  n: number;
  saidConflict: number;
  groundTruthConflicts: number;
  escapedConflicts: number; // gt conflict the oracle MISSED (said NO)
  adjacentNonConflicts: number;
  overBlockedAdjacent: number;
  overBlockedIndependent: number; // MUST be 0
  fellBack: number; // oracle answered heuristic-v1 when it shouldn't have
}

async function measure(
  scenarios: RealScenario[],
  label: string,
  oracle: ClaimConflictOracle,
  expectedOracleId: string,
): Promise<Tally> {
  const t: Tally = {
    label, n: scenarios.length, saidConflict: 0, groundTruthConflicts: 0,
    escapedConflicts: 0, adjacentNonConflicts: 0, overBlockedAdjacent: 0,
    overBlockedIndependent: 0, fellBack: 0,
  };
  for (const s of scenarios) {
    const v = await oracle.assess(s.incoming, s.adjacent);
    if (v.conflict) t.saidConflict++;
    if (expectedOracleId !== "heuristic-v1" && v.oracle === "heuristic-v1") t.fellBack++;
    if (s.conflict) {
      t.groundTruthConflicts++;
      if (!v.conflict) t.escapedConflicts++;
    } else {
      if (s.adjacentPair) {
        t.adjacentNonConflicts++;
        if (v.conflict) t.overBlockedAdjacent++;
      } else if (v.conflict) {
        t.overBlockedIndependent++;
      }
    }
  }
  return t;
}

function conservatism(t: Tally): number {
  return t.adjacentNonConflicts > 0 ? (t.overBlockedAdjacent / t.adjacentNonConflicts) * 100 : NaN;
}
function escapeRate(t: Tally): number {
  return t.groundTruthConflicts > 0 ? (t.escapedConflicts / t.groundTruthConflicts) * 100 : 0;
}
function realizedConflictRate(t: Tally): number {
  // Realized "blocked" rate over ALL pairs — the §16(4)-style realized rate is
  // about ESCAPES, but here we also report the over-block load. The §16(4) gate
  // is on the harness in conflict_rate.test.ts (route-level); this number is the
  // oracle's raw block fraction, used for the conservatism/escape comparison.
  return (t.saidConflict / t.n) * 100;
}
const fp = (x: number) => (Number.isFinite(x) ? x.toFixed(1) + "%" : "n/a");

const bin = findBinary();
const haveIndex = existsSync(join(HAYVEN_DIR, "nodes"));
const maybe = bin && haveIndex ? describe : describe.skip;

maybe("real-body conflict-rate: contract-diff vs heuristic (default-flip gate)", () => {
  // Build the real graph + scenarios ONCE (the heavy part is the one-shot
  // signature index parse inside selectOracle, not the graph build).
  const g = buildRealGraph(HAYVEN_DIR, REPO_ROOT);

  // Re-read each entity's range from its node md so the DbLike resolver slices
  // the SAME body. buildRealGraph drops the range after slicing, so recover it by
  // matching the body back — simpler: re-walk is overkill, so we re-derive the
  // range from the body length is not reliable. Instead, attach ranges by
  // re-parsing frontmatter here would duplicate logic; the resolver re-reads the
  // file from `file` + range. We carry the body verbatim by giving the resolver a
  // range that spans the body's lines as they appear in the file. Since
  // buildRealGraph sliced `body` from the file over [start,end], and we don't have
  // start/end, we instead reconstruct via indexOf of the body's first line.
  // To keep this faithful AND simple, recompute ranges from the source files.
  const fileText = new Map<string, string[]>();
  const ranged: RangedEntity[] = [];
  for (const e of g.entities) {
    let lines = fileText.get(e.file);
    if (!lines) {
      const abs = join(REPO_ROOT, e.file);
      if (!existsSync(abs)) continue;
      lines = readFileSync(abs, "utf8").split("\n");
      fileText.set(e.file, lines!);
    }
    const bodyLines = e.body.split("\n");
    // Find the 0-based start line of the body within the file.
    let start = -1;
    for (let i = 0; i + bodyLines.length <= lines!.length; i++) {
      if (lines![i] === bodyLines[0] && lines![i + bodyLines.length - 1] === bodyLines[bodyLines.length - 1]) {
        start = i; break;
      }
    }
    if (start < 0) continue; // couldn't anchor — skip (rare; keeps bodies faithful)
    ranged.push({ ...e, rangeStart: start + 1, rangeEnd: start + bodyLines.length });
  }

  // Keep only scenarios whose BOTH entities survived the range-anchoring, so the
  // DbLike can resolve real bodies for every pair the oracle sees.
  const rangedIds = new Set(ranged.map((e) => e.id));
  const allScenarios = generateRealScenarios(mulberry32(0xc0ffee), g, 200);
  const scenarios = allScenarios.filter(
    (s) => rangedIds.has(s.incomingTask.target.id) && rangedIds.has(s.adjacentTask.target.id),
  );

  const db = dbLikeFromGraph(ranged);

  // Build BOTH oracles via the SHIPPING selectOracle wiring.
  const heuristic = selectOracle(); // zero-config → heuristic-v1
  const contractDiff = selectOracle(
    { conflict: { oracle: "contract-diff" } },
    { locateBinary: () => bin!, db, repoRoot: REPO_ROOT, parseLanguages: ["typescript", "javascript", "python", "rust", "go"] },
  );

  test("contract-diff is the real oracle (not a degraded heuristic fallback)", () => {
    expect(heuristic).toBeInstanceOf(HeuristicOracle);
    expect(contractDiff).toBeInstanceOf(ContractDiffClaimOracle);
    expect(contractDiff.id).toBe("contract-diff");
    expect(scenarios.length).toBeGreaterThan(40); // enough pairs to be meaningful
  });

  test("MEASURE: contract-diff vs heuristic on real bodies — independent-overblock MUST be 0", async () => {
    const hT = await measure(scenarios, "heuristic-v1", heuristic, "heuristic-v1");
    const cT = await measure(scenarios, "contract-diff", contractDiff, "contract-diff");

    const adjEnts = ranged.length;
    console.log(
      `\n[real-body conflict-rate] entities(ranged)=${adjEnts}/${g.entities.length}  scenarios=${scenarios.length}  ` +
        `gt-conflicts=${hT.groundTruthConflicts}  adjacent-non-conflicts=${hT.adjacentNonConflicts}` +
        `\n  ── heuristic-v1 (shipping default) ──` +
        `\n    realized block rate     = ${fp(realizedConflictRate(hT))}  (${hT.saidConflict}/${hT.n})` +
        `\n    adjacent-benign conserv = ${fp(conservatism(hT))}  (${hT.overBlockedAdjacent}/${hT.adjacentNonConflicts})` +
        `\n    independent over-block  = ${hT.overBlockedIndependent}  (MUST be 0)` +
        `\n    conflict escapes        = ${fp(escapeRate(hT))}  (${hT.escapedConflicts}/${hT.groundTruthConflicts})` +
        `\n  ── contract-diff (candidate default) ──` +
        `\n    realized block rate     = ${fp(realizedConflictRate(cT))}  (${cT.saidConflict}/${cT.n})` +
        `\n    adjacent-benign conserv = ${fp(conservatism(cT))}  (${cT.overBlockedAdjacent}/${cT.adjacentNonConflicts})` +
        `\n    independent over-block  = ${cT.overBlockedIndependent}  (MUST be 0)` +
        `\n    conflict escapes        = ${fp(escapeRate(cT))}  (${cT.escapedConflicts}/${cT.groundTruthConflicts})` +
        `\n    fellBack to heuristic   = ${cT.fellBack}/${cT.n}\n`,
    );

    // Load-bearing safety invariant for the CANDIDATE DEFAULT (contract-diff):
    // truly-independent work (not adjacent, not overlapping) is NEVER blocked.
    // This is the §16(4) precision invariant that the flip must preserve.
    expect(cT.overBlockedIndependent).toBe(0);

    // HONEST FINDING (not a regression introduced here): on the REAL graph the
    // heuristic DOES over-block a handful of "independent" pairs — pairs with no
    // direct A↔B edge but a SHARED THIRD neighbor (both reference a common
    // entity C). The heuristic's `sharesNeighbor` fires on that shared-third-
    // neighbor case; the synthetic conflict_rate.test.ts graph never produces it,
    // so that suite's `overBlockedIndependent===0` holds only on synthetic data.
    // contract-diff, which gates on a real contract-change ∩ a DIRECT dependency,
    // keeps it at 0 here. We record the heuristic's count rather than assert 0.
    expect(hT.overBlockedIndependent).toBeGreaterThanOrEqual(0);

    // The contract-diff oracle really ran (did not silently degrade to heuristic
    // on every call — that would make the comparison meaningless).
    expect(cT.fellBack).toBeLessThan(cT.n);

    // Sanity: both denominators are non-trivial so the rates mean something.
    expect(hT.adjacentNonConflicts).toBeGreaterThan(5);
    expect(hT.groundTruthConflicts).toBeGreaterThan(0);

    // Store the comparison for the gate test below (module-scoped).
    (globalThis as Record<string, unknown>).__cdGate = { hT, cT };
  }, 120_000);

  test("DECISION GATE: report whether contract-diff clears the flip criteria", async () => {
    const gate = (globalThis as Record<string, unknown>).__cdGate as { hT: Tally; cT: Tally } | undefined;
    expect(gate).toBeDefined();
    const { hT, cT } = gate!;

    const heurCons = conservatism(hT);
    const cdCons = conservatism(cT);
    const conservatismDropsMaterially = Number.isFinite(cdCons) && Number.isFinite(heurCons) && cdCons < heurCons - 10; // >10pp absolute
    const escapesNoWorse = cT.escapedConflicts <= hT.escapedConflicts + Math.ceil(0.05 * Math.max(1, hT.groundTruthConflicts));
    const independentZero = cT.overBlockedIndependent === 0;
    const passes = conservatismDropsMaterially && escapesNoWorse && independentZero;

    console.log(
      `\n[DECISION GATE]` +
        `\n  conservatism: heuristic ${fp(heurCons)} → contract-diff ${fp(cdCons)}  ` +
        `(drops materially >10pp: ${conservatismDropsMaterially})` +
        `\n  escapes: heuristic ${hT.escapedConflicts} → contract-diff ${cT.escapedConflicts}  (no worse: ${escapesNoWorse})` +
        `\n  independent over-block: ${cT.overBlockedIndependent}  (zero: ${independentZero})` +
        `\n  ⇒ FLIP GATE ${passes ? "PASSES" : "DOES NOT PASS"}\n`,
    );

    // This test does NOT assert a particular verdict — it RECORDS the gate result
    // for the human sign-off. The decision (flip or keep opt-in) is taken in the
    // session report based on these numbers + the no-binary-safety argument. The
    // only HARD invariants are the safety ones, asserted above.
    expect(typeof passes).toBe("boolean");
  });
});
