/**
 * Decode a CDP `Profiler.stop` CPU profile into caller -> callee edges.
 *
 * This is the load-bearing, fully deterministic core of the collector — the
 * `Profiler.stop` result is the only thing that varies between a live Chrome
 * and the synthetic test fixture, so everything from here down is pure and
 * unit-tested against a hand-built profile.
 *
 * ## What the CDP CPU profile looks like
 *
 * `Profiler.stop` returns `{ profile: Profile }` where (CDP `Profiler` domain):
 *
 * ```jsonc
 * {
 *   "nodes": [
 *     {
 *       "id": 1,
 *       "callFrame": { "functionName": "(root)", "url": "", "lineNumber": -1, ... },
 *       "hitCount": 0,
 *       "children": [2, 3]      // child NODE ids (the call tree edges)
 *     },
 *     { "id": 2, "callFrame": { "functionName": "login", "url": "https://app/auth.js", ... }, "hitCount": 5, "children": [4] },
 *     ...
 *   ],
 *   "startTime": 1234, "endTime": 5678,
 *   "samples":    [2, 4, 2, ...],   // node id the CPU was in at each tick (optional)
 *   "timeDeltas": [100, 100, ...]   // microseconds between ticks (optional)
 * }
 * ```
 *
 * The `nodes` array is a FLAT node list; the call TREE is reconstructed from
 * each node's `children` (a list of child node ids). Every parent -> child
 * link in that tree is a caller -> callee edge.
 *
 * ## Honest sample mapping (mirrors trace/go's pprof choice)
 *
 * The CPU profiler is a SAMPLING profiler: `hitCount` is the number of CPU
 * ticks the sampler caught executing *directly inside* that node's frame
 * (self time, not inclusive). We treat the sampled counts as ground truth with
 * **no extrapolation**:
 *
 * > `sample_rate = 1` and, for each caller -> callee edge, `observed = weight =
 * > the summed hitCount of the callee subtree under that caller`.
 *
 * Concretely an edge's `observed` is the callee node's *total* (inclusive)
 * hit count — its own `hitCount` plus all of its descendants' — i.e. how many
 * CPU samples landed anywhere inside that call while it was invoked from this
 * caller. That is the honest "how active was this edge" count. Because
 * `sample_rate == 1`, the daemon's `weight == observed * sample_rate` invariant
 * holds trivially (`weight = observed * 1`); we are NOT claiming a 1-in-N
 * extrapolation. (If `samples`/`timeDeltas` are present we could weight by
 * wall-time, but that would inflate a sampled count into a duration estimate
 * the daemon's integer-count contract does not model — so we stay on hit
 * counts, the same deliberate honesty choice trace/go makes for pprof.)
 *
 * Edges with a zero inclusive hit count (the callee subtree was never sampled)
 * are dropped — the daemon would reject an `observed: 0` as meaningless noise
 * anyway, and we only want edges we actually observed executing.
 */

const UINT16_MAX = 0xffff;

/** A V8 call frame as it appears in a CDP CPU-profile node. */
export interface CallFrame {
  functionName: string;
  /** Script URL the frame came from. Empty for synthetic frames like `(root)`. */
  url?: string;
  scriptId?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/** A single node in the CDP CPU profile's flat node list. */
export interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  /** Self-time sample count for this exact frame (NOT inclusive). */
  hitCount?: number;
  /** Child NODE ids. The parent -> child links are the call-tree edges. */
  children?: number[];
}

/** The `profile` object from a CDP `Profiler.stop` result. */
export interface CpuProfile {
  nodes: ProfileNode[];
  startTime?: number;
  endTime?: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** A derived caller -> callee edge with its honest sampled count. */
export interface ProfileEdge {
  src: string;
  dst: string;
  /** Inclusive callee-subtree hit count == observed == weight (sample_rate 1). */
  count: number;
}

/**
 * Decide whether a frame should be kept, given the configured URL/project
 * prefixes. With no prefixes we keep everything except clearly-not-project
 * frames (the GC/program/idle synthetic frames and browser/extension internals).
 *
 * `urlPrefixes`: keep only frames whose `url` starts with one of these. When
 * empty, the default drop-list below applies.
 */
export function keepFrame(frame: CallFrame, urlPrefixes: readonly string[]): boolean {
  const url = frame.url ?? "";
  const name = frame.functionName ?? "";

  // Synthetic V8 frames carry no real entity: (root), (program), (idle),
  // (garbage collector). Their functionName is parenthesized and url is empty.
  if (url === "" && name.startsWith("(") && name.endsWith(")")) return false;

  if (urlPrefixes.length > 0) {
    return urlPrefixes.some((p) => url.startsWith(p));
  }

  // No explicit scope: drop browser/runtime internals, keep page code.
  if (url.startsWith("chrome-extension://")) return false;
  if (url.startsWith("chrome://")) return false;
  if (url.startsWith("devtools://")) return false;
  if (url.startsWith("node:")) return false;
  if (url.startsWith("extensions::")) return false;
  // A frame with no url at all is typically a native/runtime builtin (e.g.
  // "(anonymous)" with no script). Drop it — it has no resolvable entity.
  if (url === "") return false;
  return true;
}

/**
 * Build the emitted node-id for a frame.
 *
 * Convention (documented in README "Entity-id resolution"): `<module>:<name>`,
 * where `<module>` is the basename of the script URL (without query/hash or
 * extension) and `<name>` is the V8 `functionName`. The TRAILING segment is the
 * function's bare name (and, when V8 reports `Type.method`, the qualified name)
 * — which is exactly what the daemon's resolver matches against the node index.
 *
 * Anonymous frames (empty `functionName`) become `<module>:(anonymous):<line>`
 * so distinct anonymous closures in the same module don't collapse together;
 * these will not resolve to a named entity but are kept as orphan observations.
 */
export function frameId(frame: CallFrame): string {
  const mod = moduleFromUrl(frame.url ?? "");
  const name = frame.functionName && frame.functionName.length > 0
    ? frame.functionName
    : `(anonymous):${frame.lineNumber ?? 0}`;
  return mod ? `${mod}:${name}` : name;
}

/** Derive a short module hint from a script URL: the basename, sans extension. */
export function moduleFromUrl(url: string): string {
  if (!url) return "";
  // Strip query and fragment.
  let u = url;
  const q = u.search(/[?#]/);
  if (q >= 0) u = u.slice(0, q);
  // Take the path basename.
  const slash = u.lastIndexOf("/");
  let base = slash >= 0 ? u.slice(slash + 1) : u;
  // Strip a single trailing extension (.js, .ts, .mjs, .jsx, ...).
  const dot = base.lastIndexOf(".");
  if (dot > 0) base = base.slice(0, dot);
  return base;
}

/**
 * Decode a CDP CPU profile into caller -> callee edges with honest sampled
 * counts. Pure and deterministic.
 *
 * Steps:
 *  1. Index nodes by id and compute each node's INCLUSIVE hit count
 *     (own hitCount + sum of children, recursively) over the call tree.
 *  2. Walk every parent -> child link. Resolve both frames through `keepFrame`.
 *     If the parent is filtered out, climb to the nearest kept ancestor so the
 *     edge connects the two nearest *project* frames (parity with the other
 *     collectors, which skip runtime frames sitting between project frames).
 *  3. The edge's count is the child's inclusive hit count. Aggregate by
 *     (src, dst) summing counts. Drop self-edges and zero-count edges.
 *  4. Clamp counts to uint16 (the daemon ceiling).
 */
export function edgesFromProfile(
  profile: CpuProfile,
  urlPrefixes: readonly string[] = [],
): ProfileEdge[] {
  const nodes = profile.nodes ?? [];
  const byId = new Map<number, ProfileNode>();
  for (const n of nodes) byId.set(n.id, n);

  // (1) Inclusive hit counts, memoized. Guard against cycles (the call tree is
  // acyclic, but a malformed peer profile must not hang us).
  const inclusive = new Map<number, number>();
  const inProgress = new Set<number>();
  const inclusiveOf = (id: number): number => {
    const cached = inclusive.get(id);
    if (cached !== undefined) return cached;
    if (inProgress.has(id)) return 0; // cycle: treat back-edge as 0
    const node = byId.get(id);
    if (!node) return 0;
    inProgress.add(id);
    let total = node.hitCount ?? 0;
    for (const childId of node.children ?? []) {
      total += inclusiveOf(childId);
    }
    inProgress.delete(id);
    inclusive.set(id, total);
    return total;
  };

  // (2)+(3) Walk parent -> child links, aggregate by (src, dst).
  const agg = new Map<string, ProfileEdge>();
  const addEdge = (src: string, dst: string, count: number): void => {
    if (!src || !dst || src === dst || count <= 0) return;
    const k = `${src}\x00${dst}`;
    const existing = agg.get(k);
    if (existing) existing.count += count;
    else agg.set(k, { src, dst, count });
  };

  for (const node of nodes) {
    for (const childId of node.children ?? []) {
      const child = byId.get(childId);
      if (!child) continue;
      if (!keepFrame(child.callFrame, urlPrefixes)) continue;

      // Climb to the nearest kept ancestor for the caller side.
      const src = nearestKeptAncestorId(node, byId, urlPrefixes);
      if (src === null) continue;
      addEdge(src, frameId(child.callFrame), inclusiveOf(childId));
    }
  }

  // (4) Clamp to uint16.
  const out: ProfileEdge[] = [];
  for (const e of agg.values()) {
    out.push({ src: e.src, dst: e.dst, count: Math.min(e.count, UINT16_MAX) });
  }
  return out;
}

/**
 * Resolve the caller-side id for a node: its own frame id if kept, otherwise
 * climb its ancestry to the nearest kept frame. Returns null if no kept
 * ancestor exists (the whole branch up to the root is filtered).
 *
 * Because the CDP node list does not carry parent pointers we build a
 * child->parent index lazily on first use and cache it on the function via a
 * module-level WeakMap keyed by the node map.
 */
const parentIndexCache = new WeakMap<Map<number, ProfileNode>, Map<number, number>>();

function parentIndex(byId: Map<number, ProfileNode>): Map<number, number> {
  let idx = parentIndexCache.get(byId);
  if (idx) return idx;
  idx = new Map<number, number>();
  for (const n of byId.values()) {
    for (const c of n.children ?? []) idx.set(c, n.id);
  }
  parentIndexCache.set(byId, idx);
  return idx;
}

function nearestKeptAncestorId(
  start: ProfileNode,
  byId: Map<number, ProfileNode>,
  urlPrefixes: readonly string[],
): string | null {
  const parents = parentIndex(byId);
  let cur: ProfileNode | undefined = start;
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (keepFrame(cur.callFrame, urlPrefixes)) return frameId(cur.callFrame);
    const pid = parents.get(cur.id);
    cur = pid === undefined ? undefined : byId.get(pid);
  }
  return null;
}
