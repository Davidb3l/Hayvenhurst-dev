/**
 * `GET /api/search?q=...&limit=...&path=...&semantic=true` — FTS5 search.
 */
import { Elysia } from "elysia";

import { resolveSemanticInfer, searchFts, searchFtsSemantic } from "../../db/fts.ts";
import type { ServerDependencies } from "../server.ts";

export function searchRoutes(deps: ServerDependencies) {
  return new Elysia().get("/api/search", async ({ query, set }) => {
    // Contract (QA consistency fix): distinguish a *missing* `q` from a *present
    // but effectively-empty* one.
    //   - `q` absent entirely        → 400 (caller didn't supply the parameter).
    //   - `q` present but sanitizes  → 200 {hits:[],count:0} ("no results").
    //     to empty (e.g. `q=!@#`, punctuation-only)
    // Previously a present-but-empty `q` (length 0 or FTS-sanitized to empty)
    // both returned 400 vs 200 inconsistently; now "the caller asked, there's
    // just nothing to match" is uniformly a successful empty result. FTS
    // metachars stay safe — `searchFts`/`escapeFtsQuery` already strip them and
    // return `[]` without ever reaching a MATCH (so no 500s on injection).
    const qRaw = query["q"];
    if (typeof qRaw !== "string") {
      set.status = 400;
      return { error: "missing query parameter `q`" };
    }
    const q = qRaw;
    // Parse limit without the falsy-zero trap: `Number("0") || 20` would
    // coerce an explicit `limit=0` up to the default 20. Only a missing/
    // non-numeric param defaults to 20; the 1..100 clamp then floors 0 to 1.
    const rawLimit = query["limit"];
    const parsedLimit = rawLimit == null ? 20 : Number(rawLimit);
    const limit = Math.min(
      100,
      Math.max(1, Number.isNaN(parsedLimit) ? 20 : parsedLimit),
    );
    // Optional `path` prefix scopes results to nodes whose repo-relative file
    // path begins with it. Absent/non-string/empty → unfiltered (byte-identical
    // to the pre-filter response). `searchFts` normalizes the trailing slash and
    // neutralizes LIKE/FTS wildcards in the prefix.
    const pathRaw = query["path"];
    const path = typeof pathRaw === "string" ? pathRaw : undefined;
    // Optional `&semantic=true` opts into the model-gated query-expansion path
    // (`searchFtsSemantic`). With NO model present, `resolveSemanticInfer`
    // returns `undefined` and `searchFtsSemantic` degrades to the model-free
    // base — i.e. AT LEAST the `searchFts` results, never an error. The semantic
    // path honors `path` too: model expansion applies WITHIN the scoped prefix,
    // so the echoed `path` in the response is truthful.
    const semanticRaw = query["semantic"];
    const semantic = semanticRaw === "true" || semanticRaw === "1";
    const hits = semantic
      ? await searchFtsSemantic(
          deps.db.handle,
          q,
          resolveSemanticInfer({
            hayvenDir: deps.paths.hayvenDir,
            modelId: deps.config.models.tier3.model,
            repoRoot: deps.paths.repoRoot,
          }),
          limit,
          { path },
        )
      : searchFts(deps.db.handle, q, limit, { path });
    const out: { query: string; count: number; hits: typeof hits; path?: string } = {
      query: q,
      count: hits.length,
      hits,
    };
    if (path != null && path.trim().length > 0) out.path = path;
    return out;
  });
}
