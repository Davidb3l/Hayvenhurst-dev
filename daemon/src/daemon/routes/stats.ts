/**
 * `GET /api/stats` — counts, last ingest time, last trace time.
 * `GET /api/merge-rejections` — the §17.2 Layer B `merge_rejected` surface:
 *   files whose pre-merge verify gate failed (CRDT still converged; this is
 *   the visible-conflict signal so an agent can re-base).
 * `GET /api/neighbors/:id` — graph edges around a node, optionally
 * collapsed to module-level groupings for the viewer's LOD renderer
 * (PRD §12.3).
 */
import { Elysia } from "elysia";

import type { ServerDependencies } from "../server.ts";

export function statsRoutes(deps: ServerDependencies) {
  return new Elysia()
    .get("/api/stats", () => {
      const counts = deps.db.counts();
      const lastIngestAt = deps.db.getStat("last_ingest_at");
      return {
        ...counts,
        traces: deps.db.observationsCount(),
        gset_ops: deps.crdt.gset.size,
        last_trace: deps.db.lastObservationTs(),
        last_ingest_at: lastIngestAt ? Number(lastIngestAt) : null,
        // §17.2 Layer B: how many files currently fail the pre-merge verify
        // gate. Non-zero means at least one merge materialized but is flagged.
        merge_rejections: deps.db.mergeRejectionCount(),
        port: deps.config.daemon_port,
      };
    })
    .get("/api/merge-rejections", ({ query }) => {
      const limit = Math.min(1000, Math.max(1, Number(query["limit"]) || 200));
      const rejections = deps.db.listMergeRejections(limit);
      return { count: rejections.length, rejections };
    })
    // Single-segment / already-encoded center ids (`conflict%2Foracle`, or a
    // slash-free id, or the `*` whole-graph sentinel).
    .get("/api/neighbors/:id", ({ params, query }) =>
      neighbors(decodeNeighborId(params.id), query),
    )
    // Raw slashed center ids (`conflict/oracle`) arrive split across path
    // segments; the wildcard rejoins them into `params["*"]`, so an agent's
    // raw-curl `…/api/neighbors/conflict/oracle` resolves the same node the
    // viewer reaches via encodeURIComponent. Mirrors `/api/nodes/*`.
    .get("/api/neighbors/*", ({ params, query }) =>
      neighbors(decodeNeighborId(params["*"]), query),
    );

  function neighbors(id: string, query: Record<string, string | undefined>) {
    // Parse depth without the falsy-zero trap: `Number("0") || 1` would
    // coerce an explicit `0` (center-only) up to `1`. Only a missing param
    // defaults to 1; NaN/garbage falls back to 0 (center-only).
    const rawDepth = query["depth"];
    const depth =
      rawDepth == null ? 1 : Math.min(5, Math.max(0, Number(rawDepth) || 0));
    const cluster = parseCluster(query["cluster"]);
    const rawScope = query["scope"];
    const scope =
      typeof rawScope === "string" && rawScope.length > 0 ? rawScope : null;
    return walkNeighbors(deps, id, depth, cluster, scope);
  }
}

/**
 * Decode a neighbor center id off the URL path. Entity ids contain `/`, so
 * an id reaches us either url-encoded in a single `:id` segment
 * (`conflict%2Foracle`) or as a raw slashed wildcard tail (`conflict/oracle`).
 * `decodeURIComponent` throws on malformed `%` escapes — fall back to the raw
 * value so a real-but-odd id still resolves (or 404s) instead of 500ing.
 * `/api/neighbors/:id` returns a 1-node stub for unknown ids by design, so no
 * separate not-found hint is needed here.
 */
function decodeNeighborId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export type ClusterMode = "auto" | "off" | "module";

function parseCluster(raw: unknown): ClusterMode {
  if (raw === "off") return "off";
  if (raw === "module") return "module";
  return "auto"; // default and any unrecognized value
}

/** When `cluster=auto`, switch from function-level to module-level above this. */
const CLUSTER_AUTO_THRESHOLD = 500;

interface RawNeighborNode {
  id: string;
  name: string;
  kind: string;
  file: string;
}

interface RawNeighborEdge {
  src: string;
  dst: string;
  weight: number;
  kind?: string;
}

interface NeighborGraph {
  center: string;
  cluster_level: "function" | "module";
  nodes: Array<{ id: string; name: string; kind: string; count?: number }>;
  edges: RawNeighborEdge[];
  total_raw_nodes: number;
}

/**
 * Test whether an entity ID is inside a scope prefix.
 * `scope=auth` matches `auth/login`, `auth/login/handler`, but not
 * `authentication/...` (we anchor on the path boundary).
 */
function inScope(id: string, scope: string): boolean {
  if (id === scope) return true;
  return id.startsWith(`${scope}/`);
}

function walkNeighbors(
  deps: ServerDependencies,
  center: string,
  depth: number,
  cluster: ClusterMode,
  scope: string | null,
): NeighborGraph {
  let raw = collectRaw(deps, center, depth);

  // Optional scope filter — only retain nodes whose ID is inside the scope
  // prefix. Edges with either endpoint outside the scope are dropped.
  if (scope !== null) {
    const keep = new Set<string>();
    for (const id of raw.nodes.keys()) {
      if (inScope(id, scope)) keep.add(id);
    }
    const filteredNodes = new Map<string, RawNeighborNode>();
    for (const id of keep) {
      const n = raw.nodes.get(id);
      if (n) filteredNodes.set(id, n);
    }
    const filteredEdges = raw.edges.filter(
      (e) => keep.has(e.src) && keep.has(e.dst),
    );
    raw = { nodes: filteredNodes, edges: filteredEdges };
  }

  const totalRaw = raw.nodes.size;

  const decision =
    cluster === "off"
      ? "function"
      : cluster === "module"
        ? "module"
        : totalRaw <= CLUSTER_AUTO_THRESHOLD
          ? "function"
          : "module";

  if (decision === "function") {
    return {
      center,
      cluster_level: "function",
      nodes: [...raw.nodes.values()].map((n) => ({
        id: n.id,
        name: n.name,
        kind: n.kind,
      })),
      edges: raw.edges,
      total_raw_nodes: totalRaw,
    };
  }

  return {
    center,
    cluster_level: "module",
    ...collapseToModules(raw),
    total_raw_nodes: totalRaw,
  };
}

interface RawNeighborhood {
  nodes: Map<string, RawNeighborNode>;
  edges: RawNeighborEdge[];
}

function collectRaw(
  deps: ServerDependencies,
  center: string,
  depth: number,
): RawNeighborhood {
  const nodes = new Map<string, RawNeighborNode>();
  const edges: RawNeighborEdge[] = [];
  // Each underlying edge row can be reached twice during BFS (once via
  // `outgoing` from its src and once via `incoming` from its dst) — dedupe.
  const seenEdges = new Set<string>();
  const addEdge = (src: string, dst: string, weight: number, kind?: string) => {
    const key = `${src}\x00${dst}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    // Thread the underlying edge row's `kind` through so function-level edges
    // carry the viewer's required `GraphEdge.kind` discriminator
    // (`"static_call" | "trace_call" | "import"`). Module-level edges set
    // `kind: "cluster"` in collapseToModules.
    edges.push({ src, dst, weight, kind });
  };
  const addNode = (id: string) => {
    if (nodes.has(id)) return;
    const row = deps.db.getNode(id);
    if (row) {
      nodes.set(id, {
        id: row.id,
        name: row.name,
        kind: row.kind,
        file: row.file ?? "",
      });
    } else {
      // Unknown ids (typically `?:foo` placeholders from unresolved edges)
      // still need to appear in the neighbor list so the viewer can render
      // a stub node, but they carry no metadata.
      nodes.set(id, { id, name: id, kind: "unknown", file: "" });
    }
  };

  // Resolved runtime-trace edges (PRD §7 gap-closing): edges the static parser
  // missed but runtime observed. Built ONCE per request — `resolvedTraceEdges()`
  // scans observations and rebuilds the resolver, so never call it per-node.
  // Only edges with BOTH endpoints resolved can join the static graph; we index
  // them by resolved src (for outgoing traversal) and by resolved dst (for
  // incoming traversal), mirroring `outgoing`/`incoming`.
  const traceOut = new Map<string, Array<{ dst: string; weight: number }>>();
  const traceIn = new Map<string, Array<{ src: string; weight: number }>>();
  const resolvedTrace: Array<{ src: string; dst: string; weight: number }> = [];
  for (const e of deps.db.resolvedTraceEdges()) {
    if (e.resolvedSrc === null || e.resolvedDst === null) continue;
    const src = e.resolvedSrc;
    const dst = e.resolvedDst;
    resolvedTrace.push({ src, dst, weight: e.weight });
    let outList = traceOut.get(src);
    if (!outList) traceOut.set(src, (outList = []));
    outList.push({ dst, weight: e.weight });
    let inList = traceIn.get(dst);
    if (!inList) traceIn.set(dst, (inList = []));
    inList.push({ src, weight: e.weight });
  }

  // `*` is the whole-graph overview sentinel (the Graph page's default
  // centerId). Seed the node set with EVERY node and its outgoing edges, then
  // let walkNeighbors's cluster=auto collapse it to a module-level overview
  // above CLUSTER_AUTO_THRESHOLD. We deliberately do NOT synthesize a `*`
  // stub — a genuinely-unknown specific id still gets the stub path below.
  if (center === "*") {
    const allIds = deps.db.allNodeIds();
    for (const id of allIds) addNode(id);
    // Snapshot before iterating: addNode may stub previously-unseen dst nodes
    // (mutating `nodes` mid-iteration), so walk the fixed seed list.
    for (const id of allIds) {
      // `outgoing` alone covers every edge exactly once across all seeded
      // nodes (a dst we don't know about still gets stubbed via addNode).
      for (const e of deps.db.outgoing(id)) {
        addEdge(e.src, e.dst, e.weight, e.kind);
        if (!nodes.has(e.dst)) addNode(e.dst);
      }
    }
    // Mirror the static `outgoing` loop for resolved trace edges. STATIC WINS:
    // these run after every static edge is added, so `seenEdges` already holds
    // any pair the static graph covered and `addEdge` skips it. A trace-only
    // endpoint the static parser never indexed still gets stubbed via addNode.
    for (const e of resolvedTrace) {
      addEdge(e.src, e.dst, e.weight, "trace_call");
      if (!nodes.has(e.src)) addNode(e.src);
      if (!nodes.has(e.dst)) addNode(e.dst);
    }
    return { nodes, edges };
  }

  addNode(center);
  const frontier = new Set<string>([center]);

  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    // STATIC FIRST so static edges reliably win the `seenEdges` dedup over the
    // trace edges for the same frontier step.
    for (const id of frontier) {
      for (const e of deps.db.outgoing(id)) {
        addEdge(e.src, e.dst, e.weight, e.kind);
        if (!nodes.has(e.dst)) {
          addNode(e.dst);
          next.add(e.dst);
        }
      }
      for (const e of deps.db.incoming(id)) {
        addEdge(e.src, e.dst, e.weight, e.kind);
        if (!nodes.has(e.src)) {
          addNode(e.src);
          next.add(e.src);
        }
      }
    }
    // Then traverse resolved trace edges from the same frontier — outgoing
    // (`resolvedSrc==id → resolvedDst`) and incoming (`resolvedDst==id →
    // resolvedSrc`) — pulling runtime-only callers/callees the static parser
    // missed into the neighborhood. `addEdge` drops any pair static already
    // added (static wins), so trace edges only ADD pairs the static graph lacks.
    for (const id of frontier) {
      for (const e of traceOut.get(id) ?? []) {
        addEdge(id, e.dst, e.weight, "trace_call");
        if (!nodes.has(e.dst)) {
          addNode(e.dst);
          next.add(e.dst);
        }
      }
      for (const e of traceIn.get(id) ?? []) {
        addEdge(e.src, id, e.weight, "trace_call");
        if (!nodes.has(e.src)) {
          addNode(e.src);
          next.add(e.src);
        }
      }
    }
    frontier.clear();
    for (const n of next) frontier.add(n);
  }

  return { nodes, edges };
}

/**
 * Group nodes by the directory portion of their `file` field.
 *
 * - The module id is the directory path (e.g. `src/auth`).
 * - Edges are remapped from function-id endpoints to module-id endpoints
 *   and self-loops are dropped (the viewer renders intra-module weight
 *   via the node's `count`, not as an edge).
 * - Weights are summed when multiple raw edges collapse to the same
 *   `(src_module, dst_module)` pair.
 */
function collapseToModules(raw: RawNeighborhood): {
  nodes: Array<{ id: string; name: string; kind: string; count: number }>;
  edges: RawNeighborEdge[];
} {
  const idToModule = new Map<string, string>();
  const modules = new Map<string, { count: number; name: string }>();

  for (const n of raw.nodes.values()) {
    const mod = moduleIdFor(n);
    idToModule.set(n.id, mod);
    const entry = modules.get(mod);
    if (entry) {
      entry.count++;
    } else {
      modules.set(mod, { count: 1, name: mod === "" ? "(unknown)" : mod });
    }
  }

  const edgeSums = new Map<string, RawNeighborEdge>();
  for (const e of raw.edges) {
    const src = idToModule.get(e.src) ?? e.src;
    const dst = idToModule.get(e.dst) ?? e.dst;
    if (src === dst) continue; // collapse intra-module edges into node `count`
    const key = `${src}\x00${dst}`;
    const prior = edgeSums.get(key);
    if (prior) prior.weight += e.weight;
    else edgeSums.set(key, { src, dst, weight: e.weight, kind: "cluster" });
  }

  return {
    nodes: [...modules.entries()].map(([id, m]) => ({
      id,
      name: m.name,
      kind: "module",
      count: m.count,
    })),
    edges: [...edgeSums.values()],
  };
}

/** Directory of `node.file`, or empty string if unknown. */
function moduleIdFor(n: RawNeighborNode): string {
  if (!n.file) return "";
  const slash = n.file.lastIndexOf("/");
  if (slash <= 0) return n.file;
  return n.file.slice(0, slash);
}
