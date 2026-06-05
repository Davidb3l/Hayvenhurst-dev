/**
 * Edge-traversal helpers for the EXHAUSTIVE-enumeration + transitive-blast-radius
 * commands (`importers`, `refs`, `impact`) — ROADMAP Tier 1.2 + Tier 3.
 *
 * These are deliberately COMPLETE (never ranked top-N): they read the stored
 * import/call edges directly off the `Db` graph via `db.incoming(id)` /
 * `db.outgoing(id)` and return every match. FTS ranking is the wrong tool for
 * "change EVERY importer of X" — the edges already hold the ground truth, so we
 * expose it whole.
 *
 * Edge-kind vocabulary in this repo (see ARCHITECTURE.md §6 / inspect a live
 * index with `hayven neighbors <id> --json`): `"import"` for module-import
 * edges, and call edges resolved to kinds like `"static_call"`. A reference
 * ("who uses this symbol") is the UNION of incoming call edges and incoming
 * import edges.
 */
import type { CallSiteRow, Db, EdgeRow } from "./queries.ts";
import { searchFts } from "./fts.ts";

/**
 * Resolve a user-supplied id to a real node id.
 *
 * If `id` exists exactly, return it unchanged. Otherwise fall back to the top
 * FTS hit (the same locator the rest of the CLI uses) so a fuzzy/partial id
 * still works — returning the chosen id so the caller can print it to STDERR
 * (keeping stdout clean for `--json`). Returns `null` when neither the exact id
 * nor any FTS hit matches.
 */
export function resolveNodeId(
  db: Db,
  id: string,
): { id: string; resolved: boolean } | null {
  if (db.getNode(id)) return { id, resolved: false };
  const hits = searchFts(db.handle, id, 1);
  if (hits.length > 0 && hits[0]) return { id: hits[0].id, resolved: true };
  return null;
}

/** Edge kinds that count as a "call" of the destination symbol. We treat any
 *  kind ending in `_call` (e.g. `static_call`, `dynamic_call`) as a call, plus
 *  a bare `"call"`, so future call-edge kinds are picked up without a code
 *  change. Import edges are matched separately by the exact kind `"import"`. */
export function isCallKind(kind: string): boolean {
  return kind === "call" || kind.endsWith("_call");
}

/** The single edge kind used for module-import edges. */
export const IMPORT_KIND = "import";

/**
 * EXHAUSTIVE list of every node that imports `id` — the incoming `"import"`
 * edges. Returns the raw {@link EdgeRow}s (src = the importer) so callers can
 * surface kind/weight. Order is deterministic (by importer id) for stable
 * output and tests.
 */
export function importersOf(db: Db, id: string): EdgeRow[] {
  return db
    .incoming(id)
    .filter((e) => e.kind === IMPORT_KIND)
    .sort((a, b) => a.src.localeCompare(b.src));
}

/** Incoming CALL edges of `id` (kinds like `static_call`). Each `src` is a
 *  caller of the symbol. Deterministically ordered by caller id. */
export function callersOf(db: Db, id: string): EdgeRow[] {
  return db
    .incoming(id)
    .filter((e) => isCallKind(e.kind))
    .sort((a, b) => a.src.localeCompare(b.src));
}

/** One row of the `refs` result: a reference to a symbol, tagged by whether it
 *  reached the symbol as a caller (call edge) or an importer (import edge). */
export interface RefRow {
  /** The referencing node (the edge's `src`). */
  id: string;
  /** `"call"` for a call edge, `"import"` for an import edge. */
  via: "call" | "import";
  /** The concrete edge kind (e.g. `static_call`, `import`). */
  kind: string;
  weight: number;
}

/**
 * EXHAUSTIVE references/usages of `id`: ALL callers (incoming call edges) UNION
 * ALL importers (incoming import edges). Complete, edges-backed, unbounded.
 *
 * A single (src,kind) edge maps to one {@link RefRow}; if some other edge kind
 * exists it is ignored (refs is specifically callers∪importers). Sorted by
 * referencing-id then kind for stable output.
 */
export function refsOf(db: Db, id: string): RefRow[] {
  const out: RefRow[] = [];
  for (const e of db.incoming(id)) {
    if (e.kind === IMPORT_KIND) {
      out.push({ id: e.src, via: "import", kind: e.kind, weight: e.weight });
    } else if (isCallKind(e.kind)) {
      out.push({ id: e.src, via: "call", kind: e.kind, weight: e.weight });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind));
  return out;
}

/**
 * Aggregate that distinguishes *caller entities* from *textual call sites* —
 * the gap a signature-change refactor needs to close. A single caller body can
 * call the symbol N times; those N occurrences collapse to ONE caller edge but
 * carry `weight = N`. So:
 *
 *   - `callerCount`   = distinct caller entities (what `refs` historically showed)
 *   - `importerCount` = distinct importer entities
 *   - `callSites`     = SUM of caller weights = total textual call occurrences
 *                       (the number a find-and-replace refactor must touch)
 *
 * Importer weight is the import-edge occurrence count (rarely > 1 and less
 * meaningful), summed into `importSites` for symmetry but kept separate.
 */
export interface RefsSummary {
  refs: RefRow[];
  callerCount: number;
  importerCount: number;
  /** Sum of caller weights = total call occurrences across all callers. */
  callSites: number;
  /** Sum of importer weights = total import occurrences across all importers. */
  importSites: number;
}

/** {@link refsOf} plus the caller/importer entity counts and the summed
 *  weight totals (`callSites`/`importSites`) a refactor needs. */
export function refsSummary(db: Db, id: string): RefsSummary {
  const refs = refsOf(db, id);
  let callerCount = 0;
  let importerCount = 0;
  let callSites = 0;
  let importSites = 0;
  for (const r of refs) {
    if (r.via === "call") {
      callerCount++;
      callSites += r.weight;
    } else {
      importerCount++;
      importSites += r.weight;
    }
  }
  return { refs, callerCount, importerCount, callSites, importSites };
}

/** One line-precise call SITE of a symbol: the file + 1-based (line, col) of a
 *  single call occurrence, plus the caller entity and concrete edge kind. */
export interface CallSiteHit {
  /** The call site's file (repo-relative). */
  file: string;
  /** 1-based line of the call occurrence. */
  line: number;
  /** 1-based column of the call occurrence. */
  col: number;
  /** The caller entity id (the call edge's `src`). */
  caller: string;
  /** The concrete call edge kind (e.g. `static_call`). */
  kind: string;
}

/**
 * EXHAUSTIVE line-precise call sites of `id` — one entry per call OCCURRENCE,
 * ordered by (file, line, col). Backed by the `call_sites` table (schema v5),
 * which keeps each occurrence's location where `edges` only sums them into
 * `weight`. Returns `[]` when the native parser didn't emit line/col (older
 * binaries / pre-v5 index not yet re-ingested) — a COMPLETE list, never a
 * top-N. ADDITIVE: existing exports are unchanged.
 */
export function sitesOf(db: Db, id: string): CallSiteHit[] {
  return db.callSitesOf(id).map((r: CallSiteRow) => ({
    file: r.file ?? "",
    line: r.line ?? 0,
    col: r.col ?? 0,
    caller: r.src,
    kind: r.kind,
  }));
}

/** One node in the transitive blast radius, with the SHORTEST hop-distance
 *  (BFS depth) at which it was first reached. */
export interface ImpactHit {
  id: string;
  /** BFS depth from the root: 1 = direct caller/importer, 2 = caller-of-caller… */
  depth: number;
}

export interface ImpactResult {
  root: string;
  /** The effective depth cap applied to the walk. */
  depth: number;
  /** Distinct dependents, in BFS order (depth asc, then id). EXCLUDES the root. */
  hits: ImpactHit[];
  /** True when the walk hit the depth cap with frontier still expanding —
   *  i.e. there may be deeper dependents not enumerated. */
  capped: boolean;
}

/**
 * Default/maximum depth cap for {@link impactOf}. Bounds both cycles (already
 * handled by the visited set) and pathological runaway on huge graphs. 64 hops
 * is far past any real call chain; "unbounded" in the CLI maps to this cap.
 */
export const MAX_IMPACT_DEPTH = 64;

/**
 * TRANSITIVE callers/dependents of `id` — the blast radius. BFS the INCOMING
 * edges (both call and import edges: "if I change `id`, everything that calls
 * OR imports it, transitively, is affected") and record the shortest depth at
 * which each node is reached.
 *
 * Cycle-safe: a `visited` set guarantees each node is enqueued once, so a cycle
 * (`a → b → a`) terminates. `maxDepth` is additionally clamped to
 * {@link MAX_IMPACT_DEPTH} to bound runaway on very deep graphs; `capped` is set
 * when the cap stopped an otherwise-still-expanding frontier.
 *
 * The root is NOT included in `hits` (it's the thing being changed, not an
 * affected dependent).
 */
export function impactOf(db: Db, id: string, maxDepth = MAX_IMPACT_DEPTH): ImpactResult {
  const cap = Math.min(MAX_IMPACT_DEPTH, Math.max(1, Math.trunc(maxDepth)));
  const depthOf = new Map<string, number>([[id, 0]]);
  let frontier: string[] = [id];
  let capped = false;

  for (let d = 1; d <= cap; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of db.incoming(cur)) {
        // Only call + import edges constitute a dependency that "breaks" when
        // the target changes. Other edge kinds (if any) are not blast radius.
        if (e.kind !== IMPORT_KIND && !isCallKind(e.kind)) continue;
        if (!depthOf.has(e.src)) {
          depthOf.set(e.src, d);
          next.push(e.src);
        }
      }
    }
    frontier = next;
    if (next.length === 0) break;
  }

  // `capped` means the walk genuinely left depth unexplored — NOT merely that
  // the deepest reached node sits exactly at the cap. After the final
  // iteration, probe the frontier's incoming call/import edges for any
  // as-yet-UNVISITED dependent: if one exists there really is more depth past
  // the cap; if every neighbour is already visited (a leaf frontier, or one
  // whose dependents we've all seen), the walk was complete and capped=false.
  if (frontier.length > 0) {
    for (const cur of frontier) {
      for (const e of db.incoming(cur)) {
        if (e.kind !== IMPORT_KIND && !isCallKind(e.kind)) continue;
        if (!depthOf.has(e.src)) {
          capped = true;
          break;
        }
      }
      if (capped) break;
    }
  }

  const hits: ImpactHit[] = [];
  for (const [nodeId, depth] of depthOf) {
    if (nodeId === id) continue; // exclude the root
    hits.push({ id: nodeId, depth });
  }
  hits.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  return { root: id, depth: cap, hits, capped };
}
