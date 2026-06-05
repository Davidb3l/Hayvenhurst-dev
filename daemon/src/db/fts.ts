/**
 * FTS5 search helpers.
 *
 * The trigram tokenizer makes this fuzzy by construction — short substrings
 * match even with typos. We rank with BM25 and limit by score.
 */
import type { Database } from "bun:sqlite";

import {
  dropStopwords,
  expandQuery,
  expandQueryWithModel,
  type InferLike,
} from "./queryExpansion.ts";
import { makeInferFn } from "../conflict/llm_oracle.ts";
import { isModelPresent, modelDir } from "../models/registry.ts";
import { tryLocateNativeBinary } from "../native/locate.ts";

/**
 * Upper bound on the number of original (whitespace-split) query terms we feed
 * into the expanded MATCH. Real searches are a few words; this only guards
 * against pathological giant inputs that would otherwise produce an FTS5
 * expression too deep for it to parse.
 */
const MAX_QUERY_TERMS = 32;

/**
 * Centrality-aware re-rank weights (see `searchFts`).
 *
 * Pure BM25 ranks by token frequency, which on BROAD one-word queries buries a
 * well-connected *implementation* under tests/types/interfaces that happen to
 * share the token (the dogfound "walkNeighbors at #7 / selectOracle at #20"
 * symptom). We fold two cheap, deterministic, index-only graph/locality signals
 * into the final ordering:
 *
 *   finalScore = bm25  −  α · log1p(degree)  +  τ · isScaffold
 *
 * where (FTS5 BM25 is NEGATIVE, lower = better, so a more-negative score ranks
 * higher):
 *   - `degree` = caller + callee count for the node (its edge count in either
 *     direction). `−α·log1p(degree)` gently lifts well-connected nodes; `log1p`
 *     keeps a 100-edge hub from swamping the BM25 signal, and a leaf (degree 0)
 *     gets exactly zero boost so exact-identifier hits are undisturbed.
 *   - `isScaffold` = 1 for nodes whose source file is a test or bench file
 *     (`*.test.*`, `…/tests/…`, `bench/…`). `+τ·isScaffold` demotes that
 *     scaffolding so the product implementation surfaces above its tests.
 *
 * α/τ were tuned on `bench/agent-nav-eval.ts` (this repo's index): they lift
 * BROAD MRR 0.649 → 0.708 and BROAD top-5 5/6 → 6/6 while leaving the IMPL
 * exact-identifier cohort *unchanged* (MRR 0.946, top-5 14/14). The boost is
 * deliberately gentle: it only ever re-orders rows BM25 already deemed close,
 * never promotes an irrelevant high-degree node over a strong exact match.
 *
 * v4 re-tune (path-searchable FTS, 2026-06-01): adding the `path` column widens
 * the BROAD candidate pool with path-only matches on LOW-degree leaf nodes
 * (mocks, query-key helpers) that, even at a near-zero path weight, slipped the
 * highest-degree implementation out of the top-5 (`neighbors`→`walkNeighbors`,
 * degree 14, fell from #5 to #6). A path-WEIGHT change alone could not fix this
 * (it's a BM25 document-length-normalization shift, not a path-score effect), so
 * α was nudged 0.25 → 0.30 — the lightest lever that lets the degree signal
 * re-seat the real implementation above the leaf path-hits. Measured on this
 * repo's v4 index: BROAD top-5 back to 6/6, IMPL *improved* (MRR 0.946 → 0.964,
 * top-5 still 14/14), UI/granularity/semantic unchanged.
 */
const DEGREE_BOOST_ALPHA = 0.30;
const SCAFFOLD_PENALTY_TAU = 1.0;

/**
 * Per-column BM25 weight for the v4 `path` column (see `bm25Expr`).
 *
 * The v4 `path` column makes folder/file segments matchable (the dogfound
 * "schema" → `db/schema/*` miss). But on BROAD one-word queries a popular path
 * segment matches dozens of files, and at the DEFAULT weight (1.0) those path
 * hits diluted the ranking enough to push existing BROAD targets down
 * (`search`→#6, `neighbors`→#7 on this repo's index). We down-weight `path` so
 * it ADDS recall (a name/qualified_name match still outranks a path-only match):
 *   - measured on `bench/agent-nav-eval.ts` (this repo): at w=0.35 the `search`
 *     target recovers to #2 and PATH stays 4/4. The residual `neighbors`
 *     one-position slip is NOT a path-weight problem (it persists at w=0); it's
 *     fixed by the v4 α nudge in `DEGREE_BOOST_ALPHA` above. Together they
 *     restore BROAD top-5 to 6/6 with IMPL/UI/granularity/semantic unchanged.
 * Name/qualified_name/summary keep weight 1.0; `id` is UNINDEXED so its weight
 * is inert but must still be supplied positionally.
 */
const PATH_COLUMN_WEIGHT = 0.35;

/**
 * How many BM25-ranked candidates to pull before the centrality re-rank, as a
 * multiple of the caller's `limit` (floored at `RERANK_MIN_POOL`). The re-rank
 * only shuffles WITHIN this pool, so the pool must be wide enough that a row the
 * boost would promote into the top-`limit` isn't cut off first. A small fixed
 * multiple is plenty (the boost moves rows a few positions, not dozens) and
 * keeps the extra per-row degree subqueries cheap.
 */
const RERANK_POOL_FACTOR = 4;
const RERANK_MIN_POOL = 50;

export interface SearchHit {
  id: string;
  name: string;
  qualified_name: string;
  summary: string;
  /** BM25 rank (lower = better). */
  rank: number;
}

/**
 * Options for `searchFts`. Today the only knob is `path`: an optional
 * repo-relative path PREFIX that scopes results to nodes whose `file` column
 * begins with it (case-sensitive — paths are). When omitted/empty, results are
 * BYTE-IDENTICAL to the unscoped search (a strict requirement — see tests).
 */
export interface SearchOptions {
  /** Repo-relative path prefix; keep only nodes under it. Trailing `/` is
   *  normalized away so `frontend` and `frontend/` behave identically. */
  path?: string;
}

/**
 * Compiled path-prefix filter: the normalized literal prefix plus its CHARACTER
 * length. `null` means "no filter" — the caller then emits the exact
 * pre-existing SQL (byte-identical).
 *
 * We deliberately do NOT use `LIKE`: SQLite's `LIKE` is case-INSENSITIVE for
 * ASCII by default, but file paths are case-SENSITIVE (the spec requires it).
 * Instead we compare a `substr(file, 1, len)` head against the literal prefix
 * under the default BINARY collation — exact, case-sensitive, and immune to
 * `%`/`_`/`\` wildcard injection because no wildcard syntax is involved at all.
 */
interface PathFilter {
  /** Normalized literal prefix, e.g. `frontend/src`. */
  prefix: string;
  /** `prefix.length` (precomputed for the `substr(...,1,?)` bound). */
  len: number;
}

/**
 * Normalize a raw `--path`/`?path=` value into a compiled prefix filter, or
 * `null` when there's effectively no filter.
 *
 *   1. Trim, then strip a single trailing `/` so `frontend` ≡ `frontend/`
 *      (both keep files UNDER `frontend/`, plus a file literally named the
 *      prefix — a true prefix match, as specified).
 *   2. Empty after trimming → `null` (no filter; preserves the byte-identical
 *      unscoped path).
 */
function compilePathFilter(path: string | undefined): PathFilter | null {
  if (path == null) return null;
  let prefix = path.trim();
  if (prefix.endsWith("/")) prefix = prefix.slice(0, -1);
  if (prefix.length === 0) return null;
  return { prefix, len: prefix.length };
}

/**
 * The SQL fragment (a correlated EXISTS over `nodes`) that constrains an FTS
 * row to nodes whose `file` begins with the prefix, plus the bound params (the
 * prefix length and the prefix literal — IN THAT ORDER, matching the two `?`).
 * When `filter` is `null` it returns the EMPTY string and NO params, so the
 * surrounding query is textually unchanged from the pre-filter version.
 *
 * `alias` is the FTS row alias to correlate against (`f` in `rankedSearch`,
 * `nodes_fts` in the flat `bm25Search`).
 */
function pathPredicate(
  filter: PathFilter | null,
  alias: string,
): { sql: string; params: (string | number)[] } {
  if (filter === null) return { sql: "", params: [] };
  return {
    sql:
      ` AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = ${alias}.id` +
      ` AND substr(n.file, 1, ?) = ?)`,
    params: [filter.len, filter.prefix],
  };
}

/**
 * Escape user input for an FTS5 `MATCH` query.
 *
 * We deliberately do NOT pass arbitrary user text directly into FTS5: it has
 * its own query syntax (NEAR, AND, OR, quoting, prefix `*`...) that can blow
 * up on innocent input. Strategy:
 *   - Split on whitespace.
 *   - Strip non-word characters from each term.
 *   - Drop empty terms.
 *   - Quote each term with double-quotes (FTS5 phrase quoting).
 *   - Join with spaces (implicit AND).
 */
export function escapeFtsQuery(raw: string): string {
  const terms = sanitizeTerms(raw);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t}"`).join(" ");
}

/**
 * Sanitize raw user input into the list of safe, FTS-metachar-free terms.
 * Shared by `escapeFtsQuery` (no expansion) and `buildFtsMatch` (expansion).
 */
function sanitizeTerms(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]+/gu, ""))
    .filter((t) => t.length > 0);
}

/**
 * Build the FTS5 `MATCH` string for a user query, with the MODEL-FREE
 * expansion floor applied (see `queryExpansion.ts`).
 *
 * Each sanitized term becomes a parenthesized OR-group of `"original" OR
 * "subtoken" OR "abbrevPartner" …`; groups are space-joined (implicit AND
 * across the user's original terms). This is strictly ADDITIVE over
 * `escapeFtsQuery`:
 *   - a single-term group with no expansions collapses to exactly the same
 *     `"term"` as before (no parens, no behavior change);
 *   - the original term is always the first OR member, so it still matches;
 *   - OR-ing only ADDS candidate rows — it never AND-constrains the original
 *     match away. BM25 then keeps fuller/rarer (original) matches ranked above
 *     rows that only matched a short common subtoken, so exact hits stay on
 *     top without any explicit weighting.
 *
 * Returns "" for empty/whitespace/punctuation-only input (never reaches MATCH).
 */
export function buildFtsMatch(raw: string): string {
  // De-duplicate identical original terms (case-insensitively): repeating a
  // word can't AND-narrow anything and only deepens the expression tree. Then
  // cap the number of distinct ORIGINAL terms. A normal search is a handful of
  // words; this only bites pathological input (e.g. a giant pasted blob), where
  // an unbounded AND-of-OR-groups expression overflows FTS5's expression-tree
  // depth limit and gets silently rejected (→ []). Neither step changes
  // behavior for real queries.
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of sanitizeTerms(raw)) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  const groups = expandQuery(terms);
  return assembleMatch(groups);
}

/**
 * Build the RELAXED FTS5 `MATCH` for a natural-language query — the model-free
 * fallback that fires ONLY when the precise `buildFtsMatch` AND-path returns
 * ZERO rows (see `searchFts`).
 *
 * WHY THIS EXISTS: the precise path AND-s every one of the user's words. A
 * natural-language ask ("how does the daemon converge peers after a partition")
 * AND-s English glue words ("how"/"does"/"the"/"after"/"a") that never appear
 * in code, so the AND-of-all matches nothing and the agent gets "No matches" —
 * the exact trigger for falling back to grep forever. This builder fixes that
 * deterministically (NO model):
 *   1. Drop STOPWORDS (but keep them if the query is ALL stopwords, so a literal
 *      stopword search still works — see `dropStopwords`).
 *   2. Expand each remaining CONTENT term via the SAME model-free floor as the
 *      precise path (`expandQuery`).
 *   3. OR the content groups together at the top level instead of AND-ing them:
 *      `(grp1) OR (grp2) OR …`. A row that hits MORE of the content words gets a
 *      better BM25 score for free, so the most-relevant rows still rank first;
 *      the centrality re-rank in `rankedSearch` then applies identically.
 *
 * Strictly additive: this is only ever consulted as a fallback, so any query
 * that already matched under the precise AND-path is byte-identical to before.
 *
 * Returns "" for empty/whitespace/punctuation-only input (never reaches MATCH).
 */
export function buildRelaxedFtsMatch(raw: string): string {
  const content = dropStopwords(originalTerms(raw));
  const groups = expandQuery(content);
  return assembleMatchOr(groups);
}

/**
 * Sanitize + de-dup + cap a raw query into the original-term list, exactly as
 * `buildFtsMatch` does. Shared with the semantic path so both feed identical
 * terms into expansion.
 */
function originalTerms(raw: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of sanitizeTerms(raw)) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms;
}

/**
 * Assemble expansion groups into an FTS5 MATCH string: OR within a group, AND
 * across groups. Empty groups list → "" (never reaches MATCH).
 */
function assembleMatch(groups: string[][]): string {
  const nonEmpty = groups.filter((g) => g.length > 0);
  if (nonEmpty.length === 0) return "";
  return nonEmpty
    .map((group) => {
      const quoted = group.map((t) => `"${t}"`);
      // A lone term (no expansions) stays bare → identical to escapeFtsQuery.
      return quoted.length === 1 ? quoted[0] : `(${quoted.join(" OR ")})`;
    })
    // EXPLICIT `AND` between fragments. FTS5's implicit-AND only works between
    // bare terms — `("a" OR "b") ("c" OR "d")` is a *syntax error*. The single-
    // fragment case collapses to exactly one bare term, matching escapeFtsQuery.
    .join(" AND ");
}

/**
 * Assemble expansion groups into an FTS5 MATCH string with OR *across* groups
 * (still OR *within* each group). Used ONLY by the relaxed NL fallback
 * (`buildRelaxedFtsMatch`): a row matching ANY content word is a candidate, and
 * BM25 ranks rows that hit more words higher. Empty groups list → "".
 *
 * Each group is wrapped in parens so the top-level ORs compose unambiguously
 * (`("a" OR "b") OR ("c" OR "d")`). A single group still emits valid syntax.
 */
function assembleMatchOr(groups: string[][]): string {
  const nonEmpty = groups.filter((g) => g.length > 0);
  if (nonEmpty.length === 0) return "";
  return nonEmpty
    .map((group) => {
      const quoted = group.map((t) => `"${t}"`);
      return quoted.length === 1 ? quoted[0] : `(${quoted.join(" OR ")})`;
    })
    .join(" OR ");
}

/**
 * Run the centrality-aware ranked search for an already-built FTS5 MATCH
 * expression. Shared by `searchFts` (model-free) and `searchFtsSemantic`
 * (model-gated) — both produce a MATCH string and rank it identically.
 *
 * Over-fetches a BM25-ordered candidate pool, then re-ranks it with the
 * degree/scaffold signals (see DEGREE_BOOST_ALPHA / SCAFFOLD_PENALTY_TAU). The
 * pool is intentionally wider than `limit` so a row the boost promotes into the
 * visible window isn't cut off by the raw-BM25 cut first.
 */
function rankedSearch(
  db: Database,
  matchExpr: string,
  limit: number,
  filter: PathFilter | null = null,
): SearchHit[] {
  if (matchExpr.length === 0) return [];
  // The centrality re-rank needs the `edges` + `nodes` tables for its degree /
  // scaffold signals. When they're absent (a fresh/partial index, or the tiny
  // FTS-only fixtures in tests), there is no graph to rank by — fall back to the
  // original pure-BM25 path so search still works, just without the boost.
  if (!hasRerankTables(db)) return bm25Search(db, matchExpr, limit, filter);

  const pool = Math.max(RERANK_MIN_POOL, limit * RERANK_POOL_FACTOR);
  const bm25 = bm25Expr(db);
  const path = pathPredicate(filter, "f");
  try {
    // `rank` stays the raw BM25 score (the SearchHit contract); `finalScore` is
    // the re-rank key and is NOT exposed. degree/scaffold are computed by
    // index-only correlated subqueries against the edge tables + nodes.file:
    //   - edges(src) is the PK, edges(dst) has `edges_dst` → both COUNT(*)s are
    //     covering-index scans, no table reads.
    //   - the file lookup hits the nodes PK.
    // All of it runs only for the `pool` rows FTS already matched, so it's a
    // handful of indexed point-lookups per query — deterministic and cheap, no
    // per-query graph walk. Ties (equal finalScore) fall back to BM25 then id
    // for a stable, deterministic order.
    // Param order MUST mirror the `?` order in the SQL: MATCH, then the optional
    // path-prefix LIKE param (empty when unfiltered → byte-identical SQL+params),
    // then the inner LIMIT (pool), then the outer LIMIT.
    const stmt = db.query<SearchHit, (string | number)[]>(
      `SELECT id, name, qualified_name, summary, rank
         FROM (
           SELECT f.id   AS id,
                  f.name  AS name,
                  f.qualified_name AS qualified_name,
                  f.summary AS summary,
                  ${bm25} AS rank,
                  ${bm25}
                    - ${DEGREE_BOOST_ALPHA} * ln(1 + (
                        (SELECT COUNT(*) FROM edges e WHERE e.src = f.id)
                      + (SELECT COUNT(*) FROM edges e WHERE e.dst = f.id)
                      ))
                    + ${SCAFFOLD_PENALTY_TAU} * (
                        SELECT CASE
                          WHEN n.file LIKE '%.test.%'
                            OR n.file LIKE '%/tests/%'
                            OR n.file LIKE 'bench/%'
                            OR n.file LIKE '%/bench/%'
                            -- Mock files are scaffold too: a test mock
                            -- (api/mocks.ts mockNeighbors) must not outrank the
                            -- real impl (walkNeighbors). Covers mocks.ts,
                            -- foo.mock.ts, mocks/ dirs, and jest __mocks__/.
                            OR n.file LIKE '%/mocks.%'
                            OR n.file LIKE 'mocks.%'
                            OR n.file LIKE '%.mock.%'
                            OR n.file LIKE '%/mocks/%'
                            OR n.file LIKE '%/__mocks__/%' THEN 1 ELSE 0
                        END
                        FROM nodes n WHERE n.id = f.id
                      ) AS finalScore
             FROM nodes_fts f
            WHERE nodes_fts MATCH ?${path.sql}
            ORDER BY rank
            LIMIT ?
         )
        ORDER BY finalScore, rank, id
        LIMIT ?`,
    );
    return stmt.all(matchExpr, ...path.params, pool, limit) as SearchHit[];
  } catch {
    // Re-rank query rejected (e.g. a missing math fn build, or a malformed
    // MATCH) — fall back to plain BM25 rather than dropping results entirely.
    return bm25Search(db, matchExpr, limit, filter);
  }
}

/** Pure-BM25 search (the pre-centrality behavior). Used as the no-graph and
 *  error fallback for `rankedSearch`. Returns [] only if the FTS table itself
 *  is missing / the MATCH is rejected. */
function bm25Search(
  db: Database,
  matchExpr: string,
  limit: number,
  filter: PathFilter | null = null,
): SearchHit[] {
  if (matchExpr.length === 0) return [];
  // The path predicate correlates against the `nodes` table. In the pure no-graph
  // fallback `nodes` may not exist; correlate only when it does, otherwise the
  // EXISTS would throw and drop ALL results. (No `nodes` table ⇒ nothing to scope
  // ⇒ unfiltered is the only sane answer.) When unfiltered, `path.sql` is "" so
  // the SQL + params are byte-identical to the pre-filter query.
  const path =
    filter !== null && hasNodesTable(db)
      ? pathPredicate(filter, "nodes_fts")
      : pathPredicate(null, "nodes_fts");
  try {
    const stmt = db.query<SearchHit, (string | number)[]>(
      `SELECT id, name, qualified_name, summary, ${bm25Expr(db)} AS rank
         FROM nodes_fts
        WHERE nodes_fts MATCH ?${path.sql}
        ORDER BY rank
        LIMIT ?`,
    );
    return stmt.all(matchExpr, ...path.params, limit);
  } catch {
    return [];
  }
}

/**
 * The BM25 ranking expression for `nodes_fts`, with per-column weights applied
 * ONLY when the v4 `path` column is present.
 *
 * FTS5 `bm25(tbl, w1, w2, …)` takes ONE weight per indexed column and ERRORS if
 * the count is wrong — so we cannot hard-code a 5-weight vector: a pre-v4 (or
 * an FTS-only test fixture) table has 4 columns. We probe the live column set
 * and: with `path` present → weight it down (`PATH_COLUMN_WEIGHT`) while every
 * other column stays 1.0; without it → plain `bm25(nodes_fts)` (the exact
 * pre-v4 expression, byte-identical ranking). The column ORDER mirrors the
 * `nodes_fts` CREATE: id, name, qualified_name, summary, path.
 */
function bm25Expr(db: Database): string {
  if (!ftsHasPathColumn(db)) return "bm25(nodes_fts)";
  // id (UNINDEXED, inert but positional), name, qualified_name, summary, path.
  return `bm25(nodes_fts, 1.0, 1.0, 1.0, 1.0, ${PATH_COLUMN_WEIGHT})`;
}

/** Does `nodes_fts` carry the v4 `path` column? Cheap PRAGMA against the live
 *  table; on any error (no FTS table) we report false so the caller uses the
 *  unweighted, pre-v4 `bm25(nodes_fts)`. */
function ftsHasPathColumn(db: Database): boolean {
  try {
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(nodes_fts)")
      .all();
    return cols.some((c) => c.name === "path");
  } catch {
    return false;
  }
}

/** Do the tables the centrality re-rank reads (`edges`, `nodes`) both exist?
 *  Cheap `sqlite_master` lookup; the result is stable for a DB handle but we
 *  keep it a plain query for simplicity (it's a single indexed catalog read). */
function hasRerankTables(db: Database): boolean {
  try {
    const row = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM sqlite_master " +
          "WHERE type = 'table' AND name IN ('edges', 'nodes')",
      )
      .get();
    return (row?.c ?? 0) >= 2;
  } catch {
    return false;
  }
}

/**
 * Search `nodes_fts` for the given user query. Returns at most `limit` hits.
 * Returns an empty array when the FTS table is missing or the escaped query
 * is empty. Synchronous, model-free, deterministic — the hot search path.
 *
 * Two-phase, strictly additive:
 *   1. PRECISE — the unchanged AND-of-OR-groups path (`buildFtsMatch`). Exact
 *      identifier queries match here and are byte-identical to before.
 *   2. RELAXED fallback — fires ONLY when the precise path returns ZERO rows.
 *      Drops English stopwords and OR-s the remaining content groups
 *      (`buildRelaxedFtsMatch`) so a natural-language query that AND-matched
 *      nothing ("how does the daemon converge peers after a partition") still
 *      surfaces the rows that hit its content words, instead of "No matches".
 *      Run through the SAME `rankedSearch`, so ranking/re-rank is identical.
 *
 * Because the fallback only runs on an otherwise-empty result, any query that
 * already matched is completely unaffected — this can only ADD results to
 * previously-empty queries.
 */
export function searchFts(
  db: Database,
  raw: string,
  limit = 20,
  opts: SearchOptions = {},
): SearchHit[] {
  // Compile the optional path-prefix filter once and thread it through ALL code
  // paths (precise, relaxed). `null` ⇒ no filter ⇒ every downstream query emits
  // its exact pre-filter SQL+params, so an unscoped search is byte-identical.
  const filter = compilePathFilter(opts.path);

  const precise = rankedSearch(db, buildFtsMatch(raw), limit, filter);
  if (precise.length > 0) return precise;

  // Precise AND-path found nothing. Try the relaxed OR-over-content-words match.
  // Guard against a degenerate no-op: if relaxing produced the SAME expression
  // (e.g. a single content term with no stopwords to drop), the result would be
  // identical-empty, so skip the redundant query.
  const relaxedExpr = buildRelaxedFtsMatch(raw);
  if (relaxedExpr.length === 0 || relaxedExpr === buildFtsMatch(raw)) return precise;
  return rankedSearch(db, relaxedExpr, limit, filter);
}

/**
 * Model-gated SEMANTIC search. Identical ranking to `searchFts`, but first asks
 * an injected local model (the `hayven-native infer` path, see
 * `queryExpansion.ts::expandQueryWithModel`) to translate a natural-language
 * query into candidate identifiers, then OR-s those into the MATCH at the top
 * level: `(model-free base) OR (semantic identifiers)`.
 *
 * Strictly additive over `searchFts`:
 *   - with no model / error / timeout / unparseable output, `semantic` is empty
 *     and the MATCH equals `buildFtsMatch(raw)` exactly → identical results to
 *     `searchFts`. This is the clean fallback; callers can wire it
 *     unconditionally and pay nothing when no model is present.
 *   - the semantic terms are OR-ed against the WHOLE base, so they only ADD
 *     candidate rows for an NL query that the base couldn't match — they never
 *     remove a row the base would have returned (`X OR Y ⊇ X`).
 *
 * OPT-IN / not on the hot path: model inference is ~3 s (Metal) – ~13 s (CPU)
 * cold on the reference hardware (CLAUDE.md "Honesty notes"), so this is for an
 * explicit "semantic search" affordance, not keystroke search. `searchFts`
 * stays synchronous and model-free by default. See the report for the
 * landed-vs-deferred status.
 */
export async function searchFtsSemantic(
  db: Database,
  raw: string,
  infer: InferLike | undefined,
  limit = 20,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  // Compile the optional path-prefix filter once and thread it into BOTH
  // rankedSearch calls below, exactly as `searchFts` does. `null` ⇒ no filter ⇒
  // byte-identical to the unscoped semantic search. Model expansion still
  // applies, but only WITHIN the scoped prefix — so a payload echoing `path` is
  // truthful (the prior bug returned whole-repo hits while echoing a path).
  const filter = compilePathFilter(opts.path);

  const { base, semantic } = await expandQueryWithModel(
    originalTerms(raw),
    raw,
    infer,
  );
  // Top-level OR: `(base) OR (semantic…)`. `assembleMatch` builds the base
  // AND-of-OR-groups; the semantic terms form one OR-group that we OR against
  // the whole thing. Either side may be empty (no model → base only; base-empty
  // pure-NL query → semantic only).
  const baseExpr = assembleMatch(base);
  const semExpr =
    semantic.length > 0
      ? `(${semantic.map((t) => `"${t}"`).join(" OR ")})`
      : "";
  let matchExpr: string;
  if (baseExpr && semExpr) matchExpr = `(${baseExpr}) OR ${semExpr}`;
  else matchExpr = baseExpr || semExpr;
  return rankedSearch(db, matchExpr, limit, filter);
}

/**
 * Resolve an {@link InferLike} for the SEMANTIC search path, or `undefined` when
 * no usable local model is available.
 *
 * This is the single seam that decides whether `--semantic` / `?semantic=true`
 * actually engages the model. It returns `undefined` — meaning "no model" — in
 * every case where we cannot run inference, so `searchFtsSemantic` then degrades
 * to its model-free base (byte-identical to `searchFts`). The semantic flag is
 * therefore SAFE to wire unconditionally: with no model pulled it never errors,
 * it just returns the model-free results.
 *
 * `undefined` is returned when:
 *   - the configured Tier-3 model id is unknown / not present on disk
 *     (`isModelPresent` — no `model.gguf` under `.hayven/models/<id>/`); or
 *   - the `hayven-native` binary can't be located (`tryLocateNativeBinary`).
 *
 * Otherwise it binds {@link makeInferFn} (the same candle `hayven-native infer`
 * transport the conflict oracle uses): temp 0.0, a small token cap, and a
 * generous timeout (semantic search is an explicit opt-in affordance, not the
 * keystroke hot path, so we tolerate the cold-load latency rather than racing a
 * 2 s claim-path deadline). Any infer error/timeout still degrades cleanly
 * inside `expandQueryWithModel` (it catches and returns the model-free base).
 */
export function resolveSemanticInfer(opts: {
  hayvenDir: string;
  modelId: string;
  repoRoot?: string | undefined;
}): InferLike | undefined {
  const { hayvenDir, modelId, repoRoot } = opts;
  if (!isModelPresent(hayvenDir, modelId)) return undefined;
  const resolvedModel = modelDir(hayvenDir, modelId);
  if (resolvedModel === null) return undefined;
  const binary = tryLocateNativeBinary(repoRoot ? { repoRoot } : {});
  if (binary === null) return undefined;
  // Generous timeout: semantic search is opt-in, so the cold model-load cost
  // (~3-13 s on the reference hardware) is acceptable here — unlike the claim
  // path's 2 s budget. The infer fn never throws; on timeout it resolves
  // `ok:false` and expansion falls back to the model-free base.
  return makeInferFn({ binary, modelDir: resolvedModel, timeoutMs: 60_000 });
}

/** Does the `nodes` table exist? Cheap catalog lookup; gates the path-prefix
 *  predicate in the no-graph `bm25Search` fallback (no `nodes` ⇒ can't scope). */
function hasNodesTable(db: Database): boolean {
  try {
    const row = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM sqlite_master " +
          "WHERE type = 'table' AND name = 'nodes'",
      )
      .get();
    return (row?.c ?? 0) >= 1;
  } catch {
    return false;
  }
}

/** Quick existence check used by tests and `doctor`. */
export function ftsTableExists(db: Database): boolean {
  try {
    db.query("SELECT 1 FROM nodes_fts LIMIT 0").get();
    return true;
  } catch {
    return false;
  }
}
