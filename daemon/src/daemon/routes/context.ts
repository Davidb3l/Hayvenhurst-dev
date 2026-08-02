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
 *       `{ task, resolved: string[], packs: ContextPack[] }`. `top` is capped
 *       (see {@link MAX_TOP}); an out-of-range knob is a 400, never a silent
 *       substitution.
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

/**
 * Hard ceiling for `?top=N` in task mode.
 *
 * EVERY resolved symbol costs a full {@link buildContextPack}: graph walks plus
 * a whole-file read each, all on the daemon's SINGLE event loop. `intParam`
 * accepted any finite number, so `?top=1e9` on a 600-entity repo with 500 KB
 * files measured 440 ms, 135 MB RSS and ~300 MB read — and the daemon has no
 * Origin gate, so any web page open in the user's browser can fire that at
 * 127.0.0.1:7777 in a loop. The MCP wire caps its equivalent (`MAX_SYMBOLS`);
 * this is the HTTP twin of that cap.
 */
const MAX_TOP = 50;
const DEFAULT_TOP = 3;

/** Ceiling for the integer packer knobs. They only ever CAP work, but an
 *  unvalidated one is how `maxRefSliceLines=-1` produced inverted slice ranges. */
const MAX_PACK_OPT = 100_000;

/** A bounded integer query param. Returns the value, `undefined` when absent,
 *  or an ERROR OBJECT when present-but-invalid — the route turns that into a
 *  400 rather than silently substituting a default, so a client sending
 *  `?maxNeighbors=-3` learns it was wrong instead of quietly getting a pack
 *  with every neighbor dropped and an HTTP 200. */
type IntParam = number | undefined | { error: string };

function intParam(name: string, v: unknown, min: number, max: number): IntParam {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { error: `\`${name}\` must be an integer (got ${v}).` };
  }
  if (n < min || n > max) {
    return { error: `\`${name}\` must be between ${min} and ${max} (got ${n}).` };
  }
  return n;
}

function isParamError<T>(v: T | { error: string }): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v;
}

/** Build the packer options from the shared query params. `neighbors` defaults
 *  to true; only `?neighbors=false` (or `=0`) turns it off. Returns an error
 *  object when a knob is present but out of range. */
function optsFromQuery(
  query: Record<string, string | undefined>,
): ContextPackOptions | { error: string } {
  const neighbors = !(query["neighbors"] === "false" || query["neighbors"] === "0");
  const maxNeighbors = intParam("maxNeighbors", query["maxNeighbors"], 0, MAX_PACK_OPT);
  if (isParamError(maxNeighbors)) return maxNeighbors;
  // 0 would yield a `start .. start-1` slice; 1 is the floor.
  const maxRefSliceLines = intParam(
    "maxRefSliceLines",
    query["maxRefSliceLines"],
    1,
    MAX_PACK_OPT,
  );
  if (isParamError(maxRefSliceLines)) return maxRefSliceLines;
  return { neighbors, maxNeighbors, maxRefSliceLines };
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
        const top = intParam("top", query["top"], 1, MAX_TOP);
        if (isParamError(top)) {
          set.status = 400;
          return { error: top.error, hint: `\`top\` is capped at ${MAX_TOP}.` };
        }
        const limit = top ?? DEFAULT_TOP;
        const opts = optsFromQuery(query);
        if (isParamError(opts)) {
          set.status = 400;
          return { error: opts.error };
        }
        const resolved = resolveTaskToSymbols(deps.db, task, limit);
        const packs = resolved
          .map((id) => packFor(id, opts))
          .filter((p): p is NonNullable<typeof p> => p !== null);
        return { task, resolved: packs.map((p) => p.symbol), packs };
      })
      // Single/already-encoded ids (`utils%2Fcookie%2Fparse`, or a slash-free id).
      .get("/api/context/:symbol", ({ params, query, set }) => {
        const symbol = decodePathId(params.symbol);
        const opts = optsFromQuery(query);
        if (isParamError(opts)) {
          set.status = 400;
          return { error: opts.error };
        }
        const pack = packFor(symbol, opts);
        if (!pack) return notFound(set, symbol);
        return pack;
      })
      // Raw slashed ids (`utils/cookie/parse`) arrive split across segments; the
      // wildcard rejoins them into `params["*"]` so the id stays intact.
      .get("/api/context/*", ({ params, query, set }) => {
        const symbol = decodePathId(params["*"]);
        const opts = optsFromQuery(query);
        if (isParamError(opts)) {
          set.status = 400;
          return { error: opts.error };
        }
        const pack = packFor(symbol, opts);
        if (!pack) return notFound(set, symbol);
        return pack;
      })
  );
}
