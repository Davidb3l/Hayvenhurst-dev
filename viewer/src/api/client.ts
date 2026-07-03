// Daemon API client.
//
// The viewer is served from the same origin as the daemon (localhost:7777),
// so all requests are relative. In `bun run dev` (no daemon running) we fall
// back to the in-memory mock dataset.
//
// Originally this module wired up @tanstack/query-core. After bundle
// measurement we replaced it with a small hand-rolled cache (~80 lines in
// `components/useQuery.ts`) — see the comment there for rationale.

import type {
  ClaimsResponse,
  GraphEdge,
  HealthResponse,
  NeighborsQuery,
  NeighborsResponse,
  NodeDetail,
  NodeId,
  NodeKind,
  NodeRef,
  SearchHit,
  SearchResponse,
  StatsResponse,
} from "./types";
import { mockClaims, mockHealth, mockNeighbors, mockNode, mockSearch, mockStats } from "./mocks";

const API_BASE = ""; // same-origin

// Multi-project selection. The daemon serves several repos from one instance,
// selected per-request via `?project=<alias>`. We persist the chosen alias in
// localStorage so it survives reloads; an empty string means "daemon default".
// Guarded for SSR / no-localStorage (this module runs in an Astro island).
const PROJECT_KEY = "hv-project";

export function getSelectedProject(): string {
  try {
    if (typeof localStorage === "undefined") return "";
    return localStorage.getItem(PROJECT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setSelectedProject(alias: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PROJECT_KEY, alias);
  } catch {
    /* private mode / no storage — ignore */
  }
}

// Appends `project=<alias>` to a request path, using `?` or `&` as appropriate.
function withProject(path: string): string {
  const alias = getSelectedProject();
  if (!alias) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}project=${encodeURIComponent(alias)}`;
}

let _liveProbe: Promise<boolean> | null = null;

async function isDaemonLive(): Promise<boolean> {
  if (typeof window === "undefined") return false; // SSG: always mock
  if (_liveProbe) return _liveProbe;
  _liveProbe = (async () => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 250);
      const r = await fetch(API_BASE + "/api/health", { signal: ctl.signal });
      clearTimeout(t);
      return r.ok;
    } catch {
      return false;
    }
  })();
  return _liveProbe;
}

// Fetches `path` and returns the parsed JSON. Two paths:
//   - offline (no live daemon): return the mock, already in declared shape `T`.
//   - live: parse the raw daemon JSON (shape `L`) and run it through `adapt`.
// The adapter is where we reconcile real-daemon drift against the `T` the
// viewer components consume. When the live wire shape already equals `T`, the
// caller omits `adapt` and we blind-cast as before.
async function getJson<T, L = T>(
  path: string,
  mock: () => T | Promise<T>,
  adapt?: (live: L) => T,
): Promise<T> {
  const live = await isDaemonLive();
  if (!live) return Promise.resolve(mock());
  const r = await fetch(API_BASE + withProject(path), { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  const json = await r.json();
  return adapt ? adapt(json as L) : (json as T);
}

// ── Live daemon wire shapes ─────────────────────────────────────────────────
// These describe what the REAL daemon sends today (verified via curl). They
// intentionally differ from the declared component-facing types; the adapters
// below bridge the gap. Keep these in sync with the daemon HTTP handlers.

interface LiveStats {
  nodes: number;
  edges: number;
  claims?: number;
  traces: number;
  gset_ops?: number;
  last_trace?: unknown;
  last_ingest_at: number | null;
  merge_rejections?: number;
  port?: number;
}

interface LiveSearchHit {
  id: string;
  name: string;
  qualified_name?: string;
  summary?: string;
  rank: number;
}

interface LiveSearchResponse {
  query?: string;
  count?: number;
  hits: LiveSearchHit[];
}

interface LiveNode {
  id: string;
  name: string;
  qualified_name?: string;
  kind: NodeKind;
  language: string;
  file: string;
  range: [number, number];
  ast_hash?: string;
  last_seen?: number;
  logical_clock?: number;
}

interface LiveNodeResponse {
  node: LiveNode;
  neighbors: { callers: GraphEdge[]; callees: GraphEdge[] };
  markdown: string;
}

// ── Adapters: live wire shape → declared component-facing type ───────────────

export function adaptStats(live: LiveStats): StatsResponse {
  return {
    nodes: live.nodes,
    edges: live.edges,
    traces: live.traces,
    // Server sends epoch-ms (number) or null; `new Date(number)` is fine.
    last_ingest: live.last_ingest_at ?? null,
    // Server never sends peers; default to empty so the UI guard holds.
    peers: [],
    // recent_activity intentionally left absent — server doesn't send it.
  };
}

export function adaptSearch(live: LiveSearchResponse): SearchResponse {
  const hits: SearchHit[] = (live.hits ?? []).map((h) => ({
    id: h.id,
    name: h.name,
    snippet: h.summary ?? "",
    score: h.rank,
  }));
  return { hits };
}

export function adaptNode(live: LiveNodeResponse): NodeDetail {
  const n = live.node;
  const [start, end] = n.range;
  // For a caller edge, the "other" node is the source (it calls us); for a
  // callee edge, it's the destination (we call it). `kind` may be briefly
  // missing while the daemon side rolls out — default it defensively.
  const toRef = (e: GraphEdge, other: "src" | "dst"): NodeRef => {
    const otherId = e[other];
    return {
      id: otherId,
      name: otherId.split("/").pop() ?? otherId,
      kind: edgeKindToNodeKind(e.kind),
      weight: e.weight,
    };
  };
  return {
    id: n.id,
    kind: n.kind,
    language: n.language,
    file: n.file,
    range: { start, end },
    body_md: stripFrontmatter(live.markdown),
    callers: (live.neighbors?.callers ?? []).map((e) => toRef(e, "src")),
    callees: (live.neighbors?.callees ?? []).map((e) => toRef(e, "dst")),
  };
}

// The daemon's node markdown leads with a YAML frontmatter block (`---\n…\n---`)
// whose fields (id, file, range, ast_hash, …) are already shown in the detail
// header. Strip it so the rendered body starts at the human content (the `#`
// heading), instead of dumping the raw frontmatter as a paragraph.
function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length).replace(/^\s+/, "") : md;
}

// The edge `kind` (e.g. "static_call") is not a NodeKind. NodeRef.kind is
// optional and only used as a hint by the detail view, so we leave it
// undefined rather than mislabel it. Kept as a seam in case a future daemon
// surfaces the neighbor's true node kind on the edge.
function edgeKindToNodeKind(_kind: GraphEdge["kind"] | undefined): NodeKind | undefined {
  return undefined;
}

export const api = {
  health: (): Promise<HealthResponse> => getJson("/api/health", () => mockHealth()),
  stats: (): Promise<StatsResponse> =>
    getJson<StatsResponse, LiveStats>("/api/stats", () => mockStats(), adaptStats),
  node: (id: NodeId): Promise<NodeDetail> =>
    getJson<NodeDetail, LiveNodeResponse>(
      `/api/nodes/${encodeURIComponent(id)}`,
      () => mockNode(id),
      adaptNode,
    ),
  search: (q: string): Promise<SearchResponse> =>
    getJson<SearchResponse, LiveSearchResponse>(
      `/api/search?q=${encodeURIComponent(q)}`,
      () => mockSearch(q),
      adaptSearch,
    ),
  neighbors: (id: NodeId, opts: NeighborsQuery = {}): Promise<NeighborsResponse> => {
    const qs = neighborsQs(opts);
    const path = `/api/neighbors/${encodeURIComponent(id)}${qs}`;
    return getJson(path, () => mockNeighbors(id, opts));
  },
  claims: (): Promise<ClaimsResponse> => getJson("/api/claims", () => mockClaims()),
};

function neighborsQs(opts: NeighborsQuery): string {
  const parts: string[] = [];
  if (opts.depth !== undefined) parts.push("depth=" + encodeURIComponent(String(opts.depth)));
  // Default to cluster=auto when caller didn't specify — matches PRD §12.3.
  parts.push("cluster=" + encodeURIComponent(opts.cluster ?? "auto"));
  if (opts.scope) parts.push("scope=" + encodeURIComponent(opts.scope));
  return parts.length ? "?" + parts.join("&") : "";
}

// Query keys, centralized.
export const qk = {
  health: (): ReadonlyArray<unknown> => ["health"],
  stats: (): ReadonlyArray<unknown> => ["stats"],
  node: (id: NodeId): ReadonlyArray<unknown> => ["node", id],
  search: (q: string): ReadonlyArray<unknown> => ["search", q],
  // Cluster mode is part of the key so toggling re-fetches; scope/depth too.
  neighbors: (id: NodeId, opts: NeighborsQuery = {}): ReadonlyArray<unknown> => [
    "neighbors",
    id,
    opts.cluster ?? "auto",
    opts.depth ?? null,
    opts.scope ?? null,
  ],
  claims: (): ReadonlyArray<unknown> => ["claims"],
};
