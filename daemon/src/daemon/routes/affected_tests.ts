/**
 * `GET /api/affected-tests` — the HTTP twin of the `hayven affected-tests` CLI:
 * the MINIMAL ranked set of tests to run for a change (ROADMAP "trace-augmented
 * test-impact selection"), fusing the STATIC impact graph with RUNTIME trace
 * coverage. Read-only.
 *
 * QUERY params (NOT a path param): a node id can contain slashes, so — exactly
 * like graphRoutes' `/api/impact?id=` — the symbol arrives as `?id=`, never as a
 * `/:symbol` segment. This is a deliberate, consistent deviation kept in lockstep
 * with the rest of the edges-backed graph API.
 *
 *   - `?id=<symbol>`        → {@link affectedTests} (reverse-walk from the symbol).
 *   - `?changed=a,b,c`      → {@link affectedTestsForFiles} (walk from every
 *                             entity defined in those changed files).
 *   - `?trace_only=1|true`  → keep only ground-truth trace-reached tests.
 *   - `?limit=N`            → cap the ranked count.
 *   - `?depth=N`            → reverse-walk depth cap.
 *
 * `changed` takes precedence over `id` (the file-oriented entry point a `git
 * diff` produces). Missing BOTH → 400.
 *
 * Unlike the CLI, the daemon has no per-project config plumbed here, so
 * `opts.patterns` is omitted — the query falls back to its built-in default test
 * patterns, which is fine for the HTTP surface.
 *
 * Registered in server.ts alongside graphRoutes (before viewerRoutes' `/*`
 * catch-all). The query itself resolves the symbol, so no resolveNodeId preamble
 * is needed here.
 */
import { Elysia } from "elysia";

import {
  affectedTests,
  affectedTestsForFiles,
  type AffectedTestsOpts,
  type AffectedTestsResult,
} from "../../db/affected_tests.ts";
import type { ServerDependencies } from "../server.ts";

/** A boolean query flag is truthy when it is `"1"` or `"true"`. */
function boolParam(value: unknown): boolean {
  return value === "1" || value === "true";
}

/** Parse a numeric query param; undefined when absent, NaN, or non-string. */
function numParam(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

export function affectedTestsRoutes(deps: ServerDependencies) {
  return new Elysia().get("/api/affected-tests", ({ query, set }) => {
    const idRaw = query["id"];
    const changedRaw = query["changed"];

    const changedFiles =
      typeof changedRaw === "string"
        ? changedRaw
            .split(",")
            .map((f) => f.trim())
            .filter((f) => f.length > 0)
        : [];
    const hasChanged = changedFiles.length > 0;
    const hasId = typeof idRaw === "string" && idRaw.length > 0;

    if (!hasChanged && !hasId) {
      set.status = 400;
      return { error: "provide ?id=<symbol> or ?changed=<files>" };
    }

    // The daemon db has no config plumbed for patterns here — omit opts.patterns
    // (the query uses its built-in default test detection). traceOnly/limit/depth
    // are all honored.
    const opts: AffectedTestsOpts = {};
    if (boolParam(query["trace_only"])) opts.traceOnly = true;
    const limit = numParam(query["limit"]);
    if (limit !== undefined) opts.limit = limit;
    const depth = numParam(query["depth"]);
    if (depth !== undefined) opts.maxDepth = depth;

    // `changed` wins over `id` (the file-oriented entry point).
    const result: AffectedTestsResult = hasChanged
      ? affectedTestsForFiles(deps.db, changedFiles, opts)
      : affectedTests(deps.db, idRaw as string, opts);

    const head = hasChanged
      ? { changed: changedFiles }
      : { symbol: idRaw as string };
    return {
      ...head,
      roots: result.roots,
      count: result.tests.length,
      traceEdgeCount: result.traceEdgeCount,
      note: result.note,
      tests: result.tests,
    };
  });
}
