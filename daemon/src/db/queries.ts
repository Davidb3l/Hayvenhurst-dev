/**
 * Typed query helpers around `bun:sqlite`.
 *
 * All prepared statements are reused via a small cache on the {@link Db}
 * wrapper. We avoid an ORM on purpose — the schema is tiny and stable.
 */
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";

import type { GraphEdge, GraphNode, NodeKind } from "../graph/types.ts";
import {
  buildTraceResolver,
  type ResolvedTraceEdge,
} from "../graph/traceResolve.ts";
import { migrate, type MigrationResult } from "./migrations.ts";
import { FTS_SQL, FTS_TRIGGERS_SQL } from "./schema.ts";

export interface NodeRow {
  id: string;
  name: string;
  qualified_name: string;
  kind: string;
  language: string | null;
  file: string | null;
  range_start: number;
  range_end: number;
  ast_hash: string | null;
  summary: string | null;
  last_seen: number | null;
  logical_clock: number;
  last_modified_by: string | null;
  /** §17.2 Layer B: 1 when this node's file failed the pre-merge verify gate. */
  merge_flagged: number;
}

/**
 * Explicit column projection for {@link NodeRow}, in schema order.
 *
 * We deliberately do NOT `SELECT *`. `bun:sqlite` caches prepared statements
 * per `Database`, and a cached `SELECT *` snapshots its column set at prepare
 * time: once a migration runs `ALTER TABLE nodes ADD COLUMN` (e.g. the v2→v3
 * `merge_flagged` add in migrations.ts), an already-prepared `SELECT *` keeps
 * returning the pre-ALTER columns for the life of that handle. Listing columns
 * explicitly pins the read to {@link NodeRow}, survives ALTERs, and skips the
 * unused `embedding` BLOB so reads don't haul it off disk. Keep in lockstep
 * with {@link NodeRow} and the `nodes` table in schema.ts.
 */
const NODE_COLUMNS =
  "id, name, qualified_name, kind, language, file, range_start, range_end, " +
  "ast_hash, summary, last_seen, logical_clock, last_modified_by, merge_flagged";

/** §17.2 Layer B: a row of the `merge_rejected` surface. */
export interface MergeRejectionRow {
  file: string;
  phase: string;
  language: string;
  reason: string;
  detected_at: number;
}

export interface EdgeRow {
  src: string;
  dst: string;
  kind: string;
  weight: number;
  last_seen: number | null;
}

/** Explicit projection for {@link EdgeRow}; see {@link NODE_COLUMNS} for why
 *  application reads never use `SELECT *`. Keep in sync with {@link EdgeRow}. */
const EDGE_COLUMNS = "src, dst, kind, weight, last_seen";

/**
 * One row of the `call_sites` table (schema v5): a single RESOLVED call
 * OCCURRENCE with its 1-based (file, line, col). `dst` is the called symbol (the
 * lookup key for `refs --sites`); `src` is the caller entity. Where `edges`
 * dedups occurrences into one summed-`weight` row, `call_sites` keeps each one
 * so the exact `file:line:col` locations can be listed.
 */
export interface CallSiteRow {
  dst: string;
  src: string;
  kind: string;
  file: string | null;
  line: number | null;
  col: number | null;
}

/** Explicit projection for {@link CallSiteRow}. Keep in sync. */
const CALL_SITE_COLUMNS = "dst, src, kind, file, line, col";

export class Db {
  readonly handle: Database;

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    this.handle = new Database(path, { readonly: opts.readonly ?? false, create: !opts.readonly });
    // recursive_triggers is a PER-CONNECTION setting REQUIRED for the
    // fleet_memory→fleet_memory_fts sync to stay correct: `recordMemory` writes via
    // INSERT OR REPLACE, and SQLite only fires the AFTER DELETE trigger on a REPLACE
    // when recursive_triggers is ON (otherwise a re-record leaves a stale/duplicate
    // FTS row). SCHEMA_SQL sets it too, but `migrate()` is NOT called on every write
    // path — the daemonless `hayven memory` CLI opens via `openProjectDb` WITHOUT
    // migrating — so we set it here on every WRITE connection to make the sync
    // correct universally. Skipped for readonly (triggers never fire), and safe
    // globally: `fleet_memory` is the ONLY INSERT OR REPLACE in the schema and no
    // trigger fires another trigger (so no recursion is introduced).
    if (!(opts.readonly ?? false)) this.handle.exec("PRAGMA recursive_triggers = ON");
  }

  migrate(): MigrationResult {
    return migrate(this.handle);
  }

  close(): void {
    this.handle.close();
  }

  /** Wrap a function in a transaction. */
  transaction<T>(fn: () => T): T {
    const tx = this.handle.transaction(fn);
    return tx();
  }

  /**
   * Run `fn` with the nodes→`nodes_fts` sync triggers DROPPED, then recreate
   * them. Use this around any BULK node delete.
   *
   * Why: `nodes_fts` is a trigram FTS5 table with `id UNINDEXED`, so the per-row
   * AFTER DELETE trigger (`DELETE FROM nodes_fts WHERE id = old.id`) full-SCANS
   * the entire FTS table ONCE PER deleted node — O(deleted × total). Measured on
   * a 135K-node index: deleting ~1K nodes took 26s via the trigger vs 0.7s when
   * the FTS rows are deleted SET-BASED with the trigger off (~40×). `fn` MUST
   * delete the matching `nodes_fts` rows itself (the trigger won't fire). Callers
   * run inside a transaction so a throw rolls back the DROP (triggers restored);
   * `migrate()` also re-ensures them on open as a backstop. */
  private withoutFtsTriggers<T>(fn: () => T): T {
    this.handle.exec(
      "DROP TRIGGER IF EXISTS nodes_fts_ai;" +
        "DROP TRIGGER IF EXISTS nodes_fts_ad;" +
        "DROP TRIGGER IF EXISTS nodes_fts_au;",
    );
    try {
      return fn();
    } finally {
      this.handle.exec(FTS_TRIGGERS_SQL);
    }
  }

  /**
   * Clear the whole graph (nodes + edges + the FTS index) for a from-scratch
   * re-ingest. Bypasses the per-row FTS delete trigger (see
   * {@link withoutFtsTriggers}) and clears the FTS index by DROP+recreate (O(1),
   * vs `DELETE FROM nodes` firing the trigger once per node = O(nodes × FTS
   * scan) — the >30min `--full` pathology on a populated large index). `nodes_fts`
   * is a regular (non-contentless) FTS5 table, so the `'delete-all'` command is
   * unavailable; dropping + re-creating the empty table is the fast clear. The
   * subsequent re-insert repopulates it through the (recreated) INSERT trigger. */
  clearGraph(): void {
    this.transaction(() => {
      this.withoutFtsTriggers(() => {
        this.handle.exec("DELETE FROM edges; DELETE FROM nodes; DROP TABLE IF EXISTS nodes_fts;");
        this.handle.exec(FTS_SQL); // recreate the empty FTS table
      });
    });
  }

  /* ---------- node CRUD ---------- */

  upsertNode(node: GraphNode): void {
    UPSERT_NODE_STMT(this.handle).run(
      node.id,
      node.name,
      node.qualified_name,
      node.kind,
      node.language,
      node.file,
      node.range[0],
      node.range[1],
      node.ast_hash,
      node.summary ?? null,
      node.last_seen,
      node.logical_clock,
      node.last_modified_by ?? null,
    );
  }

  upsertNodes(nodes: Iterable<GraphNode>): number {
    let count = 0;
    this.transaction(() => {
      const stmt = UPSERT_NODE_STMT(this.handle);
      for (const n of nodes) {
        stmt.run(
          n.id,
          n.name,
          n.qualified_name,
          n.kind,
          n.language,
          n.file,
          n.range[0],
          n.range[1],
          n.ast_hash,
          n.summary ?? null,
          n.last_seen,
          n.logical_clock,
          n.last_modified_by ?? null,
        );
        count++;
      }
    });
    return count;
  }

  getNode(id: string): NodeRow | null {
    return GET_NODE_STMT(this.handle).get(id) ?? null;
  }

  allNodeIds(): string[] {
    return ALL_NODE_IDS_STMT(this.handle)
      .all()
      .map((r) => r.id);
  }

  deleteNode(id: string): void {
    DELETE_NODE_STMT(this.handle).run(id);
  }

  /**
   * Remove every node belonging to a repo-relative file, plus any edges that
   * originate from those nodes. Used by the watcher's incremental re-ingest
   * to reconcile deleted files and entities removed from a modified file —
   * the parse-and-upsert path is additive and would otherwise leave stale
   * rows forever. Returns the number of node rows removed.
   */
  deleteNodesByFile(file: string): number {
    return this.transaction(() => {
      // Drop edges whose source node lives in this file (dst-side edges get
      // re-resolved on the next ingest; a dangling dst is already a tolerated
      // state — see ARCHITECTURE.md §7).
      this.handle
        .query("DELETE FROM edges WHERE src IN (SELECT id FROM nodes WHERE file = ?)")
        .run(file);
      const before = this.handle
        .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM nodes WHERE file = ?")
        .get(file);
      // Delete the FTS rows SET-BASED with the per-row trigger bypassed: the
      // trigger's `WHERE id = old.id` scans the whole trigram FTS table per node
      // (id is UNINDEXED) → O(deleted × total). One `id IN (…)` statement is a
      // single scan instead (measured ~40× faster on a 135K-node index). MUST
      // run BEFORE deleting the nodes (the subquery reads them).
      this.withoutFtsTriggers(() => {
        this.handle
          .query("DELETE FROM nodes_fts WHERE id IN (SELECT id FROM nodes WHERE file = ?)")
          .run(file);
        this.handle.query("DELETE FROM nodes WHERE file = ?").run(file);
      });
      return before?.c ?? 0;
    });
  }

  /* ---------- §17.2 Layer B: merge-rejection surface ---------- */

  /**
   * Clear any prior verify-gate state for these files: drop their
   * `merge_rejections` rows and reset `nodes.merge_flagged`. Called at the
   * START of a gated re-ingest so a file that now passes loses its stale
   * rejection (the gate is re-evaluated every ingest).
   */
  clearMergeState(files: Iterable<string>): void {
    this.transaction(() => {
      const delRej = this.handle.query("DELETE FROM merge_rejections WHERE file = ?");
      const clrFlag = this.handle.query("UPDATE nodes SET merge_flagged = 0 WHERE file = ?");
      for (const f of files) {
        delRej.run(f);
        clrFlag.run(f);
      }
    });
  }

  /**
   * Record one batch of merge rejections (the `merge_rejected` surface) AND
   * flag the affected files' surviving node rows. Upserts by (file, phase) so
   * re-running the gate refreshes rather than duplicates. Returns rows written.
   */
  recordMergeRejections(rows: Iterable<MergeRejectionRow>): number {
    let count = 0;
    this.transaction(() => {
      const ins = INSERT_MERGE_REJECTION_STMT(this.handle);
      const flag = this.handle.query("UPDATE nodes SET merge_flagged = 1 WHERE file = ?");
      for (const r of rows) {
        ins.run(r.file, r.phase, r.language, r.reason, r.detected_at);
        flag.run(r.file);
        count++;
      }
    });
    return count;
  }

  /** Read the `merge_rejected` surface, newest first. */
  listMergeRejections(limit = 200): MergeRejectionRow[] {
    return this.handle
      .query<MergeRejectionRow, [number]>(
        `SELECT file, phase, language, reason, detected_at
           FROM merge_rejections ORDER BY detected_at DESC LIMIT ?`,
      )
      .all(Math.max(0, Math.trunc(limit)));
  }

  /** Count of currently-flagged merge rejections. */
  mergeRejectionCount(): number {
    return (
      this.handle
        .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM merge_rejections")
        .get()?.c ?? 0
    );
  }

  /* ---------- edge CRUD ---------- */

  upsertEdge(edge: GraphEdge): void {
    UPSERT_EDGE_STMT(this.handle).run(edge.src, edge.dst, edge.kind, edge.weight, edge.last_seen);
  }

  upsertEdges(edges: Iterable<GraphEdge>): number {
    let count = 0;
    this.transaction(() => {
      const stmt = UPSERT_EDGE_STMT(this.handle);
      for (const e of edges) {
        stmt.run(e.src, e.dst, e.kind, e.weight, e.last_seen);
        count++;
      }
    });
    return count;
  }

  /** Outgoing edges where `src = id`. */
  outgoing(id: string): EdgeRow[] {
    return OUTGOING_STMT(this.handle).all(id);
  }

  /** Incoming edges where `dst = id`. */
  incoming(id: string): EdgeRow[] {
    return INCOMING_STMT(this.handle).all(id);
  }

  /* ---------- call sites (schema v5) ---------- */

  /**
   * Insert a batch of per-occurrence call sites in one transaction. UNLIKE
   * `upsertEdges`, these are plain INSERTs (no conflict target) — each row is a
   * distinct occurrence and the ingest path manages duplicates by clearing
   * before a rebuild (see {@link clearCallSites}/{@link deleteCallSitesByFile}).
   * Returns the number of rows written.
   */
  insertCallSites(rows: Iterable<CallSiteRow>): number {
    let count = 0;
    this.transaction(() => {
      const stmt = INSERT_CALL_SITE_STMT(this.handle);
      for (const s of rows) {
        stmt.run(s.dst, s.src, s.kind, s.file, s.line, s.col);
        count++;
      }
    });
    return count;
  }

  /** Remove ALL call sites. Called at the start of a FULL ingest rebuild, the
   *  same clear-then-rewrite contract the ingest uses for edges. */
  clearCallSites(): void {
    this.handle.query("DELETE FROM call_sites").run();
  }

  /**
   * Remove call sites whose CALLER (`src`) lives in any of `srcFiles`, so an
   * incremental `--files` re-ingest can replace just those files' sites without
   * touching the rest. We key on the caller's file: a call site's location IS in
   * the caller's source, so re-parsing that file supersedes its old sites.
   * Returns rows removed.
   */
  deleteCallSitesByFile(srcFiles: Iterable<string>): number {
    return this.transaction(() => {
      const del = this.handle.query<unknown, [string]>(
        "DELETE FROM call_sites WHERE file = ?",
      );
      let removed = 0;
      for (const f of srcFiles) {
        const before = this.handle
          .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM call_sites WHERE file = ?")
          .get(f);
        del.run(f);
        removed += before?.c ?? 0;
      }
      return removed;
    });
  }

  /** EXHAUSTIVE call sites of `dst`, ordered by (file, line, col) for stable,
   *  line-precise output. Each row is one call occurrence. */
  callSitesOf(dst: string): CallSiteRow[] {
    return CALL_SITES_OF_STMT(this.handle).all(dst);
  }

  /* ---------- stats ---------- */

  setStat(key: string, value: string): void {
    SET_STAT_STMT(this.handle).run(key, value);
  }
  getStat(key: string): string | null {
    return GET_STAT_STMT(this.handle).get(key)?.value ?? null;
  }

  counts(): { nodes: number; edges: number; claims: number } {
    const n = this.handle.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM nodes").get();
    const e = this.handle.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM edges").get();
    const c = this.handle.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM claims").get();
    return { nodes: n?.c ?? 0, edges: e?.c ?? 0, claims: c?.c ?? 0 };
  }

  /* ---------- trace observations ---------- */

  /**
   * Insert a batch of trace observations in a single transaction.
   *
   * Returns the number of rows actually written. Duplicate
   * (src, dst, ts, source) tuples overwrite (a re-flush of the same window
   * is treated as the authoritative latest value), which keeps the table
   * compact when the tracer retries after a transient failure.
   */
  insertObservations(rows: Iterable<ObservationRow>): number {
    let count = 0;
    this.transaction(() => {
      const stmt = INSERT_OBSERVATION_STMT(this.handle);
      for (const o of rows) {
        stmt.run(o.src, o.dst, o.ts, o.observed, o.weight, o.source);
        count++;
      }
    });
    return count;
  }

  observationsCount(): number {
    return (
      this.handle
        .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM observations")
        .get()?.c ?? 0
    );
  }

  /**
   * Insert a batch of per-test coverage rows (schema v6) in one transaction.
   * Each row records that a SPECIFIC test (`test`, a raw runtime name) executed
   * an `entity` (also raw). Duplicate (test, entity, source) tuples SUM their
   * weight — re-running a test accumulates occurrences rather than overwriting,
   * so the table reflects total observed executions. Raw names are resolved to
   * node ids at READ time (see db/test_coverage.ts), mirroring `observations`.
   * Returns the number of rows written.
   */
  insertTestCoverage(rows: Iterable<TestCoverageRow>): number {
    let count = 0;
    this.transaction(() => {
      const stmt = INSERT_TEST_COVERAGE_STMT(this.handle);
      for (const r of rows) {
        stmt.run(r.test, r.entity, r.weight, r.source);
        count++;
      }
    });
    return count;
  }

  /** Every per-test coverage row, RAW (unresolved). The caller resolves the
   *  runtime `test`/`entity` names to node ids (db/test_coverage.ts). */
  allTestCoverage(): TestCoverageRow[] {
    return this.handle
      .query<TestCoverageRow, []>(
        "SELECT test, entity, weight, source FROM test_coverage",
      )
      .all();
  }

  /** Count of per-test coverage rows — the cold/warm signal for the precise
   *  affected-tests path (0 → no traced runs yet, fall back to the global walk). */
  testCoverageCount(): number {
    return (
      this.handle
        .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM test_coverage")
        .get()?.c ?? 0
    );
  }

  /** Max `ts` in observations, or null if empty. */
  lastObservationTs(): number | null {
    return (
      this.handle
        .query<{ ts: number | null }, []>("SELECT MAX(ts) AS ts FROM observations")
        .get()?.ts ?? null
    );
  }

  /**
   * Trace edges with their runtime endpoints resolved to graph-entity ids.
   *
   * The `observations` cache stores `src`/`dst` as VERBATIM runtime names (the
   * collector's ground truth — never mutated). This is the DERIVED join that
   * closes PRD §7's "trace-augmented edges" gap: it groups observations by their
   * raw `(src, dst)` pair (summing `observed`/`weight` and counting rows), builds
   * a {@link TraceNameResolver} over the current node index, and resolves each
   * raw endpoint CONSERVATIVELY (unambiguous-only; see traceResolve.ts).
   *
   * Resolution is computed at READ time against the live node index — no schema
   * migration, and a reindex/rename is reflected on the next call automatically
   * (no stale stored column to recompute). Unresolved endpoints keep `null`
   * resolved ids and are flagged by that null, never dropped.
   *
   * Optional `endpoint` filters to edges touching a specific RUNTIME name on the
   * given side (used by the CLI to show a single node's resolved trace neighbors).
   */
  resolvedTraceEdges(filter?: {
    rawSrc?: string;
    rawDst?: string;
  }): ResolvedTraceEdge[] {
    let sql =
      "SELECT src AS rawSrc, dst AS rawDst, " +
      "SUM(observed) AS observed, SUM(weight) AS weight, COUNT(*) AS samples " +
      "FROM observations";
    const params: string[] = [];
    const where: string[] = [];
    if (filter?.rawSrc !== undefined) {
      where.push("src = ?");
      params.push(filter.rawSrc);
    }
    if (filter?.rawDst !== undefined) {
      where.push("dst = ?");
      params.push(filter.rawDst);
    }
    if (where.length > 0) sql += " WHERE " + where.join(" AND ");
    sql += " GROUP BY src, dst ORDER BY SUM(weight) DESC, src, dst";

    const rows = this.handle
      .query<
        { rawSrc: string; rawDst: string; observed: number; weight: number; samples: number },
        string[]
      >(sql)
      .all(...params);

    const resolver = buildTraceResolver(this);
    return rows.map((r) => ({
      rawSrc: r.rawSrc,
      rawDst: r.rawDst,
      resolvedSrc: resolver.resolve(r.rawSrc),
      resolvedDst: resolver.resolve(r.rawDst),
      observed: r.observed,
      weight: r.weight,
      samples: r.samples,
    }));
  }
}

/* ---------- claim row type + helpers ---------- */

export interface ClaimRow {
  id: string;
  agent: string | null;
  scope_json: string | null;
  fingerprint: string | null;
  intent: string | null;
  created: number | null;
  ttl: number | null;
}

export function listClaims(db: Database): ClaimRow[] {
  return db
    .query<ClaimRow, []>(
      "SELECT id, agent, scope_json, fingerprint, intent, created, ttl FROM claims ORDER BY created DESC",
    )
    .all();
}

/* ---------- observation row type ---------- */

export interface ObservationRow {
  src: string;
  dst: string;
  ts: number;
  observed: number;
  weight: number;
  source: string;
}

/* ---------- per-test coverage row type (schema v6) ---------- */

/** One (test, entity) coverage row: the trace collector observed `test` (a raw
 *  runtime name) execute `entity` (raw). Resolved to node ids at read time. */
export interface TestCoverageRow {
  test: string;
  entity: string;
  weight: number;
  source: string;
}

/* ---------- prepared statement caches ----------
 *
 * `bun:sqlite`'s `Statement<TRow, TParams>` is generic. We cache one statement
 * per (db, key) tuple and type the cache as an opaque map (since the cached
 * statements have different row/param types). The per-callsite helper casts
 * to the right shape.
 */

type AnyStatement = Statement<unknown, SQLQueryBindings[]>;
const stmtCache = new WeakMap<Database, Map<string, AnyStatement>>();

function prep<TRow, TParams extends SQLQueryBindings[]>(
  db: Database,
  key: string,
  sql: string,
): Statement<TRow, TParams> {
  let m = stmtCache.get(db);
  if (!m) {
    m = new Map();
    stmtCache.set(db, m);
  }
  let stmt = m.get(key);
  if (!stmt) {
    stmt = db.query(sql) as AnyStatement;
    m.set(key, stmt);
  }
  return stmt as unknown as Statement<TRow, TParams>;
}

type UpsertNodeParams = [
  string, // id
  string, // name
  string, // qualified_name
  string, // kind
  string | null, // language
  string | null, // file
  number, // range_start
  number, // range_end
  string | null, // ast_hash
  string | null, // summary
  number | null, // last_seen
  number, // logical_clock
  string | null, // last_modified_by
];

const UPSERT_NODE_STMT = (db: Database): Statement<unknown, UpsertNodeParams> =>
  prep<unknown, UpsertNodeParams>(
    db,
    "upsert_node",
    `INSERT INTO nodes (id, name, qualified_name, kind, language, file,
                        range_start, range_end, ast_hash, summary, last_seen,
                        logical_clock, last_modified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name             = excluded.name,
       qualified_name   = excluded.qualified_name,
       kind             = excluded.kind,
       language         = excluded.language,
       file             = excluded.file,
       range_start      = excluded.range_start,
       range_end        = excluded.range_end,
       ast_hash         = excluded.ast_hash,
       summary          = COALESCE(excluded.summary, nodes.summary),
       last_seen        = excluded.last_seen,
       logical_clock    = MAX(nodes.logical_clock, excluded.logical_clock),
       last_modified_by = excluded.last_modified_by`,
  );

const GET_NODE_STMT = (db: Database): Statement<NodeRow, [string]> =>
  prep<NodeRow, [string]>(db, "get_node", `SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`);
const ALL_NODE_IDS_STMT = (db: Database): Statement<{ id: string }, []> =>
  prep<{ id: string }, []>(db, "all_node_ids", "SELECT id FROM nodes");
const DELETE_NODE_STMT = (db: Database): Statement<unknown, [string]> =>
  prep<unknown, [string]>(db, "delete_node", "DELETE FROM nodes WHERE id = ?");

type UpsertEdgeParams = [string, string, string, number, number | null];

const UPSERT_EDGE_STMT = (db: Database): Statement<unknown, UpsertEdgeParams> =>
  prep<unknown, UpsertEdgeParams>(
    db,
    "upsert_edge",
    `INSERT INTO edges (src, dst, kind, weight, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(src, dst, kind) DO UPDATE SET
       weight    = edges.weight + excluded.weight,
       last_seen = excluded.last_seen`,
  );

const OUTGOING_STMT = (db: Database): Statement<EdgeRow, [string]> =>
  prep<EdgeRow, [string]>(db, "outgoing", `SELECT ${EDGE_COLUMNS} FROM edges WHERE src = ?`);
const INCOMING_STMT = (db: Database): Statement<EdgeRow, [string]> =>
  prep<EdgeRow, [string]>(db, "incoming", `SELECT ${EDGE_COLUMNS} FROM edges WHERE dst = ?`);

type InsertCallSiteParams = [
  string, // dst
  string, // src
  string, // kind
  string | null, // file
  number | null, // line
  number | null, // col
];

const INSERT_CALL_SITE_STMT = (db: Database): Statement<unknown, InsertCallSiteParams> =>
  prep<unknown, InsertCallSiteParams>(
    db,
    "insert_call_site",
    `INSERT INTO call_sites (dst, src, kind, file, line, col) VALUES (?, ?, ?, ?, ?, ?)`,
  );

const CALL_SITES_OF_STMT = (db: Database): Statement<CallSiteRow, [string]> =>
  prep<CallSiteRow, [string]>(
    db,
    "call_sites_of",
    `SELECT ${CALL_SITE_COLUMNS} FROM call_sites WHERE dst = ?
       ORDER BY file, line, col`,
  );

type InsertObservationParams = [
  string, // src
  string, // dst
  number, // ts
  number, // observed
  number, // weight
  string, // source
];

const INSERT_OBSERVATION_STMT = (db: Database): Statement<unknown, InsertObservationParams> =>
  prep<unknown, InsertObservationParams>(
    db,
    "insert_observation",
    `INSERT INTO observations (src, dst, ts, observed, weight, source)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(src, dst, ts, source) DO UPDATE SET
       observed = excluded.observed,
       weight   = excluded.weight`,
  );

type InsertTestCoverageParams = [
  string, // test
  string, // entity
  number, // weight
  string, // source
];

const INSERT_TEST_COVERAGE_STMT = (db: Database): Statement<unknown, InsertTestCoverageParams> =>
  prep<unknown, InsertTestCoverageParams>(
    db,
    "insert_test_coverage",
    `INSERT INTO test_coverage (test, entity, weight, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(test, entity, source) DO UPDATE SET
       weight = test_coverage.weight + excluded.weight`,
  );

type InsertMergeRejectionParams = [string, string, string, string, number];

const INSERT_MERGE_REJECTION_STMT = (
  db: Database,
): Statement<unknown, InsertMergeRejectionParams> =>
  prep<unknown, InsertMergeRejectionParams>(
    db,
    "insert_merge_rejection",
    `INSERT INTO merge_rejections (file, phase, language, reason, detected_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file, phase) DO UPDATE SET
       language    = excluded.language,
       reason      = excluded.reason,
       detected_at = excluded.detected_at`,
  );

const SET_STAT_STMT = (db: Database): Statement<unknown, [string, string]> =>
  prep<unknown, [string, string]>(
    db,
    "set_stat",
    "INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
const GET_STAT_STMT = (db: Database): Statement<{ value: string }, [string]> =>
  prep<{ value: string }, [string]>(db, "get_stat", "SELECT value FROM stats WHERE key = ?");

export function nodeRowToGraphNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    name: row.name,
    qualified_name: row.qualified_name,
    kind: row.kind as NodeKind,
    language: row.language ?? "unknown",
    file: row.file ?? "",
    range: [row.range_start, row.range_end],
    ast_hash: row.ast_hash ?? "",
    summary: row.summary ?? undefined,
    last_seen: row.last_seen ?? 0,
    logical_clock: row.logical_clock ?? 0,
    ...(row.last_modified_by ? { last_modified_by: row.last_modified_by } : {}),
  };
}

export function edgeRowToGraphEdge(row: EdgeRow): GraphEdge {
  return {
    src: row.src,
    dst: row.dst,
    kind: row.kind as GraphEdge["kind"],
    weight: row.weight,
    last_seen: row.last_seen ?? 0,
  };
}
