/**
 * GRAPH-COMPUTED disjoint-lane planner (`db/lane_planner.ts`).
 *
 * Turns a change-set (files and/or explicit symbols an operator intends to
 * touch) into SAFE parallel work lanes by partitioning the seeds along the
 * transitive blast-radius graph. This automates the manual fan-out workflow:
 * "run parallel agents in disjoint file lanes that can't collide."
 *
 * The headline capability — the "10x where grep is 0x": grep can tell you a
 * symbol appears in a file, but it cannot compute TRANSITIVITY. Two changes can
 * look independent textually yet share a deep dependent (a caller-of-a-caller,
 * or two symbols whose dependents happen to live in the same file). The
 * call/import graph already holds that ground truth; we walk it with
 * {@link impactOf} (the same reverse-BFS blast radius the `impact` command uses)
 * and group seeds whose radii touch.
 *
 * COUPLED seeds (overlapping blast radius) MUST serialize — you cannot safely
 * edit code that two tasks both impact. INDEPENDENT seeds (disjoint radius) run
 * concurrently. The returned lanes are, by construction, pairwise disjoint in
 * BOTH files and symbols, so each lane is a collision-free agent assignment.
 */
import { impactOf, resolveNodeId } from "./graph_walk.ts";
import { Db } from "./queries.ts";

export interface PlannedLane {
  seeds: string[];     // the change-seeds (resolved symbol ids) grouped into THIS lane
  files: string[];     // union of files across this lane's blast radius + seeds (sorted, distinct)
  symbols: string[];   // union of affected symbol ids incl. seeds (sorted, distinct)
}

export interface LanePlan {
  lanes: PlannedLane[];  // blast-radius-DISJOINT: pairwise share NO file and NO symbol — safe to run concurrently
  note: string;          // human summary, e.g. "5 seeds → 3 disjoint lanes; 2 seeds coupled via shared blast radius"
  // The hub node ids dropped from the coupling decision (and from the reported
  // sets) when `maxHubDegree` is set — see the hub-saturation note below. Sorted,
  // distinct. Absent entirely when `maxHubDegree` is undefined (no hub logic ran).
  hubsExcluded?: string[];
}

/**
 * The fully-computed blast radius of a single seed: the symbol set (the seed
 * itself UNION every transitive dependent {@link impactOf} reaches) and the
 * distinct files those symbols are defined in. These two sets are what the
 * overlap relation (step 3) intersects across seed pairs.
 */
interface SeedRadius {
  seed: string;
  symbols: Set<string>;
  files: Set<string>;
}

/**
 * Plan disjoint parallel lanes from a change-set (files and/or explicit symbols).
 *
 * Pipeline: resolve seeds → compute each seed's blast radius → union-find the
 * seeds under "shares a file OR a symbol" → emit one lane per connected
 * component. Unresolvable symbols and node-less files are skipped and counted
 * into `note`. Empty input yields `{ lanes: [], note: "no seeds" }`.
 *
 * HUB-SATURATION mitigation (`maxHubDegree`): on a real repo a hub module (a
 * barrel `index.ts` everything imports) lands in nearly every seed's blast
 * radius, so two genuinely-independent changes COUPLE through the hub and
 * collapse into one giant lane. When `maxHubDegree` is set, any blast-radius
 * node whose IN-degree (`db.incoming(id).length` — callers ∪ importers) exceeds
 * it is a HUB and is dropped from BOTH the coupling decision and the reported
 * sets; the excluded hub ids are surfaced via `hubsExcluded`. Seeds that meet
 * ONLY at a hub then stay in separate lanes. Undefined → no hub logic (today's
 * behavior, byte-identical).
 */
export function planLanes(
  db: Db,
  input: { files?: string[]; symbols?: string[] },
  opts?: { maxDepth?: number; maxHubDegree?: number },
): LanePlan {
  /* ---------- step 1: build + dedup seeds ---------- */
  // Preserve first-seen order while deduping (a Set keeps insertion order) so
  // the planning is deterministic; lane contents are sorted on emit regardless.
  const seedIds = new Set<string>();
  let unresolvedSymbols = 0;
  let emptyFiles = 0;

  for (const sym of input.symbols ?? []) {
    const r = resolveNodeId(db, sym);
    if (r === null) {
      unresolvedSymbols++;
      continue;
    }
    seedIds.add(r.id);
  }

  for (const file of input.files ?? []) {
    // Every node DEFINED in the file is a seed: changing the file can change any
    // of its entities, so each gets its own blast radius (they may land in the
    // same lane or different lanes depending on what they impact).
    const rows = db.handle
      .query("SELECT id FROM nodes WHERE file = ?")
      .all(file) as { id: string }[];
    if (rows.length === 0) {
      emptyFiles++;
      continue;
    }
    for (const row of rows) seedIds.add(row.id);
  }

  const seeds = [...seedIds];
  if (seeds.length === 0) {
    // Distinguish "you gave me input but none of it resolved" from "you gave me
    // nothing" so the operator can tell a typo'd symbol from an empty change-set.
    const skipped = noteSkipped(unresolvedSymbols, emptyFiles);
    return { lanes: [], note: skipped ? `no seeds (${skipped})` : "no seeds" };
  }

  /* ---------- step 2: blast radius per seed ---------- */
  // Hub detection (only when maxHubDegree is set). A node's IN-degree is how many
  // things depend on it; a node with in-degree > maxHubDegree is a HUB that would
  // otherwise couple every seed it sits under. We memoize in-degree per id so the
  // same hub probed from multiple seeds' radii costs ONE `db.incoming` query, and
  // collect the excluded hub ids for `hubsExcluded`.
  const maxHubDegree = opts?.maxHubDegree;
  const inDegreeCache = new Map<string, number>();
  const inDegree = (id: string): number => {
    let d = inDegreeCache.get(id);
    if (d === undefined) {
      d = db.incoming(id).length;
      inDegreeCache.set(id, d);
    }
    return d;
  };
  const hubsExcluded = new Set<string>();
  // A hub only matters once: cache the verdict per id (the in-degree memo already
  // does this, but this keeps the `isHub` call cheap and side-effect-collected).
  const isHub = (id: string): boolean => {
    if (maxHubDegree === undefined) return false;
    if (inDegree(id) > maxHubDegree) {
      hubsExcluded.add(id);
      return true;
    }
    return false;
  };

  const radii: SeedRadius[] = seeds.map((seed) => {
    const r = impactOf(db, seed, opts?.maxDepth);
    // Affected-symbol set = the seed itself ∪ every transitive dependent, with
    // hub nodes dropped (when maxHubDegree is set). Excluding hubs from BOTH the
    // coupling sets AND the reported sets keeps `assertDisjoint` valid even when
    // the same hub sits in two seeds' radii. A seed that IS a hub is never
    // dropped — you still need to plan a lane for the change you intend to make.
    const symbols = new Set<string>([seed]);
    for (const h of r.hits) {
      if (h.id === seed || !isHub(h.id)) symbols.add(h.id);
    }
    // File set = the distinct non-null defining files over the (hub-pruned)
    // symbol set. Because hub ids were already dropped above, their defining
    // files only survive here if a NON-hub symbol also lives in that file.
    const files = new Set<string>();
    for (const id of symbols) {
      const file = db.getNode(id)?.file;
      if (file != null) files.add(file);
    }
    return { seed, symbols, files };
  });

  /* ---------- step 3: group by overlap (union-find) ---------- */
  // Two seeds belong to the SAME lane iff their affected-symbol sets intersect
  // OR their file sets intersect. We connect them with a disjoint-set forest:
  // O(n²) pairwise overlap checks (n = seed count, small in practice) feed a
  // near-O(1) union/find. The transitive closure of that relation IS the set of
  // connected components — exactly the coupled groups we want.
  const parent = seeds.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!; // path-halving keeps find near-constant
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < radii.length; i++) {
    for (let j = i + 1; j < radii.length; j++) {
      if (overlaps(radii[i]!, radii[j]!)) union(i, j);
    }
  }

  /* ---------- step 4: emit one PlannedLane per component ---------- */
  // Bucket seed indices by their component root, then fold each bucket's radii
  // into one lane (seeds + unioned symbols + unioned files, all sorted/distinct).
  const components = new Map<number, number[]>();
  for (let i = 0; i < radii.length; i++) {
    const root = find(i);
    const bucket = components.get(root);
    if (bucket) bucket.push(i);
    else components.set(root, [i]);
  }

  let coupledSeeds = 0;
  const lanes: PlannedLane[] = [];
  for (const idxs of components.values()) {
    if (idxs.length > 1) coupledSeeds += idxs.length; // every seed in a multi-seed lane is "coupled"
    const laneSeeds: string[] = [];
    const laneSymbols = new Set<string>();
    const laneFiles = new Set<string>();
    for (const i of idxs) {
      const r = radii[i]!;
      laneSeeds.push(r.seed);
      for (const s of r.symbols) laneSymbols.add(s);
      for (const f of r.files) laneFiles.add(f);
    }
    lanes.push({
      seeds: laneSeeds.sort(),
      symbols: [...laneSymbols].sort(),
      files: [...laneFiles].sort(),
    });
  }

  // Stable lane order: by the first (lowest-sorted) seed of each lane, so the
  // plan is deterministic across runs regardless of Map iteration order. Use a
  // CODEPOINT comparator (not localeCompare, which is ICU/locale-sensitive and
  // would vary lane order across machines with different LANG) to match the
  // codepoint `.sort()` used for the lane contents above.
  lanes.sort((a, b) => {
    const x = a.seeds[0] ?? "";
    const y = b.seeds[0] ?? "";
    return x < y ? -1 : x > y ? 1 : 0;
  });

  /* ---------- step 5: defensive disjointness check ---------- */
  // By construction (connected components over the overlap relation) lanes are
  // already pairwise disjoint. This assertion is a cheap tripwire: if it ever
  // fires, the overlap relation and the grouping have diverged — a logic bug we
  // want surfaced loudly in tests, not a silently-unsafe parallel plan shipped
  // to agents that would then collide.
  assertDisjoint(lanes);

  /* ---------- step 6: human summary ---------- */
  // When hub logic ran, append the excluded-hub count to the note and surface the
  // ids. When maxHubDegree is undefined the note + return are byte-identical to
  // the original (no `hubsExcluded` key, no hub clause) — the no-hub path is
  // untouched.
  let note = buildNote(
    seeds.length,
    lanes.length,
    coupledSeeds,
    unresolvedSymbols,
    emptyFiles,
  );
  if (maxHubDegree === undefined) {
    return { lanes, note };
  }
  if (hubsExcluded.size > 0) {
    const hubWord = hubsExcluded.size === 1 ? "hub" : "hubs";
    note += `; excluded ${hubsExcluded.size} ${hubWord} from coupling`;
  }
  return { lanes, note, hubsExcluded: [...hubsExcluded].sort() };
}

/** Two seeds overlap (→ same lane) iff their symbol sets OR file sets intersect.
 *  Iterate the smaller set against the larger for cheaper membership tests. */
function overlaps(a: SeedRadius, b: SeedRadius): boolean {
  return intersects(a.symbols, b.symbols) || intersects(a.files, b.files);
}

/** True if two sets share at least one element. */
function intersects<T>(a: Set<T>, b: Set<T>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) return true;
  return false;
}

/**
 * Defensive invariant: every pair of emitted lanes is disjoint in both files
 * and symbols. Throws on violation — the planner's whole contract is that lanes
 * are safe to run concurrently, so a shared node is a correctness bug, not a
 * tolerable state.
 */
function assertDisjoint(lanes: PlannedLane[]): void {
  for (let i = 0; i < lanes.length; i++) {
    const a = lanes[i]!;
    const aSyms = new Set(a.symbols);
    const aFiles = new Set(a.files);
    for (let j = i + 1; j < lanes.length; j++) {
      const b = lanes[j]!;
      for (const s of b.symbols) {
        if (aSyms.has(s)) {
          throw new Error(
            `lane_planner: lanes ${i} and ${j} both contain symbol "${s}" — not disjoint`,
          );
        }
      }
      for (const f of b.files) {
        if (aFiles.has(f)) {
          throw new Error(
            `lane_planner: lanes ${i} and ${j} both contain file "${f}" — not disjoint`,
          );
        }
      }
    }
  }
}

/** Compose the skip-clause fragment used inside the `note`, or "" if nothing
 *  was skipped. Pluralized for readability. */
function noteSkipped(unresolvedSymbols: number, emptyFiles: number): string {
  const parts: string[] = [];
  if (unresolvedSymbols > 0) {
    parts.push(`${unresolvedSymbols} unresolved symbol${unresolvedSymbols === 1 ? "" : "s"}`);
  }
  if (emptyFiles > 0) {
    parts.push(`${emptyFiles} empty file${emptyFiles === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

/** Build the human summary: seed→lane counts, coupling, and any skips. */
function buildNote(
  seedCount: number,
  laneCount: number,
  coupledSeeds: number,
  unresolvedSymbols: number,
  emptyFiles: number,
): string {
  const seedWord = seedCount === 1 ? "seed" : "seeds";
  const laneWord = laneCount === 1 ? "lane" : "lanes";
  let note = `${seedCount} ${seedWord} → ${laneCount} disjoint ${laneWord}`;
  if (coupledSeeds > 0) {
    note += `; ${coupledSeeds} seeds coupled via shared blast radius`;
  }
  const skipped = noteSkipped(unresolvedSymbols, emptyFiles);
  if (skipped) note += ` (skipped ${skipped})`;
  return note;
}
