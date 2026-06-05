/**
 * Shared synthetic conflict-scenario generator.
 *
 * The single source of truth for the conflict-defense scenario model — the
 * deterministic graph, work-pair, and ground-truth machinery used by BOTH
 * `daemon/tests/conflict_rate.test.ts` (drives the real HTTP claim route) and
 * `bench/oracle-conservatism.ts` (drives `oracle.assess()` directly). It was
 * previously duplicated in both; this module makes them share one definition so
 * the bench measures the SAME distribution the test gates on.
 *
 * Pure and dependency-free (no DB, no HTTP, no production imports) — the two
 * consumers add their own driver-specific layers on top (the test loads the
 * graph into a Db + posts claims; the bench builds `ClaimContext`s + calls the
 * oracle). Everything here is seeded via {@link mulberry32}; nothing uses
 * `Math.random`, so a given (graph, pair) seed pair is fully reproducible.
 *
 * NB: callers MUST preserve the PRNG draw ORDER — the test's <3% gate and its
 * 2.4%/1.7% reported figures are a function of the exact sequence of `rnd()`
 * calls in {@link buildGraph} and {@link makePair}. Don't reorder draws.
 */

/* ── deterministic PRNG (mulberry32) ─────────────────────────────────────────
 * Seeded so the measured rate is reproducible — a flaky conflict-rate gate
 * would be worthless. No Math.random anywhere in the model. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── synthetic codebase graph ────────────────────────────────────────────────
 * Entity ids follow the real scheme `<scope>/<module>/<name>` so adjacency's
 * module-prefix rule and the heuristic's tokenization behave realistically.
 * Names come from a code-flavored vocab (all ≥3 chars) so token overlap is
 * meaningful rather than degenerate ("e3_2" would tokenize to nothing). */
export const VOCAB = [
  "login", "logout", "session", "validate", "handler", "encode", "decode",
  "parse", "render", "fetch", "cache", "router", "schema", "migrate", "query",
  "serialize", "resolve", "ingest", "verify", "claim",
];

export interface Entity {
  id: string;
  module: string; // "<scope>/<module>"
  language: string;
  callsOut: string[]; // entity ids this one calls (static edge src→dst)
}

export interface Graph {
  entities: Entity[];
  byId: Map<string, Entity>;
  // The true static-graph neighbor set, mirroring the daemon's
  // Db.outgoing ∪ Db.incoming union.
  neighborsOf: (id: string) => Set<string>;
}

// Languages emitted into the synthetic graph (a code-realistic spread).
export const LANGS = ["typescript", "python", "rust", "javascript", "go"];

export function buildGraph(rnd: () => number): Graph {
  const MODULES = 24;
  const ENTITIES_PER_MODULE = 6;
  const entities: Entity[] = [];
  const moduleLang: string[] = [];

  for (let m = 0; m < MODULES; m++) {
    moduleLang[m] = LANGS[Math.floor(rnd() * LANGS.length)]!;
    for (let k = 0; k < ENTITIES_PER_MODULE; k++) {
      const name = `${VOCAB[(m * ENTITIES_PER_MODULE + k) % VOCAB.length]!}${m}_${k}`;
      entities.push({
        id: `app/mod${m}/${name}`,
        module: `app/mod${m}`,
        language: moduleLang[m]!,
        callsOut: [],
      });
    }
  }

  // Edges: each entity calls a few others — mostly intra-module (dense),
  // occasionally inter-module (sparse). This is the dependency graph that
  // BOTH the daemon (via Db) and our ground-truth model read.
  const idx = (m: number, k: number) => m * ENTITIES_PER_MODULE + k;
  for (let m = 0; m < MODULES; m++) {
    for (let k = 0; k < ENTITIES_PER_MODULE; k++) {
      const e = entities[idx(m, k)]!;
      const nCalls = Math.floor(rnd() * 3); // 0..2
      for (let c = 0; c < nCalls; c++) {
        let target: Entity;
        if (rnd() < 0.8) {
          // intra-module
          const tk = Math.floor(rnd() * ENTITIES_PER_MODULE);
          target = entities[idx(m, tk)]!;
        } else {
          // inter-module
          const tm = Math.floor(rnd() * MODULES);
          const tk = Math.floor(rnd() * ENTITIES_PER_MODULE);
          target = entities[idx(tm, tk)]!;
        }
        if (target.id !== e.id && !e.callsOut.includes(target.id)) {
          e.callsOut.push(target.id);
        }
      }
    }
  }

  const byId = new Map(entities.map((e) => [e.id, e]));
  // Precompute the undirected neighbor union (out dst ∪ in src).
  const nbr = new Map<string, Set<string>>();
  for (const e of entities) nbr.set(e.id, new Set());
  for (const e of entities) {
    for (const dst of e.callsOut) {
      nbr.get(e.id)!.add(dst);
      nbr.get(dst)?.add(e.id);
    }
  }
  return { entities, byId, neighborsOf: (id) => nbr.get(id) ?? new Set() };
}

/* ── work-pair model ──────────────────────────────────────────────────────── */

export type EditKind = "contract" | "internal";

export interface Task {
  agent: string;
  target: Entity;
  edit: EditKind;
  scope: string[];
  intent: string;
}

export function makeTask(agent: string, target: Entity, edit: EditKind, rnd: () => number): Task {
  const verb = edit === "contract" ? "change the signature of" : "tweak internals of";
  // Intent folds in the entity's own name tokens — realistic agent prose.
  const name = target.id.slice(target.id.lastIndexOf("/") + 1);
  return {
    agent,
    target,
    edit,
    scope: [target.id],
    intent: `${verb} ${name} in ${target.module} (task ${Math.floor(rnd() * 1000)})`,
  };
}

export type ConflictClass =
  | "none"
  | "overlap" // both edit the same entity
  | "caller-callee" // one changes a callee's contract the other depends on
  | "shared-module"; // both mutate shared module state, no dependency edge

export interface GroundTruth {
  conflict: boolean;
  class: ConflictClass;
  // If a conflict proceeds past claims, can Layer B catch it?
  //   "syntax"  → manifests as a syntax error (real native parse catches it)
  //   "type"    → manifests as a type error (caught iff a checker is configured)
  //   "semantic"→ neither; only a smarter (LLM) oracle could have caught it
  manifest: "syntax" | "type" | "semantic" | "n/a";
}

/** Ground truth from edit interaction over the dependency graph — deliberately
 * NOT a function of claim adjacency. */
export function groundTruth(a: Task, b: Task, g: Graph, rnd: () => number): GroundTruth {
  // Same entity → overlapping edits conflict.
  if (a.target.id === b.target.id) {
    // A same-entity collision usually shows up as a real merge/syntax problem.
    return { conflict: true, class: "overlap", manifest: "syntax" };
  }

  // Caller/callee contract break: X changes a contract that Y calls.
  const aCallsB = g.neighborsOf(b.target.id).has(a.target.id) && a.target.callsOut.includes(b.target.id);
  const bCallsA = g.neighborsOf(a.target.id).has(b.target.id) && b.target.callsOut.includes(a.target.id);
  const contractDep =
    (b.edit === "contract" && a.target.callsOut.includes(b.target.id)) ||
    (a.edit === "contract" && b.target.callsOut.includes(a.target.id)) ||
    (aCallsB && b.edit === "contract") ||
    (bCallsA && a.edit === "contract");
  if (contractDep) {
    // Most contract breaks surface as a type error (arity/type mismatch); a
    // minority are type-compatible but semantically wrong (changed meaning).
    const manifest = rnd() < 0.75 ? "type" : "semantic";
    return { conflict: true, class: "caller-callee", manifest };
  }

  // Shared mutable module state: same module, no dependency edge, but both
  // edits touch a shared invariant. Rare, and invisible to static analysis —
  // the canonical case the heuristic cannot catch.
  if (a.target.module === b.target.module && rnd() < 0.12) {
    return { conflict: true, class: "shared-module", manifest: "semantic" };
  }

  return { conflict: false, class: "none", manifest: "n/a" };
}

/** Graph-level adjacency of two entities, independent of the claim layer:
 * a direct call edge between them, or the same containing module. Used only to
 * classify a false-positive as "independent" (must never block) vs
 * "adjacent-benign" (conservative block). */
export function entitiesAdjacent(a: Entity, b: Entity, g: Graph): boolean {
  if (a.module === b.module) return true;
  return g.neighborsOf(a.id).has(b.id) || g.neighborsOf(b.id).has(a.id);
}

export interface ScenarioPair {
  a: Task;
  b: Task;
  gt: GroundTruth;
}

/** One labeled work-pair: pick entity A uniformly, then bias B toward A's
 * neighborhood sometimes, so conflicts (and adjacent-benign pairs) aren't
 * vanishingly rare (a uniform random pair is almost always independent). Half
 * the time pick B from A's call graph / module; half uniformly. The exact draw
 * order here is load-bearing — it reproduces the conflict-rate test's sequence
 * (so both consumers see identical scenarios for a given seed). */
export function makePair(rnd: () => number, g: Graph): ScenarioPair {
  const ea = g.entities[Math.floor(rnd() * g.entities.length)]!;
  let eb: Entity;
  const r = rnd();
  if (r < 0.35 && ea.callsOut.length > 0) {
    eb = g.byId.get(ea.callsOut[Math.floor(rnd() * ea.callsOut.length)]!)!;
  } else if (r < 0.55) {
    const sib = g.entities.filter((x) => x.module === ea.module);
    eb = sib[Math.floor(rnd() * sib.length)]!;
  } else {
    eb = g.entities[Math.floor(rnd() * g.entities.length)]!;
  }

  const aEdit: EditKind = rnd() < 0.4 ? "contract" : "internal";
  const bEdit: EditKind = rnd() < 0.4 ? "contract" : "internal";
  const a = makeTask("agentA", ea, aEdit, rnd);
  const b = makeTask("agentB", eb, bEdit, rnd);
  const gt = groundTruth(a, b, g, rnd);
  return { a, b, gt };
}
