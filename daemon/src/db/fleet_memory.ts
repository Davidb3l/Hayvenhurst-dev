/**
 * FLEET MEMORY — a persistent, cross-agent/cross-session knowledge store keyed
 * to the code graph (Phase 0.0.4, schema v6 `fleet_memory` table).
 *
 * When one agent discovers something — a decision it made, a dead-end it hit, a
 * gotcha it tripped on, or a freeform note — it records that learning against a
 * graph node id and/or a broader scope. A LATER agent (or a future session)
 * then INHERITS the knowledge instead of re-deriving it from scratch.
 *
 * This is deliberately distinct from `claims` (db/queries.ts → ClaimRow):
 *   - `claims` coordinate concurrent EDITS — short-lived, blocking, the thing
 *     that stops two agents clobbering the same code right now.
 *   - fleet memory is shared KNOWLEDGE — read-mostly, NEVER blocks work, and
 *     optionally TTL'd so ephemeral notes self-expire.
 *
 * STYLE / WIRING. These are PURE free functions over the raw `db.handle`
 * (`bun:sqlite`), mirroring how `listClaims` / the rest of queries.ts wrap the
 * handle — we deliberately do NOT add methods to the `Db` class (that surface is
 * owned centrally; keeping all of this in one module makes the feature a single,
 * reviewable unit). The CLI/route wiring is done by the integrator elsewhere;
 * this file is the storage + query engine only.
 *
 * DETERMINISM. Every read takes an injected `now` and every write takes an
 * injected `now` (+ optionally an injected `id`), so the whole module is pure
 * and deterministically testable — no hidden `Date.now()`, and NEVER
 * `Math.random` for ids (the repo forbids it; see CLAUDE.md / style discipline).
 */
import { buildFtsMatch, buildRelaxedFtsMatch } from "./fts.ts";
import type { Db } from "./queries.ts";

/** The four flavours of learning a note can carry. `decision` = a choice made;
 *  `deadend` = a path that didn't work (don't re-walk it); `gotcha` = a
 *  non-obvious trap; `note` = freeform. Stored verbatim in `fleet_memory.kind`. */
export type MemoryKind = "decision" | "deadend" | "gotcha" | "note";

/** A single stored learning, as read back out of the table (the `scope_json`
 *  blob is parsed back into the `scope` array; nullable columns surface as
 *  `null`). */
export interface MemoryNote {
  id: string;
  agent: string | null;
  /** The graph entity this note is about, or null for a repo-wide note. */
  nodeId: string | null;
  kind: MemoryKind;
  note: string;
  /** Optional list of related node ids (broader scope than a single nodeId). */
  scope: string[];
  /** Wall-clock ms when written. */
  created: number;
  /** Seconds-to-live, or null for permanent. */
  ttl: number | null;
}

/** Input to {@link recordMemory}. `now` (and optionally `id`) are INJECTED to
 *  keep the write pure + deterministic. */
export interface RecordMemoryInput {
  agent?: string;
  nodeId?: string | null;
  kind: MemoryKind;
  note: string;
  scope?: string[];
  ttl?: number | null;
  /** Injected wall-clock ms (caller passes Date.now()); keeps this PURE +
   *  deterministically testable. */
  now: number;
  /** Injected id (caller passes a deterministic id); if omitted, derive a
   *  DETERMINISTIC id from a hash of (agent,nodeId,kind,note,now) — NEVER
   *  Math.random (the repo forbids it; see CLAUDE.md). */
  id?: string;
}

/**
 * The raw shape of a `fleet_memory` row as it comes off `db.handle`. We read an
 * EXPLICIT column projection (never `SELECT *`) for the same reason the rest of
 * queries.ts does: a cached `SELECT *` statement snapshots its column set at
 * prepare time and would silently drift after an `ALTER TABLE`.
 */
interface FleetMemoryRow {
  id: string;
  agent: string | null;
  node_id: string | null;
  kind: string;
  note: string;
  scope_json: string | null;
  created: number;
  ttl: number | null;
}

/** Explicit column projection for {@link FleetMemoryRow}, in schema order. Keep
 *  in lockstep with the `fleet_memory` table (schema.ts). */
const MEMORY_COLUMNS = "id, agent, node_id, kind, note, scope_json, created, ttl";

/**
 * 32-bit FNV-1a over a UTF-8 string, rendered as 8 hex chars.
 *
 * Used to derive a DETERMINISTIC id when the caller doesn't supply one. We roll
 * our own tiny FNV rather than reach for `Math.random` (forbidden) or a hashing
 * dependency (the repo says no to deps it can hand-roll) — FNV-1a is a few lines,
 * has good avalanche for short distinct inputs, and is stable across runs so the
 * SAME fields at the SAME `now` always produce the SAME id (the property the
 * tests pin). We widen the space by hashing the input twice with two offset
 * bases and concatenating, giving a 16-hex-char id with a negligible collision
 * rate for this low-volume, human-authored table.
 */
function fnv1aHex(input: string): string {
  // First lane: canonical FNV-1a (offset basis 0x811c9dc5).
  let h1 = 0x811c9dc5;
  // Second lane: a different seed so the two halves are independent.
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    // `Math.imul` keeps the multiply in 32-bit space (JS numbers are doubles;
    // a plain `*` would lose the low bits past 2^53).
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  // `>>> 0` coerces to an unsigned 32-bit int before hex-ing; pad to 8 chars.
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  return a + b;
}

/**
 * Derive a deterministic id from the note's identifying fields PLUS `now`.
 *
 * Including `now` means two otherwise-identical notes written at different times
 * get distinct ids (so a later re-recording doesn't silently overwrite the
 * earlier one), while two identical notes at the SAME `now` collapse to the same
 * id (idempotent re-record). The field separator (`\x00`, a NUL that can't
 * appear in these strings) prevents boundary ambiguity between fields.
 */
function deriveId(input: RecordMemoryInput): string {
  const parts = [
    input.agent ?? "",
    input.nodeId ?? "",
    input.kind,
    input.note,
    String(input.now),
  ];
  return "mem_" + fnv1aHex(parts.join("\x00"));
}

/**
 * Serialize a `scope` array for the `scope_json` column.
 *
 * We store `null` for an absent/empty scope (rather than the string "[]") so the
 * common "no scope" case stays NULL in the table and the `scope_json LIKE`
 * prefilter in {@link memoryForNode} never has to consider it. On READ we
 * tolerate BOTH null AND "[]" (see {@link parseScope}) so either convention is
 * safe.
 */
function serializeScope(scope: string[] | undefined): string | null {
  if (!scope || scope.length === 0) return null;
  return JSON.stringify(scope);
}

/**
 * Parse a `scope_json` blob back into a string array, tolerating null, "[]", and
 * malformed JSON (defensive: a corrupt row degrades to an empty scope rather
 * than throwing and poisoning a whole list read).
 */
function parseScope(scopeJson: string | null): string[] {
  if (!scopeJson) return [];
  try {
    const parsed = JSON.parse(scopeJson);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
    return [];
  } catch {
    return [];
  }
}

/** Map a raw row to the public {@link MemoryNote} shape (parsing scope, casting
 *  the open `kind` text column to the {@link MemoryKind} union). */
function rowToNote(row: FleetMemoryRow): MemoryNote {
  return {
    id: row.id,
    agent: row.agent,
    nodeId: row.node_id,
    kind: row.kind as MemoryKind,
    note: row.note,
    scope: parseScope(row.scope_json),
    created: row.created,
    ttl: row.ttl,
  };
}

/**
 * The SQL predicate for "this note is still LIVE at `now`".
 *
 * A note is live when its `ttl` is NULL (permanent) OR it hasn't expired yet
 * (`created + ttl*1000 >= now`). `ttl` is in SECONDS and `created`/`now` are in
 * ms, hence the `*1000`. This exact predicate is applied in EVERY read and in
 * {@link pruneExpired} (whose DELETE uses the negation) so liveness is defined in
 * one place. `?` binds `now`.
 */
const LIVE_PREDICATE = "(ttl IS NULL OR created + ttl * 1000 >= ?)";

/** Deterministic newest-first ordering: `created` desc, then `id` asc as a
 *  stable tiebreaker (so two notes written at the same ms have a fixed order). */
const ORDER_NEWEST = "ORDER BY created DESC, id ASC";

/**
 * `fleet_memory`-alias-qualified copies of {@link LIVE_PREDICATE} /
 * {@link ORDER_NEWEST} for the FTS JOIN, where the base table is aliased `m` next
 * to the FTS `f` alias. SAME liveness + newest-first semantics; only alias-
 * prefixed so the columns are unambiguous in the joined query. Kept beside the
 * originals so the two stay in lockstep. `?` binds `now`, exactly as above.
 */
const LIVE_PREDICATE_M = "(m.ttl IS NULL OR m.created + m.ttl * 1000 >= ?)";
const ORDER_NEWEST_M = "ORDER BY m.created DESC, m.id ASC";

/**
 * Insert a note and return the stored {@link MemoryNote} (with its id).
 *
 * The id is the caller-supplied `input.id` if present, else a deterministic hash
 * of (agent, nodeId, kind, note, now) — see {@link deriveId}. We INSERT OR
 * REPLACE so a deterministic re-record of the identical note (same fields + same
 * `now` → same id) is idempotent rather than a PRIMARY KEY violation.
 */
export function recordMemory(db: Db, input: RecordMemoryInput): MemoryNote {
  const id = input.id ?? deriveId(input);
  const agent = input.agent ?? null;
  const nodeId = input.nodeId ?? null;
  const scope = input.scope ?? [];
  const scopeJson = serializeScope(scope);
  const ttl = input.ttl ?? null;

  db.handle
    .query(
      `INSERT OR REPLACE INTO fleet_memory
         (id, agent, node_id, kind, note, scope_json, created, ttl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, agent, nodeId, input.kind, input.note, scopeJson, input.now, ttl);

  return {
    id,
    agent,
    nodeId,
    kind: input.kind,
    note: input.note,
    scope,
    created: input.now,
    ttl,
  };
}

/**
 * All LIVE notes about `nodeId`, newest first — the rows whose own `node_id`
 * equals it UNION the rows whose `scope_json` array CONTAINS it.
 *
 * The scope-array match is awkward in pure SQL (the array is stored as a JSON
 * blob). We do it in two steps to stay correct AND cheap:
 *   1. A cheap SQL PREFILTER: `node_id = ?` OR `scope_json LIKE %"<id>"%`. The
 *      quotes around the id mean the LIKE only matches the id as a complete
 *      JSON-array element — but LIKE alone is NOT trusted (it can still
 *      false-match across element boundaries or on a partial), so…
 *   2. An EXACT match in JS: parse each candidate's scope array and keep the row
 *      only if `node_id === id` OR `scope.includes(id)`. This is what prevents a
 *      substring false-positive such as `foo` matching a note scoped to
 *      `foobar` — the parsed `.includes` is an exact element comparison.
 *
 * Expired notes are excluded by the shared {@link LIVE_PREDICATE}.
 */
export function memoryForNode(db: Db, nodeId: string, now: number): MemoryNote[] {
  // Escape LIKE metacharacters in the id so an id containing `%`/`_` can't widen
  // the prefilter; `\` is the ESCAPE char. The id is wrapped in `"` so the
  // pattern targets a complete JSON string element.
  const escaped = nodeId.replace(/[\\%_]/g, (m) => "\\" + m);
  const likePattern = `%"${escaped}"%`;

  const rows = db.handle
    .query<FleetMemoryRow, [string, string, number]>(
      `SELECT ${MEMORY_COLUMNS} FROM fleet_memory
        WHERE (node_id = ? OR scope_json LIKE ? ESCAPE '\\')
          AND ${LIVE_PREDICATE}
        ${ORDER_NEWEST}`,
    )
    .all(nodeId, likePattern, now);

  // Step 2: exact-match in JS to drop any false positive the LIKE prefilter let
  // through (substring collisions, partial-element matches).
  return rows
    .map(rowToNote)
    .filter((n) => n.nodeId === nodeId || n.scope.includes(nodeId));
}

/**
 * LIVE notes whose `note` text contains `term` (case-insensitive), newest first
 * — the ORIGINAL blind-substring recall, kept as an EXPORTED function so the
 * recall bench can A/B it against the FTS path ({@link searchMemory}) and so
 * {@link searchMemory} can fall back to it.
 *
 * SQLite's `LIKE` is case-insensitive for ASCII by default, which is the
 * behaviour we want; we still escape LIKE metacharacters in `term` so a literal
 * `%`/`_` in the search term matches itself rather than acting as a wildcard.
 * `limit` caps the result (default 100).
 *
 * RECALL LIMIT (why {@link searchMemory} now wraps FTS+expansion in front of
 * this): `LIKE` only matches a CONTIGUOUS run, so a note mentioning `authHandler`
 * is invisible to the query `"auth handler"` (the space breaks the run), and a
 * note saying `cfg` is invisible to `config` (no shared substring). The FTS path
 * fixes both via identifier tokenization + the abbrev table; this stays the
 * exact-substring baseline.
 */
export function searchMemorySubstring(
  db: Db,
  term: string,
  now: number,
  limit = 100,
): MemoryNote[] {
  const escaped = term.replace(/[\\%_]/g, (m) => "\\" + m);
  const likePattern = `%${escaped}%`;
  const cap = Math.max(0, Math.trunc(limit));

  return db.handle
    .query<FleetMemoryRow, [string, number, number]>(
      `SELECT ${MEMORY_COLUMNS} FROM fleet_memory
        WHERE note LIKE ? ESCAPE '\\'
          AND ${LIVE_PREDICATE}
        ${ORDER_NEWEST}
        LIMIT ?`,
    )
    .all(likePattern, now, cap)
    .map(rowToNote);
}

/**
 * Internal: run ONE FTS pass for a pre-built MATCH expression. Queries
 * `fleet_memory_fts MATCH ?`, JOINs back to `fleet_memory` by id, then applies
 * the SAME {@link LIVE_PREDICATE} + {@link ORDER_NEWEST} + `limit` as every other
 * read so liveness/ordering/determinism are identical to the substring path.
 *
 * The FTS table only indexes `note`; all the structured filtering/ordering
 * happens on the joined base columns, and we project the EXPLICIT
 * {@link MEMORY_COLUMNS} (qualified to `fleet_memory`) — never `SELECT *` — for
 * the same stale-statement reason as the rest of this module. Param order mirrors
 * the `?`s: MATCH expression, then `now` (LIVE_PREDICATE), then the cap.
 */
function searchMemoryFtsPass(
  db: Db,
  matchExpr: string,
  now: number,
  cap: number,
): MemoryNote[] {
  // The base-table columns/predicate/order are all qualified to the `m` alias
  // (the JOINed `fleet_memory`) so they're unambiguous next to the FTS `f` alias.
  // `LIVE_PREDICATE_M`/`ORDER_NEWEST_M` are the SAME liveness + newest-first
  // definitions as the unqualified ones, just alias-prefixed.
  const projection = MEMORY_COLUMNS.split(", ")
    .map((c) => `m.${c}`)
    .join(", ");
  return db.handle
    .query<FleetMemoryRow, [string, number, number]>(
      `SELECT ${projection}
         FROM fleet_memory_fts f
         JOIN fleet_memory m ON m.id = f.id
        WHERE fleet_memory_fts MATCH ?
          AND ${LIVE_PREDICATE_M}
        ${ORDER_NEWEST_M}
        LIMIT ?`,
    )
    .all(matchExpr, now, cap)
    .map(rowToNote);
}

/**
 * LIVE notes whose `note` text RECALLS `term`, newest first — the upgraded
 * recall path. Two-phase + expansion, mirroring `searchFts` in `fts.ts`:
 *
 *   1. PRECISE — `buildFtsMatch(term)` builds the AND-of-OR-groups MATCH with the
 *      model-free expansion floor (identifier tokenization + abbrev table) baked
 *      in, queried against `fleet_memory_fts` and JOINed back to `fleet_memory`.
 *      So `"auth handler"` recalls a note about `authHandler`/`auth_handler`, and
 *      `config` recalls `cfg` — neither reachable by a contiguous substring.
 *   2. RELAXED fallback — fires ONLY when the precise pass returns ZERO rows:
 *      `buildRelaxedFtsMatch(term)` drops English stopwords and OR-s the
 *      remaining content groups, so a natural-language ask still surfaces the
 *      notes that hit its content words instead of nothing.
 *
 * SUBSTRING fallback (preserves the old guarantees): if the MATCH string is
 * EMPTY (punctuation-/stopword-only input that never reaches an FTS MATCH) OR the
 * FTS query THROWS (e.g. the `fleet_memory_fts` table is somehow absent), we fall
 * back to {@link searchMemorySubstring} so this function is never WORSE than the
 * blind substring path — only ever better.
 *
 * Determinism, the {@link LIVE_PREDICATE}, the explicit column projection, and
 * FTS-input escaping (via `buildFtsMatch`'s sanitizer) are all preserved. `limit`
 * caps the result (default 100).
 */
export function searchMemory(
  db: Db,
  term: string,
  now: number,
  limit = 100,
): MemoryNote[] {
  const cap = Math.max(0, Math.trunc(limit));

  const preciseExpr = buildFtsMatch(term);
  // Empty MATCH (punctuation-/whitespace-only) never reaches FTS — the substring
  // path is the only sensible answer (it self-escapes the literal term).
  if (preciseExpr.length === 0) return searchMemorySubstring(db, term, now, cap);

  try {
    const precise = searchMemoryFtsPass(db, preciseExpr, now, cap);
    if (precise.length > 0) return precise;

    // Precise AND-path found nothing — try the relaxed OR-over-content-words
    // match. Skip the redundant query when relaxing produced the SAME expression
    // (single content term, nothing to drop) — the result would be identical-empty.
    const relaxedExpr = buildRelaxedFtsMatch(term);
    if (relaxedExpr.length === 0 || relaxedExpr === preciseExpr) return precise;
    return searchMemoryFtsPass(db, relaxedExpr, now, cap);
  } catch {
    // FTS table missing / MATCH rejected — degrade to the substring baseline
    // rather than dropping results entirely.
    return searchMemorySubstring(db, term, now, cap);
  }
}

/**
 * All LIVE notes, newest first, optionally filtered by `kind`, capped by
 * `limit` (default 100). The general "what's in fleet memory?" read.
 */
export function listMemory(
  db: Db,
  now: number,
  opts?: { kind?: MemoryKind; limit?: number },
): MemoryNote[] {
  const cap = Math.max(0, Math.trunc(opts?.limit ?? 100));

  if (opts?.kind !== undefined) {
    return db.handle
      .query<FleetMemoryRow, [string, number, number]>(
        `SELECT ${MEMORY_COLUMNS} FROM fleet_memory
          WHERE kind = ? AND ${LIVE_PREDICATE}
          ${ORDER_NEWEST}
          LIMIT ?`,
      )
      .all(opts.kind, now, cap)
      .map(rowToNote);
  }

  return db.handle
    .query<FleetMemoryRow, [number, number]>(
      `SELECT ${MEMORY_COLUMNS} FROM fleet_memory
        WHERE ${LIVE_PREDICATE}
        ${ORDER_NEWEST}
        LIMIT ?`,
    )
    .all(now, cap)
    .map(rowToNote);
}

/**
 * Delete a note by id. Returns true iff a row was actually removed (false when
 * the id didn't exist).
 *
 * NB: we do NOT trust `run().changes` to count the deleted ROWS here. With the
 * v7 `fleet_memory_fts` sync trigger in place, a DELETE on `fleet_memory` fires
 * the FTS `AFTER DELETE` trigger, and `bun:sqlite` reports the TOTAL changes
 * (base row + the trigram FTS rows the trigger touches) — so `.changes` is
 * inflated. A `true`/`false` existence answer only needs "did the row exist", so
 * we check that directly with an existence probe, immune to trigger inflation.
 */
export function forgetMemory(db: Db, id: string): boolean {
  const existed =
    db.handle
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM fleet_memory WHERE id = ?")
      .get(id)?.n ?? 0;
  db.handle.query("DELETE FROM fleet_memory WHERE id = ?").run(id);
  return existed > 0;
}

/**
 * Hard-delete every EXPIRED note (`created + ttl*1000 < now`, i.e. the negation
 * of {@link LIVE_PREDICATE}) and return the count removed. A maintenance call the
 * daemon can run periodically so the table doesn't accumulate dead rows.
 *
 * Permanent notes (`ttl IS NULL`) are NEVER pruned — only rows with a non-null
 * ttl that has elapsed qualify.
 */
export function pruneExpired(db: Db, now: number): number {
  // Count the expired ROWS first, then delete them. We can't read the count off
  // `run().changes`: the v7 `fleet_memory_fts` sync trigger fires on each base
  // delete and `bun:sqlite` reports the TOTAL changes (base rows + the trigram
  // FTS rows the trigger touches), which would over-report the count. The COUNT
  // and the DELETE share the EXACT same predicate (the negation of
  // {@link LIVE_PREDICATE}) so they agree on which rows qualify. Wrapped in a
  // transaction so the count and delete are atomic w.r.t. concurrent writes.
  const expiredPredicate = "ttl IS NOT NULL AND created + ttl * 1000 < ?";
  return db.transaction(() => {
    const count =
      db.handle
        .query<{ n: number }, [number]>(
          `SELECT COUNT(*) AS n FROM fleet_memory WHERE ${expiredPredicate}`,
        )
        .get(now)?.n ?? 0;
    db.handle.query(`DELETE FROM fleet_memory WHERE ${expiredPredicate}`).run(now);
    return count;
  });
}
