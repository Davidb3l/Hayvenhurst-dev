/**
 * Context-cost PACKER API (Phase 0.0.4.5 pivot — see `docs/PHASE_0.0.4.5_PIVOT.md`
 * §4d/§5): the daemon endpoint a BUILDER (Agent-SDK app / multi-agent harness)
 * calls to fetch a graph-precise context pack PROGRAMMATICALLY, instead of
 * re-sending whole files. This is the adoption layer for `db/context_pack.ts` —
 * the embedding-free, never-stale, line-exact slice pack that cut re-sent context
 * tokens 78–86% in the pivot measurement.
 *
 *   - `GET /api/context/:symbol`  — the minimal precise pack (header + target
 *       body + 1-hop callee/ref neighbors) for one symbol, line-exact.
 *       Query: `neighbors` (default true; `?neighbors=false`),
 *              `maxNeighbors` (int), `maxRefSliceLines` (int).
 *       404 (with a helpful body) when the symbol resolves to no node.
 *   - `GET /api/context?task=<text>&top=N`  — task mode: resolve a natural-language
 *       task to candidate symbols via the embedding-free FTS path
 *       (`resolveTaskToSymbols`), pack each, and return
 *       `{ task, resolved: string[], packs: ContextPack[] }`.
 *
 * Entity ids contain `/` (e.g. `utils/cookie/parse`); Elysia path params don't
 * capture slashes, so — exactly like `routes/nodes.ts` — we accept the symbol
 * via a `:symbol` segment (single/encoded id) AND a `/*` wildcard tail (raw
 * slashed id). Both run through `decodePathId`.
 *
 * All READ-ONLY (GET) — no `assertDaemonServesProject` needed. Mirrors the
 * `ServerDependencies`/`deps` wiring of `routes/graph.ts`.
 *
 * Registered in server.ts BEFORE viewerRoutes (its `/*` catch-all must stay
 * last). The task-mode `GET /api/context` (no path segment) is registered
 * before the `:symbol`/`*` routes so it isn't shadowed by them.
 */
import { Elysia } from "elysia";

import { buildContextPack, type ContextPackOptions } from "../../db/context_pack.ts";
import { resolveTaskToSymbols } from "../../db/task_resolve.ts";
import type { ServerDependencies } from "../server.ts";

/**
 * Decode an entity id that arrived on the URL path. Entity ids routinely contain
 * `/` (e.g. `utils/cookie/parse`); they reach us either url-encoded into a single
 * `:symbol` segment (`utils%2Fcookie%2Fparse`) or raw across a `/*` wildcard tail
 * (`utils/cookie/parse`). `decodeURIComponent` can throw on a malformed `%` — fall
 * back to the raw value so a weird-but-real id still gets an honest 404, not a 500.
 * (Same approach as `routes/nodes.ts::decodePathId`.)
 */
function decodePathId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Helpful 404 body for an unresolved symbol — mirrors `routes/nodes.ts`. */
function notFound(set: { status?: number | string }, symbol: string) {
  set.status = 404;
  return {
    error: "no node for symbol",
    symbol,
    hint:
      "entity ids may contain '/'; pass it raw on the path " +
      "(e.g. /api/context/utils/cookie/parse) or url-encoded " +
      "(/api/context/utils%2Fcookie%2Fparse). " +
      "Use `hayven query <text>` (or GET /api/context?task=<text>) to fuzzy-find it.",
  };
}

/** Parse a query value as a positive-ish int, or `undefined` when absent/invalid
 *  (so the packer falls back to its own default). */
function intParam(v: unknown): number | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Build the packer options from the shared query params. `neighbors` defaults
 *  to true; only `?neighbors=false` (or `=0`) turns it off. */
function optsFromQuery(query: Record<string, string | undefined>): ContextPackOptions {
  const neighbors = !(query["neighbors"] === "false" || query["neighbors"] === "0");
  return {
    neighbors,
    maxNeighbors: intParam(query["maxNeighbors"]),
    maxRefSliceLines: intParam(query["maxRefSliceLines"]),
  };
}

export function contextRoutes(deps: ServerDependencies) {
  const packFor = (symbol: string, opts: ContextPackOptions) =>
    buildContextPack(deps.db, deps.paths.repoRoot, symbol, opts);

  return (
    new Elysia()
      // Task mode FIRST so the bare `/api/context?task=…` path isn't shadowed by
      // the `:symbol` / `*` symbol routes below.
      .get("/api/context", ({ query, set }) => {
        const task = query["task"];
        if (typeof task !== "string" || task.trim().length === 0) {
          set.status = 400;
          return {
            error: "missing `task`",
            hint:
              "GET /api/context?task=<text>&top=N for task mode, " +
              "or GET /api/context/<symbol> for a single symbol.",
          };
        }
        const top = intParam(query["top"]);
        const limit = top !== undefined && top > 0 ? top : 3;
        const opts = optsFromQuery(query);
        const resolved = resolveTaskToSymbols(deps.db, task, limit);
        const packs = resolved
          .map((id) => packFor(id, opts))
          .filter((p): p is NonNullable<typeof p> => p !== null);
        return { task, resolved: packs.map((p) => p.symbol), packs };
      })
      // Single/already-encoded ids (`utils%2Fcookie%2Fparse`, or a slash-free id).
      .get("/api/context/:symbol", ({ params, query, set }) => {
        const symbol = decodePathId(params.symbol);
        const pack = packFor(symbol, optsFromQuery(query));
        if (!pack) return notFound(set, symbol);
        return pack;
      })
      // Raw slashed ids (`utils/cookie/parse`) arrive split across segments; the
      // wildcard rejoins them into `params["*"]` so the id stays intact.
      .get("/api/context/*", ({ params, query, set }) => {
        const symbol = decodePathId(params["*"]);
        const pack = packFor(symbol, optsFromQuery(query));
        if (!pack) return notFound(set, symbol);
        return pack;
      })
  );
}
