/**
 * Layer A — overlap + adjacency computation for the semantic claim board.
 * ARCHITECTURE.md §17.1.
 *
 * These are PURE functions over an active-claim set plus a graph-neighbor
 * lookup. No DB handle, no I/O — the caller injects a `NeighborLookup` so the
 * logic unit-tests without a live database. The daemon route supplies a lookup
 * backed by `Db.outgoing`/`Db.incoming`; tests supply a stub map.
 *
 *   - **Overlap** (hard conflict): two claims overlap iff their scope SETS
 *     intersect. Reported as a 409 by the registration path.
 *   - **Adjacency** (Layer C trigger): two claims are adjacent iff a graph
 *     edge connects any entity in one scope to any entity in the other, OR
 *     they share a containing module prefix (see {@link modulePrefix}).
 */

/** The minimal shape of an active claim this layer needs. */
export interface ClaimLike {
  readonly id: string;
  readonly scope: readonly string[];
}

/**
 * Returns the graph neighbors (both directions) of a single entity id. The
 * daemon implementation unions `Db.outgoing(id)` dst-ids and `Db.incoming(id)`
 * src-ids; tests stub it directly. Pure: must not mutate or perform I/O the
 * caller can't reason about.
 */
export type NeighborLookup = (entityId: string) => readonly string[];

/** Set intersection test over two id lists. */
function intersects(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(a);
  const out: string[] = [];
  for (const x of b) if (set.has(x)) out.push(x);
  return out;
}

/**
 * The containing module prefix of an entity id, or `null` if it has none.
 *
 * The project id scheme (`daemon/src/graph/idScheme.ts`) is a `/`-delimited
 * path whose final segment is the local entity name; a method id additionally
 * carries a `.` separator inside that final segment (e.g.
 * `auth/login/Session.refresh`). The *containing module* is therefore the id
 * with its last `/`-segment removed — i.e. `auth/login` for
 * `auth/login/loginHandler`, and `auth/login` for `auth/login/Session.refresh`.
 * A bare module id like `auth/login` (or a top-level `index`) has no further
 * containing module and yields `null`. We do NOT split on `.` for the prefix:
 * a `.`-separated method shares the module with its sibling members via the
 * `/`-segment rule already, and splitting on `.` would invent a sub-module the
 * id scheme does not define.
 */
export function modulePrefix(entityId: string): string | null {
  const slash = entityId.lastIndexOf("/");
  if (slash <= 0) return null;
  return entityId.slice(0, slash);
}

/** Set of containing module prefixes for every id in a scope. */
function modulePrefixes(scope: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of scope) {
    const p = modulePrefix(id);
    if (p !== null) out.add(p);
  }
  return out;
}

/**
 * Overlap = hard conflict. Returns the conflicting claim and the overlapping
 * entity ids for the FIRST active claim whose scope intersects `incomingScope`,
 * or `null` if none overlap.
 */
export function findOverlap(
  incomingScope: readonly string[],
  active: readonly ClaimLike[],
): { claim: ClaimLike; entities: string[] } | null {
  for (const claim of active) {
    const shared = intersects(incomingScope, claim.scope);
    if (shared.length > 0) return { claim, entities: shared };
  }
  return null;
}

/**
 * Whether a real call/import GRAPH EDGE connects the two scopes in either
 * direction — i.e. some entity in one scope is an immediate import/call
 * neighbor of some entity in the other. This is the STRONG, semantic adjacency
 * signal (Tier 2.2): it means a change to one scope's code is wired, by an
 * actual edge the parser resolved, to the other's. It is deliberately distinct
 * from {@link isAdjacent}, which ALSO fires on a merely-shared module prefix
 * (two unrelated functions that happen to live in the same file). The
 * registration path uses this to label graph-edge conflicts as semantic (vs.
 * co-located) so the oracle/verdict reason can say *why* — without changing the
 * soft-202 gate (see §16(4): edge adjacency must stay a soft, force-able signal,
 * never a hard 409, or truly-independent work co-located in big modules over-blocks).
 */
export function edgeAdjacency(
  scopeA: readonly string[],
  scopeB: readonly string[],
  neighbors: NeighborLookup,
): boolean {
  const bSet = new Set(scopeB);
  // any neighbor of an A-entity lands in B (A calls/imports B, or v.v.)
  for (const a of scopeA) {
    for (const n of neighbors(a)) {
      if (bSet.has(n)) return true;
    }
  }
  const aSet = new Set(scopeA);
  // reverse direction: any neighbor of a B-entity lands in A.
  for (const b of scopeB) {
    for (const n of neighbors(b)) {
      if (aSet.has(n)) return true;
    }
  }
  return false;
}

/**
 * Whether two scopes are connected THROUGH THE GRAPH — a direct call/import edge
 * ({@link edgeAdjacency}), OR a shared one-hop dependency neighbor (both scopes
 * depend on some common entity). This is the "graph-precise" adjacency signal
 * (E2, `docs/COORDINATION_ENTERPRISE_EXPERIMENTS.md`): stricter than mere module
 * co-location (two unrelated functions in the same file are NOT connected), but
 * it still catches a shared-invariant conflict where two entities touch a common
 * callee without a direct edge between themselves. It mirrors the oracle's own
 * {@link import("./oracle.ts").HeuristicOracle} `sharesNeighbor` relation, one
 * level up at the SCOPE-SELECTION gate: a pair only reaches the oracle when they
 * are actually wired together in the dependency graph, not just filed together.
 */
export function scopesGraphConnected(
  scopeA: readonly string[],
  scopeB: readonly string[],
  neighbors: NeighborLookup,
): boolean {
  // Direct edge (also covers "a neighbor of one lands in the other's scope").
  if (edgeAdjacency(scopeA, scopeB, neighbors)) return true;
  // Shared one-hop neighbor: scopeNeighbors(A) ∩ scopeNeighbors(B) ≠ ∅.
  const aNeighbors = new Set(scopeNeighbors(scopeA, neighbors));
  if (aNeighbors.size === 0) return false;
  for (const n of scopeNeighbors(scopeB, neighbors)) {
    if (aNeighbors.has(n)) return true;
  }
  return false;
}

/** Whether two scopes share a containing module prefix (co-location). */
function shareModulePrefix(scopeA: readonly string[], scopeB: readonly string[]): boolean {
  const aPrefixes = modulePrefixes(scopeA);
  if (aPrefixes.size === 0) return false;
  for (const p of modulePrefixes(scopeB)) {
    if (aPrefixes.has(p)) return true;
  }
  return false;
}

/** Whether two scopes are adjacent (graph edge OR shared module prefix). */
export function isAdjacent(
  scopeA: readonly string[],
  scopeB: readonly string[],
  neighbors: NeighborLookup,
): boolean {
  // (1) graph-edge adjacency (strong) — a real call/import edge connects them.
  if (edgeAdjacency(scopeA, scopeB, neighbors)) return true;
  // (2) module-prefix adjacency (weak) — scopes share a containing module.
  return shareModulePrefix(scopeA, scopeB);
}

/**
 * The graph-neighbor entity ids of an entire scope (union over each entity's
 * neighbors, minus the scope's own ids). Used to build the `neighbors` field
 * of the Layer C {@link import("./oracle.ts").ClaimContext}.
 */
export function scopeNeighbors(
  scope: readonly string[],
  neighbors: NeighborLookup,
): string[] {
  const own = new Set(scope);
  const out = new Set<string>();
  for (const id of scope) {
    for (const n of neighbors(id)) {
      if (!own.has(n)) out.add(n);
    }
  }
  return [...out];
}

/**
 * Which adjacency signal SELECTS a pair of scopes as a Layer-C oracle candidate
 * (E2, `docs/COORDINATION_ENTERPRISE_EXPERIMENTS.md`). The gate only decides
 * which pairs are *examined* — the oracle still has the final say and its verdict
 * is still a soft, force-able 202, never a hard 409 (§16(4)).
 *
 *   - `"module+edge"` — the shipping default: edge OR shared module prefix
 *     ({@link isAdjacent}). Two functions in the same file are candidates even
 *     with no dependency edge between them (the source of the heuristic's
 *     documented adjacent-benign over-blocking).
 *   - `"edge"` — graph-precise, strict: only a direct call/import edge between
 *     the two scopes ({@link edgeAdjacency}).
 *   - `"graph"` — graph-precise, permissive: a direct edge OR a shared one-hop
 *     dependency neighbor ({@link scopesGraphConnected}). Drops pure module
 *     co-location but keeps shared-callee coupling.
 */
export type AdjacencyGate = "module+edge" | "edge" | "graph";

/** The scope-pair predicate for an {@link AdjacencyGate}. */
export function gatePredicate(
  gate: AdjacencyGate,
  neighbors: NeighborLookup,
): (a: readonly string[], b: readonly string[]) => boolean {
  switch (gate) {
    case "edge":
      return (a, b) => edgeAdjacency(a, b, neighbors);
    case "graph":
      return (a, b) => scopesGraphConnected(a, b, neighbors);
    case "module+edge":
    default:
      return (a, b) => isAdjacent(a, b, neighbors);
  }
}

/**
 * All active claims adjacent to `incomingScope` under the given {@link AdjacencyGate}.
 * The registration path runs the Layer C oracle once per returned claim. The
 * `gate` defaults to `"module+edge"` so existing callers are byte-identical.
 */
export function findAdjacent(
  incomingScope: readonly string[],
  active: readonly ClaimLike[],
  neighbors: NeighborLookup,
  gate: AdjacencyGate = "module+edge",
): ClaimLike[] {
  const adjacent = gatePredicate(gate, neighbors);
  const out: ClaimLike[] = [];
  for (const claim of active) {
    if (adjacent(incomingScope, claim.scope)) out.push(claim);
  }
  return out;
}

/**
 * Tier 2.1 — graph-aware claim-scope SUGGESTION. Given a claimed scope, returns
 * the claimed ids PLUS their immediate import/call-edge neighbors (the files a
 * change to the claimed code is likely to also touch — the dogfooding gap that
 * made an agent UNDER-deliver by skipping an unclaimed-but-needed `types.ts`).
 *
 * DESIGN CHOICE — SUGGEST, do NOT auto-expand the claim:
 * we return the expanded set as a separate `suggested` field rather than
 * silently folding the neighbors into the registered scope. Auto-claiming the
 * one-hop neighborhood would OVER-LOCK: a single claim on a hub entity (e.g. a
 * widely-imported `types.ts`) would lock half the graph and block independent
 * work — exactly the §16(4) regression we must avoid. Surfacing the set keeps
 * the human/agent in the loop: they SEE the likely-impacted neighbors and can
 * choose to widen the claim, while the registered scope stays exactly what was
 * asked for. Visible always in the 201 response (`suggestedScope`); the CLI
 * prints it only under the opt-in `--suggest-scope` flag.
 */
export function suggestScope(
  scope: readonly string[],
  neighbors: NeighborLookup,
): { claimed: string[]; suggested: string[] } {
  return {
    claimed: [...scope],
    // The one-hop import/call neighbors not already in the claimed scope.
    suggested: scopeNeighbors(scope, neighbors),
  };
}
