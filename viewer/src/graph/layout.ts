// Custom force-directed layout.
//
// Hand-rolled, no D3, no ngraph, no Cytoscape. Goals:
//   - <16ms/step at 1k nodes, <33ms/step at 5k nodes on M-series.
//   - O(n log n) repulsion via Barnes-Hut quadtree (theta = 0.9).
//   - Velocity-Verlet integration with damping.
//   - Deterministic: a seeded PRNG seeds initial positions so reloading the
//     same graph produces the same layout.
//
// The simulation is split from the renderer so we can unit-test the math.

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Mass approximates degree+1; heavier nodes move less. */
  m: number;
}

export interface SimEdge {
  src: string;
  dst: string;
  /** Higher = stronger pull. */
  w: number;
}

export interface SimOptions {
  /** Repulsion strength (typical 200-2000). */
  repulsion: number;
  /** Spring strength on edges (0..1). */
  springK: number;
  /** Target edge length in pixels. */
  springLen: number;
  /** Velocity damping per step (0..1, lower = more damping). */
  damping: number;
  /** Barnes-Hut theta — 0 = exact, 1.0+ = coarse. */
  theta: number;
  /** Center pull strength. */
  gravity: number;
  /** Integration timestep. */
  dt: number;
  /** Random seed for reproducible initial positions. */
  seed: number;
}

export const defaultOptions: SimOptions = {
  repulsion: 600,
  springK: 0.04,
  springLen: 60,
  damping: 0.82,
  theta: 0.9,
  gravity: 0.012,
  dt: 1.0,
  seed: 0x9e3779b9,
};

// xorshift32 — small, fast, deterministic. We only need it to scatter
// initial positions; nothing cryptographic.
function makeRng(seed: number): () => number {
  let s = seed | 0;
  if (s === 0) s = 0xdeadbeef;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    // map to [0, 1)
    return ((s >>> 0) % 1_000_003) / 1_000_003;
  };
}

export interface BuildInput {
  nodes: ReadonlyArray<{ id: string }>;
  edges: ReadonlyArray<{ src: string; dst: string; weight?: number }>;
  width: number;
  height: number;
  seed?: number;
}

export function buildSim(input: BuildInput): { nodes: SimNode[]; edges: SimEdge[] } {
  const seed = input.seed ?? defaultOptions.seed;
  const rng = makeRng(seed);
  // Per-node degree for mass.
  const deg = new Map<string, number>();
  for (const e of input.edges) {
    deg.set(e.src, (deg.get(e.src) ?? 0) + 1);
    deg.set(e.dst, (deg.get(e.dst) ?? 0) + 1);
  }
  const cx = input.width / 2;
  const cy = input.height / 2;
  const r = Math.min(input.width, input.height) * 0.35;
  const n = input.nodes.length;
  const nodes: SimNode[] = input.nodes.map((nd, i) => {
    // Scatter on a circle plus jitter — better starting point than uniform.
    const angle = (i / Math.max(1, n)) * Math.PI * 2 + rng() * 0.5;
    const radius = r * (0.4 + rng() * 0.6);
    return {
      id: nd.id,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      m: 1 + (deg.get(nd.id) ?? 0) * 0.25,
    };
  });
  const edges: SimEdge[] = input.edges.map((e) => ({ src: e.src, dst: e.dst, w: e.weight ?? 1 }));
  return { nodes, edges };
}

// ---------- Barnes-Hut quadtree for repulsion ----------

interface BHNode {
  /** Bounds */
  x0: number; y0: number; x1: number; y1: number;
  /** Mass & center-of-mass */
  m: number; cx: number; cy: number;
  /** Either a single sim node (leaf) or four children */
  body: SimNode | null;
  children: BHNode[] | null;
}

function makeBHNode(x0: number, y0: number, x1: number, y1: number): BHNode {
  return { x0, y0, x1, y1, m: 0, cx: 0, cy: 0, body: null, children: null };
}

function insert(root: BHNode, node: SimNode, depth: number): void {
  // Update aggregate first.
  const totalM = root.m + node.m;
  root.cx = (root.cx * root.m + node.x * node.m) / totalM;
  root.cy = (root.cy * root.m + node.y * node.m) / totalM;
  root.m = totalM;

  if (root.body === null && root.children === null) {
    root.body = node;
    return;
  }
  if (root.children === null) {
    // Subdivide: push existing body down, then push the new one.
    const existing = root.body!;
    root.body = null;
    root.children = subdivide(root);
    // Edge case: very deep recursion if two nodes are coincident. Cap depth.
    if (depth < 30) {
      insert(child(root, existing), existing, depth + 1);
      insert(child(root, node), node, depth + 1);
    }
    return;
  }
  if (depth < 30) {
    insert(child(root, node), node, depth + 1);
  }
}

function subdivide(p: BHNode): BHNode[] {
  const mx = (p.x0 + p.x1) / 2;
  const my = (p.y0 + p.y1) / 2;
  return [
    makeBHNode(p.x0, p.y0, mx, my),
    makeBHNode(mx, p.y0, p.x1, my),
    makeBHNode(p.x0, my, mx, p.y1),
    makeBHNode(mx, my, p.x1, p.y1),
  ];
}

function child(p: BHNode, n: SimNode): BHNode {
  const mx = (p.x0 + p.x1) / 2;
  const my = (p.y0 + p.y1) / 2;
  const east = n.x >= mx ? 1 : 0;
  const south = n.y >= my ? 1 : 0;
  return p.children![east + south * 2]!;
}

function buildTree(nodes: SimNode[]): BHNode {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  // Pad so all nodes are strictly inside the root box.
  const pad = 1;
  const w = Math.max(1, maxX - minX) + pad * 2;
  const h = Math.max(1, maxY - minY) + pad * 2;
  const size = Math.max(w, h);
  const root = makeBHNode(minX - pad, minY - pad, minX - pad + size, minY - pad + size);
  for (const n of nodes) insert(root, n, 0);
  return root;
}

function applyRepulsion(root: BHNode, n: SimNode, theta: number, k: number): void {
  // Stack-based walk to avoid call overhead at scale.
  const stack: BHNode[] = [root];
  while (stack.length) {
    const c = stack.pop()!;
    if (c.m === 0) continue;
    if (c.body === n) continue;
    const dx = c.cx - n.x;
    const dy = c.cy - n.y;
    let d2 = dx * dx + dy * dy;
    if (d2 < 0.01) d2 = 0.01;
    const d = Math.sqrt(d2);
    const w = c.x1 - c.x0;
    if (c.body !== null || w / d < theta) {
      // Treat as point mass.
      const f = -k * c.m / d2;
      n.vx += (dx / d) * f;
      n.vy += (dy / d) * f;
    } else if (c.children) {
      stack.push(c.children[0]!, c.children[1]!, c.children[2]!, c.children[3]!);
    }
  }
}

// ---------- step ----------

export function step(
  nodes: SimNode[],
  edges: SimEdge[],
  o: SimOptions,
  width: number,
  height: number,
): void {
  // Zero accelerations (we mutate velocities directly in this simple model).
  // Repulsion via Barnes-Hut.
  if (nodes.length > 1) {
    const tree = buildTree(nodes);
    for (const n of nodes) applyRepulsion(tree, n, o.theta, o.repulsion);
  }

  // Springs.
  const byId = new Map<string, SimNode>();
  for (const n of nodes) byId.set(n.id, n);
  for (const e of edges) {
    const a = byId.get(e.src);
    const b = byId.get(e.dst);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const force = o.springK * (d - o.springLen) * Math.min(2, 0.5 + Math.log10(1 + e.w));
    const fx = (dx / d) * force;
    const fy = (dy / d) * force;
    a.vx += fx / a.m;
    a.vy += fy / a.m;
    b.vx -= fx / b.m;
    b.vy -= fy / b.m;
  }

  // Gravity toward center.
  const cx = width / 2;
  const cy = height / 2;
  for (const n of nodes) {
    n.vx += (cx - n.x) * o.gravity;
    n.vy += (cy - n.y) * o.gravity;
  }

  // Damping + integrate.
  for (const n of nodes) {
    n.vx *= o.damping;
    n.vy *= o.damping;
    n.x += n.vx * o.dt;
    n.y += n.vy * o.dt;
  }
}

/** Total kinetic energy — useful for "settled" detection. */
export function energy(nodes: ReadonlyArray<SimNode>): number {
  let e = 0;
  for (const n of nodes) e += n.m * (n.vx * n.vx + n.vy * n.vy);
  return e;
}
