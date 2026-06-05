// Wire types for the daemon API. Keep these aligned with the contract in
// HAYVENHURST_PRD.md §12 and the daemon's HTTP handlers.

export type NodeId = string;

export type NodeKind = "function" | "class" | "module" | "method" | "type" | "unknown";

export interface NodeRange {
  start: number;
  end: number;
}

export interface NodeRef {
  id: NodeId;
  name?: string;
  kind?: NodeKind;
  weight?: number;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  native_version: string;
  /**
   * Repo root the daemon is serving. The daemon's /api/health route returns
   * this; older daemons may omit it, so keep it optional and never depend on
   * its presence. (Cross-lane contract: a parallel change adds `root`.)
   */
  root?: string;
}

export interface PeerStatus {
  id: string;
  url: string;
  status: "ok" | "stale" | "unreachable";
  last_sync?: string;
}

export interface StatsResponse {
  nodes: number;
  edges: number;
  traces: number;
  /**
   * Last ingest time. The live daemon sends `last_ingest_at` as epoch-ms
   * (number); `api.stats` maps it onto this field. `new Date(value)` accepts
   * both a number and an ISO string, so the consuming UI is unchanged.
   */
  last_ingest: string | number | null;
  /**
   * The live daemon does not send peers; `api.stats` defaults this to `[]`.
   * Optional so honest about that and so the mock can still populate it.
   */
  peers?: PeerStatus[];
  recent_activity?: ActivityEntry[];
}

export interface ActivityEntry {
  ts: string;
  kind: "ingest" | "sync" | "trace" | "claim";
  summary: string;
}

export interface NodeDetail {
  id: NodeId;
  kind: NodeKind;
  language: string;
  file: string;
  range: NodeRange;
  body_md: string;
  callers: NodeRef[];
  callees: NodeRef[];
  trace_count?: number;
}

export interface SearchHit {
  id: NodeId;
  name: string;
  snippet: string;
  score: number;
}

export interface SearchResponse {
  hits: SearchHit[];
}

export interface GraphNode {
  id: NodeId;
  name: string;
  kind: NodeKind;
  file?: string;
  /**
   * When the daemon returns a cluster-level node (e.g. cluster_level=="module"),
   * `count` is the number of underlying nodes folded into this cluster. Absent
   * on individual function/method/class nodes.
   */
  count?: number;
}

export interface GraphEdge {
  src: NodeId;
  dst: NodeId;
  /**
   * "import" / "static_call" / "trace_call" for function-level edges.
   * "cluster" for aggregated edges between module-level clusters.
   */
  kind: "static_call" | "trace_call" | "import" | "cluster";
  weight: number;
  /** Epoch-ms of the last observation. Present on live function-mode edges. */
  last_seen?: number;
}

/**
 * The semantic-clustering granularity the daemon chose (or the user requested).
 *   - "function": individual functions/methods/classes, no aggregation.
 *   - "module":   aggregated by file/path prefix.
 * The viewer surfaces three user-facing modes (auto/off/module) which map to
 * the `?cluster=` query param; the daemon echoes back the actual level used.
 */
export type ClusterLevel = "function" | "module";

/** UI-side selection that maps to the daemon's `?cluster=` param. */
export type ClusterMode = "auto" | "off" | "module";

export interface NeighborsResponse {
  center: NodeId;
  cluster_level: ClusterLevel;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Count of underlying (function-level) nodes the query touched, before any
   * clustering was applied. Drives the graceful-degradation threshold:
   * `total_raw_nodes > 2000 && cluster_level === "function"` triggers the
   * action-prompt UI instead of rendering the graph.
   */
  total_raw_nodes: number;
}

/** Options accepted by the neighbors API. */
export interface NeighborsQuery {
  depth?: number;
  cluster?: ClusterMode;
  /** Optional path-prefix scope, used by "expand a single module" interactions. */
  scope?: string;
}

export interface Claim {
  id: string;
  agent: string;
  scope: NodeId[];
  intent: string;
  created: string;
  ttl: string;
}

export interface ClaimsResponse {
  claims: Claim[];
}
