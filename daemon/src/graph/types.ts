/**
 * Core graph types shared between native IPC, SQLite, and markdown layers.
 */

export type NodeKind =
  | "function"
  | "method"
  | "class"
  | "struct"
  | "interface"
  | "module"
  | "constant"
  | "type"
  | "trait"
  | "enum"
  | "other";

export type EdgeKind =
  | "static_call"
  | "trace_call"
  | "import"
  | "inherits"
  | "implements"
  | "references"
  | "other";

export interface GraphNode {
  /** Stable entity ID. See `idScheme.ts`. */
  id: string;
  /** Display name (e.g. `loginHandler`). */
  name: string;
  /** Fully-qualified name from the parser (may equal `name` for top-level). */
  qualified_name: string;
  kind: NodeKind;
  language: string;
  /** Repo-relative file path. */
  file: string;
  /** Inclusive [startLine, endLine], 1-based. */
  range: [number, number];
  /** Blake3 hash of the source span. */
  ast_hash: string;
  /** Optional LLM-generated summary (markdown body). */
  summary?: string;
  /** Unix ms — last time the parser saw this entity. */
  last_seen: number;
  /** Optional logical clock value for CRDT layer. */
  logical_clock: number;
  /** Optional writer id (CRDT). */
  last_modified_by?: string;
}

export interface GraphEdge {
  src: string;
  dst: string;
  kind: EdgeKind;
  weight: number;
  last_seen: number;
}

/** Raw edge as emitted by the native binary, before ID resolution. */
export interface RawEdge {
  src_file: string;
  src_name: string;
  dst_name: string;
  kind: EdgeKind;
  weight?: number;
  /**
   * OPTIONAL (cross-lane contract — absent today). On a `static_call` edge for a
   * member call `recv.method(...)`, the receiver expression `"recv"`; `dst_name`
   * is the member name `"method"`. Bare calls `foo()` have NO `receiver`. Used by
   * Tier-2 member-access resolution; no-ops gracefully when absent.
   */
  receiver?: string;
  /**
   * OPTIONAL (cross-lane contract — absent today). On an `import` edge, the LOCAL
   * binding name(s) the import introduces
   * (`import { api, qk } from "~/api/client"` → `["api","qk"]`;
   * `import Foo from "x"` → `["Foo"]`; `import * as ns from "x"` → `["ns"]`).
   * Used by Tier-2 to map a member-call receiver back to its import specifier.
   */
  local?: string[];
  /**
   * OPTIONAL (cross-lane additive contract — absent today). 1-based LINE of a
   * call occurrence on a `static_call` edge. The native parser emits one edge
   * record per call occurrence, so (line,col) pinpoints THAT occurrence; its
   * file is `src_file`. Omitted on import edges and older binaries. Consumed by
   * the `refs --sites` line-precise call-site path (graph/ingest.ts →
   * call_sites table).
   */
  line?: number;
  /**
   * OPTIONAL (cross-lane additive contract — absent today). 1-based COLUMN of a
   * call occurrence on a `static_call` edge. See {@link RawEdge.line}.
   */
  col?: number;
}

export interface Claim {
  id: string;
  agent: string;
  scope: string[];
  fingerprint: string;
  created: number;
  ttl: number;
  intent?: string;
}

export interface Observation {
  src: string;
  dst: string;
  ts: number;
  weight: number;
}
