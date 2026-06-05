// SVG renderer for the graph view — LOD-aware (PRD §12.3).
//
// Direct DOM (setAttribute) rather than Preact's diff for the per-frame
// position updates — cheaper than reconciling thousands of <circle> props
// every tick. Preact owns the wrapping <svg> and overlay UI; we own the
// node/edge geometry.
//
// SVG is the only renderer. There is no Canvas path. There is no fallback.
// Per PRD §16 bullet 8: "SVG is the only rendering path; no Canvas or WebGPU
// fallback." The LOD techniques (clustering, viewport culling, progressive
// rendering) plus the graceful-degradation message cover every real use case
// without the dual-codebase tax.
//
// Mount/unmount: we mount only the nodes whose indices come back from the
// culling pass. Tier transitions are a CSS class swap on the node group, not
// a re-mount, so they cost one setAttribute per affected node.

import type { SimEdge, SimNode } from "./layout";
import { type InteractionState, type Tier, tierClass, tierFor, tierIsInteractive } from "./lod";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface NodeMeta {
  id: string;
  name: string;
  kind: string;
  /** Present on cluster-level (module) nodes. */
  count?: number;
}

/**
 * Per-element handle. We keep one of these for every *mounted* node — i.e.
 * every node that was inside the viewport on the last cull pass. Out-of-view
 * nodes are absent entirely (handle deleted, DOM removed).
 */
interface NodeHandle {
  group: SVGGElement;
  circle: SVGCircleElement;
  /** Created lazily on first Tier-1+ upgrade and reused thereafter. */
  label: SVGTextElement | null;
  /** Token-bg plate behind the label so overlapping labels stay legible.
   * Created with the label, sized to its bbox. */
  labelBg: SVGRectElement | null;
  tier: Tier;
}

interface EdgeHandle {
  line: SVGLineElement;
  src: number;
  dst: number;
}

export interface SceneHandles {
  gEdges: SVGGElement;
  gNodes: SVGGElement;
  /** Mounted node handles keyed by sim-node index. */
  nodes: Map<number, NodeHandle>;
  /** Mounted edge handles keyed by sim-edge index. */
  edges: Map<number, EdgeHandle>;
}

/**
 * Initialize the scene: two child <g> elements (edges below, nodes above),
 * empty maps. Subsequent passes reconcile against this state.
 */
export function initScene(root: SVGGElement): SceneHandles {
  while (root.firstChild) root.removeChild(root.firstChild);
  const gEdges = document.createElementNS(SVG_NS, "g");
  gEdges.setAttribute("class", "hv-edges");
  const gNodes = document.createElementNS(SVG_NS, "g");
  gNodes.setAttribute("class", "hv-nodes");
  root.append(gEdges, gNodes);
  return { gEdges, gNodes, nodes: new Map(), edges: new Map() };
}

/**
 * Whether a node group currently owns keyboard focus (directly or via a focused
 * descendant). Pulled out so the tier-0 downgrade path can be unit-tested
 * without a full DOM: on downgrade we must `blur()` such a node, or focus is
 * stranded on an element that has just lost its role/tabindex.
 */
export function nodeOwnsFocus(
  group: { contains(n: Node | null): boolean },
  active: Element | null | undefined,
): boolean {
  if (!active) return false;
  return active === (group as unknown as Element) || group.contains(active as Node);
}

function colorForKind(kind: string | undefined): string {
  switch (kind) {
    case "function":
    case "method":
      return "var(--node-fn)";
    case "class":
      return "var(--node-cls)";
    case "module":
      return "var(--node-mod)";
    default:
      return "var(--node-default)";
  }
}

function makeNodeGroup(meta: NodeMeta | undefined, id: string): NodeHandle {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", tierClass(0));
  g.setAttribute("data-id", id);
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("r", "2");
  c.setAttribute("fill", colorForKind(meta?.kind));
  c.setAttribute("data-id", id);
  g.appendChild(c);
  return { group: g, circle: c, label: null, labelBg: null, tier: 0 };
}

const LABEL_X = 8;
const LABEL_Y = 3;
const LABEL_PAD_X = 3;
const LABEL_PAD_Y = 1.5;

function ensureLabel(h: NodeHandle, meta: NodeMeta | undefined, id: string): SVGTextElement {
  if (h.label) return h.label;
  // Background plate first, so it paints *under* the text. A small rounded,
  // token-bg rect keeps overlapping mid-zoom labels legible without a full
  // collision solver. Sized to the text bbox once content is set, below.
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("fill", "var(--bg-elev)");
  bg.setAttribute("rx", "3");
  bg.setAttribute("opacity", "0.82");
  bg.setAttribute("pointer-events", "none");
  h.group.appendChild(bg);
  h.labelBg = bg;

  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("font-size", "10");
  t.setAttribute("fill", "var(--fg-dim)");
  t.setAttribute("pointer-events", "none");
  // For cluster nodes, render "name (N fns)".
  const base = meta?.name ?? id;
  t.textContent = meta?.count !== undefined ? `${base} (${meta.count} fns)` : base;
  h.group.appendChild(t);
  h.label = t;
  return t;
}

/** Size the label background plate to the rendered text bbox (+ padding). */
function fitLabelBg(h: NodeHandle): void {
  const t = h.label;
  const bg = h.labelBg;
  if (!t || !bg) return;
  // getBBox throws if the element is not yet in the rendered tree; guard for
  // jsdom/headless tests where layout isn't computed.
  let w = 0;
  let h2 = 0;
  try {
    const box = t.getBBox();
    w = box.width;
    h2 = box.height;
  } catch {
    bg.setAttribute("display", "none");
    return;
  }
  if (w === 0) {
    bg.setAttribute("display", "none");
    return;
  }
  bg.removeAttribute("display");
  bg.setAttribute("x", String(LABEL_X - LABEL_PAD_X));
  bg.setAttribute("y", String(LABEL_Y - h2 + LABEL_PAD_Y));
  bg.setAttribute("width", String(w + LABEL_PAD_X * 2));
  bg.setAttribute("height", String(h2 + LABEL_PAD_Y * 2 - 2));
}

/**
 * Reconcile mounted nodes against the visible set. `visibleIdx` is the array
 * of sim-node indices the culling pass returned; anything else gets unmounted.
 */
export function reconcileNodes(
  scene: SceneHandles,
  visibleIdx: ReadonlyArray<number>,
  nodes: ReadonlyArray<SimNode>,
  meta: ReadonlyMap<string, NodeMeta>,
  zoom: number,
  ix: InteractionState,
): void {
  const visibleSet = new Set(visibleIdx);

  // Unmount everything no longer in view.
  for (const [i, h] of scene.nodes) {
    if (!visibleSet.has(i)) {
      h.group.remove();
      scene.nodes.delete(i);
    }
  }

  // Mount + position visible nodes.
  for (const i of visibleIdx) {
    const sim = nodes[i]!;
    let h = scene.nodes.get(i);
    if (!h) {
      const m = meta.get(sim.id);
      h = makeNodeGroup(m, sim.id);
      scene.gNodes.appendChild(h.group);
      scene.nodes.set(i, h);
    }
    h.group.setAttribute("transform", `translate(${sim.x.toFixed(1)} ${sim.y.toFixed(1)})`);
    const tier = tierFor(sim.id, zoom, ix);
    if (tier !== h.tier) applyTier(h, tier, meta.get(sim.id), sim.id);
  }
}

function applyTier(h: NodeHandle, tier: Tier, meta: NodeMeta | undefined, id: string): void {
  h.tier = tier;
  h.group.setAttribute("class", tierClass(tier));
  if (tier === 0) {
    h.circle.setAttribute("r", "2");
    // If this node currently holds keyboard focus, drop it before stripping the
    // tabindex/role — otherwise focus is stranded on an element that is no
    // longer announced as interactive (focusable button → bare dot).
    if (nodeOwnsFocus(h.group, h.group.ownerDocument?.activeElement)) {
      (h.group as unknown as { blur?: () => void }).blur?.();
    }
    h.group.removeAttribute("tabindex");
    h.group.removeAttribute("role");
    h.group.removeAttribute("aria-label");
    if (h.label) h.label.setAttribute("display", "none");
    if (h.labelBg) h.labelBg.setAttribute("display", "none");
    return;
  }
  // Tier 1 + Tier 2: full a11y. Tier 2 is just a bigger radius via CSS.
  if (tierIsInteractive(tier)) {
    h.group.setAttribute("tabindex", "0");
    h.group.setAttribute("role", "button");
    h.group.setAttribute("aria-label", meta?.name ?? id);
  }
  const r = tier === 2 ? "6" : "4";
  h.circle.setAttribute("r", r);
  const label = ensureLabel(h, meta, id);
  label.setAttribute("x", String(LABEL_X));
  label.setAttribute("y", String(LABEL_Y));
  label.removeAttribute("display");
  // Size the bg plate to the now-visible text. Order matters: the rect was
  // inserted before the text, so it paints underneath.
  fitLabelBg(h);
}

/**
 * Reconcile mounted edges against the visible-node set. An edge is drawn iff
 * both endpoints are mounted. Per PRD: edges are part of the "everything off
 * screen does not exist" rule too.
 */
export function reconcileEdges(
  scene: SceneHandles,
  nodes: ReadonlyArray<SimNode>,
  edges: ReadonlyArray<SimEdge>,
  idToIndex: ReadonlyMap<string, number>,
): void {
  // Determine which edges should be live.
  const liveEdges = new Set<number>();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const a = idToIndex.get(e.src);
    const b = idToIndex.get(e.dst);
    if (a === undefined || b === undefined) continue;
    if (!scene.nodes.has(a) || !scene.nodes.has(b)) continue;
    liveEdges.add(i);
  }

  // Unmount dead edges.
  for (const [i, h] of scene.edges) {
    if (!liveEdges.has(i)) {
      h.line.remove();
      scene.edges.delete(i);
    }
  }

  // Mount + position live edges.
  for (const i of liveEdges) {
    const e = edges[i]!;
    const a = idToIndex.get(e.src)!;
    const b = idToIndex.get(e.dst)!;
    let h = scene.edges.get(i);
    if (!h) {
      const l = document.createElementNS(SVG_NS, "line");
      l.setAttribute("stroke", e.w >= 10 ? "var(--edge-hot)" : "var(--edge)");
      l.setAttribute("stroke-width", "1");
      scene.gEdges.appendChild(l);
      h = { line: l, src: a, dst: b };
      scene.edges.set(i, h);
    }
    const na = nodes[a]!;
    const nb = nodes[b]!;
    h.line.setAttribute("x1", na.x.toFixed(1));
    h.line.setAttribute("y1", na.y.toFixed(1));
    h.line.setAttribute("x2", nb.x.toFixed(1));
    h.line.setAttribute("y2", nb.y.toFixed(1));
  }
}
