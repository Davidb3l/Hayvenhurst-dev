/**
 * V8 CPU-profile call-tree -> caller->callee edge derivation.
 *
 * This module is the pure, deterministic, unit-testable core. It takes a V8
 * CPU `Profile` object (the shape returned by the inspector protocol's
 * `Profiler.stop`) and derives `(caller, dst, observed)` edges. It does NOT
 * touch the inspector, the network, or the clock — feed it a synthetic profile
 * and the output is fully determined.
 *
 * ## The capture model (shared with the browser collector)
 *
 * The V8 CPU profiler yields a CALL TREE flattened into `nodes[]`. Each node:
 *
 * ```
 * { id, callFrame: { functionName, scriptId, url, lineNumber, columnNumber },
 *   hitCount, children: number[] }   // children = child node IDs
 * ```
 *
 * `hitCount` is the number of CPU samples whose stack TOP was this node (the
 * function was executing at that instant). A child node under a parent means
 * the parent called the child somewhere on the sampled stack, so every
 * parent->child link is a caller->callee edge.
 *
 * ## Honest mapping (mirrors trace/go's pprof rationale)
 *
 * An edge's `observed` is the **summed hit count of the child's entire
 * subtree** — i.e. the number of samples in which control was somewhere inside
 * the callee (the callee or anything it transitively called) while the caller
 * was its parent on the tree. We then map:
 *
 * > `sample_rate = 1`, and `observed == weight == that summed sample count`.
 *
 * No 1-in-N extrapolation. The V8 sampler's interval IS the sampling; we report
 * the sampled counts as ground truth, so the daemon's `weight == observed *
 * sample_rate` invariant holds trivially (`weight = observed * 1`). Inventing a
 * `sample_rate > 1` would multiply sampled counts into invocation estimates the
 * data does not support — so we don't. This is a deliberate honesty choice
 * (PRD §4.6), not a limitation to "fix".
 *
 * Edges are aggregated by `(caller, callee)`: if the same caller->callee pair
 * appears under several tree positions (e.g. a helper called from two sites of
 * the same function), their subtree sums add.
 */

/** A single node's call frame, as emitted by V8 / the inspector protocol. */
export interface CallFrame {
  functionName?: string;
  scriptId?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/** A node in the V8 CPU-profile call tree (flattened; `children` are IDs). */
export interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  children?: number[];
}

/** The V8 CPU `Profile` object returned by `Profiler.stop`. */
export interface CpuProfile {
  nodes: ProfileNode[];
  /** Present on real profiles; unused for edge derivation. */
  samples?: number[];
  timeDeltas?: number[];
  startTime?: number;
  endTime?: number;
}

/** A derived edge: caller -> callee with a summed sample count. */
export interface DerivedEdge {
  src: string;
  dst: string;
  observed: number;
}

/** uint16 ceiling enforced by the daemon for `observed`/`weight`. */
export const UINT16_MAX = 0xffff;

/**
 * How a profile node becomes a graph node-id string.
 *
 * Synthetic V8 "program"/"idle"/"(root)"/"(garbage collector)" pseudo-frames
 * have a leading `(` and are dropped; if a `keep` predicate is supplied, frames
 * it rejects are dropped too.
 */
export interface NameResolver {
  /** Map a call frame to a `"<module>:<qualname>"` id, or `null` to drop it. */
  nameOf(frame: CallFrame): string | null;
}

/**
 * Derive caller->callee edges from a V8 CPU profile.
 *
 * Walks every parent->child link in the call tree. For each kept (caller,
 * callee) pair, `observed` is the summed hit count of the callee's entire
 * subtree (samples spent in the callee or anything it called). When a frame is
 * dropped by the resolver (e.g. a pseudo-frame or an out-of-scope module), it
 * is spliced out: its children re-attach to its nearest kept ancestor, so a
 * kept caller still connects to its kept callees across an elided frame.
 *
 * Counts are clamped to {@link UINT16_MAX} (the daemon's per-observation
 * ceiling), preserving `observed == weight` at `sample_rate = 1`.
 */
export function deriveEdges(profile: CpuProfile, resolver: NameResolver): DerivedEdge[] {
  const nodes = profile?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return [];

  const byId = new Map<number, ProfileNode>();
  for (const n of nodes) byId.set(n.id, n);

  // Subtree hit-count sum for each node id (callee weight = its own hits plus
  // everything it transitively called). Memoized; the tree may share nothing
  // but we still guard against cycles defensively.
  const subtreeSum = new Map<number, number>();
  const computing = new Set<number>();
  const sumOf = (id: number): number => {
    const cached = subtreeSum.get(id);
    if (cached !== undefined) return cached;
    if (computing.has(id)) return 0; // cycle guard (shouldn't happen in V8 trees)
    computing.add(id);
    const node = byId.get(id);
    let total = node?.hitCount ?? 0;
    for (const childId of node?.children ?? []) {
      total += sumOf(childId);
    }
    computing.delete(id);
    subtreeSum.set(id, total);
    return total;
  };

  const edges = new Map<string, number>(); // "src\x00dst" -> observed
  const addEdge = (src: string, dst: string, observed: number) => {
    if (observed <= 0 || src === dst) return;
    const k = src + "\x00" + dst;
    edges.set(k, (edges.get(k) ?? 0) + observed);
  };

  // For a given kept ancestor name, walk into a node: if the node is kept,
  // emit ancestor->node and recurse with node as the new ancestor; if dropped,
  // recurse into its children keeping the same ancestor (splice it out).
  const visited = new Set<number>();
  const walk = (ancestorName: string | null, id: number): void => {
    if (visited.has(id)) return; // tree-shape guard
    visited.add(id);
    const node = byId.get(id);
    if (!node) return;
    const name = resolver.nameOf(node.callFrame);
    let nextAncestor = ancestorName;
    if (name !== null) {
      if (ancestorName !== null) {
        // The callee's contribution is its whole subtree's samples.
        addEdge(ancestorName, name, sumOf(id));
      }
      nextAncestor = name;
    }
    for (const childId of node.children ?? []) {
      walk(nextAncestor, childId);
    }
  };

  // Roots are nodes that are not anyone's child.
  const childIds = new Set<number>();
  for (const n of nodes) for (const c of n.children ?? []) childIds.add(c);
  for (const n of nodes) {
    if (!childIds.has(n.id)) walk(null, n.id);
  }

  const out: DerivedEdge[] = [];
  for (const [key, observed] of edges) {
    const [src, dst] = key.split("\x00") as [string, string];
    out.push({ src, dst, observed: Math.min(observed, UINT16_MAX) });
  }
  return out;
}

/** A covered entity in a profile window: its resolved name + summed samples. */
export interface CoveredName {
  name: string;
  observed: number;
}

/**
 * Derive the ENTITIES a profile window executed (for per-test coverage).
 *
 * Unlike {@link deriveEdges} — which needs a kept CALLER and a kept CALLEE —
 * this collects every kept frame that appears anywhere in the call tree with a
 * non-zero subtree sample sum (i.e. control was in that function, or something
 * it called, during at least one sample). That difference is load-bearing for
 * vitest: test bodies are anonymous `it()` callbacks that V8 reports with
 * `functionName === ""`, so a project function called DIRECTLY from a test body
 * often has NO kept caller and yields no edge — but it still appears here, so
 * per-test attribution by WINDOW BOUNDARY (this module's caller tags the whole
 * window with the current test) sidesteps the anonymous-frame blindness.
 *
 * `observed` is the summed subtree hit count across the frame's tree positions
 * (same honest sample-count semantics as edges), clamped to {@link UINT16_MAX}.
 */
export function deriveCoverage(profile: CpuProfile, resolver: NameResolver): CoveredName[] {
  const nodes = profile?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return [];

  const byId = new Map<number, ProfileNode>();
  for (const n of nodes) byId.set(n.id, n);

  // Subtree hit-count sum per node (memoized; defensive cycle guard) — the
  // same accumulation deriveEdges uses for callee weights.
  const subtreeSum = new Map<number, number>();
  const computing = new Set<number>();
  const sumOf = (id: number): number => {
    const cached = subtreeSum.get(id);
    if (cached !== undefined) return cached;
    if (computing.has(id)) return 0;
    computing.add(id);
    const node = byId.get(id);
    let total = node?.hitCount ?? 0;
    for (const childId of node?.children ?? []) total += sumOf(childId);
    computing.delete(id);
    subtreeSum.set(id, total);
    return total;
  };

  const counts = new Map<string, number>();
  for (const n of nodes) {
    const name = resolver.nameOf(n.callFrame);
    if (name === null) continue;
    const observed = sumOf(n.id);
    if (observed <= 0) continue; // present in the tree but never sampled
    counts.set(name, (counts.get(name) ?? 0) + observed);
  }

  const out: CoveredName[] = [];
  for (const [name, observed] of counts) {
    out.push({ name, observed: Math.min(observed, UINT16_MAX) });
  }
  return out;
}
