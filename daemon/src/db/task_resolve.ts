/**
 * `resolveTaskToSymbols` — the EMBEDDING-FREE fuzzy entry to the context packer.
 *
 * The Phase 0.0.4.5 pivot doc named the packer `hayven context <symbol|task>`,
 * but only the `<symbol>` half existed: the caller had to already know the exact
 * (or fuzzily-resolvable single) symbol. This closes the `<task>` half — a
 * BUILDER can ask for context by a NATURAL-LANGUAGE task ("how does the daemon
 * converge peers after a partition") and get back a ranked list of candidate
 * symbols to pack.
 *
 * The wedge vs embedding RAG: we do NOT embed the task or the codebase. We reuse
 * the EXISTING full-text search (`searchFts`, `daemon/src/db/fts.ts`) — FTS5
 * trigram + the model-free expansion floor (identifier tokenization + abbrev
 * table) + the relaxed stopword-dropping NL fallback. That keeps the property
 * the pivot leans on: exact-identifier, never-stale, line-exact, fully local
 * (no model, no network, no vector index to drift). FTS ranks the hits; we then
 * filter to ENTITY nodes (a `module` node's "body" is the whole file, which is
 * exactly the whole-file context the packer exists to avoid), dedupe while
 * preserving FTS rank order, and cap at `limit`.
 */
import type { Db } from "./queries.ts";
import { searchFts } from "./fts.ts";

/**
 * Resolve a natural-language task description to a ranked list of candidate node
 * ids, for the packer to assemble a slice per symbol.
 *
 * Embedding-free: this is a thin, deterministic ranking layer over `searchFts`
 * (the same FTS the rest of the CLI uses), not a semantic/vector search.
 *
 *   - Over-fetches FTS hits (rank order preserved) so that after dropping module
 *     nodes there are still enough entity candidates to fill `limit`.
 *   - Drops `kind === "module"` nodes (their slice would be the whole file — the
 *     opposite of a precise pack) via `db.getNode`.
 *   - Dedupes by id, keeping the first (best-ranked) occurrence.
 *   - Caps the result at `limit`.
 *
 * Returns `[]` when the task text is empty, FTS finds nothing, or every hit is a
 * module node — the caller should surface a friendly "no match" message.
 */
export function resolveTaskToSymbols(
  db: Db,
  taskText: string,
  limit = 3,
): string[] {
  const cap = Math.max(0, Math.trunc(limit));
  if (cap === 0) return [];
  if (taskText.trim().length === 0) return [];

  // Over-fetch: module nodes (and any duplicate ids) get filtered out below, so
  // pull a wider pool than `cap` to avoid under-filling when the top hits are
  // modules. The pool is bounded and cheap (searchFts is the synchronous,
  // model-free hot path).
  const pool = Math.max(cap * 5, 20);
  const hits = searchFts(db.handle, taskText, pool);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (seen.has(hit.id)) continue;
    const node = db.getNode(hit.id);
    // Skip hits with no backing node (stale FTS row) and module nodes (their
    // body is the whole file — exactly what the packer avoids).
    if (!node || node.kind === "module") continue;
    seen.add(hit.id);
    out.push(hit.id);
    if (out.length >= cap) break;
  }
  return out;
}
