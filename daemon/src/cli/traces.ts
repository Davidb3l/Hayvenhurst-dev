/**
 * `hayven traces <id> [--json]`
 *
 * Shows the runtime trace observations recorded for a node — the observed
 * callers and callees with their invocation counts. This is the same
 * trace-derived data the node-detail markdown surfaces under its
 * "Observed callers/callees (from traces)" sections, read straight from the
 * `observations` table (the denormalized read cache the trace-ingest path
 * keeps populated; the G-Set CRDT is the source of truth).
 *
 * Observation rows are `(src, dst, ts, observed, weight, source)`:
 *   - observed callers of <id> = rows where `dst = id` (something called <id>),
 *     grouped by `src`.
 *   - observed callees of <id> = rows where `src = id` (<id> called something),
 *     grouped by `dst`.
 *
 * `weight = observed * sample_rate` is the scaled invocation estimate the
 * tracer reports; we surface it as the invocation count (matching the
 * node-detail markdown) and also carry the raw `observed` sample count and the
 * number of contributing observation rows in `--json`. We show exactly what is
 * recorded — nothing is inferred.
 */
import type { ParsedArgs } from "../cli.ts";
import { isJson, openProjectDb, requireProject } from "./_shared.ts";

interface ObservedNeighbor {
  /** The other endpoint (a caller's `src`, or a callee's `dst`). */
  id: string;
  /** Summed scaled invocation estimate (`weight`) across observation rows. */
  invocations: number;
  /** Summed raw sample count (`observed`) across observation rows. */
  observed: number;
  /** Number of contributing observation rows. */
  samples: number;
}

interface NeighborAgg {
  invocations: number;
  observed: number;
  samples: number;
}

function aggregate(
  rows: Array<{ other: string; observed: number; weight: number }>,
): ObservedNeighbor[] {
  const byOther = new Map<string, NeighborAgg>();
  for (const r of rows) {
    const cur = byOther.get(r.other) ?? { invocations: 0, observed: 0, samples: 0 };
    cur.invocations += r.weight;
    cur.observed += r.observed;
    cur.samples += 1;
    byOther.set(r.other, cur);
  }
  return [...byOther.entries()]
    .map(([id, a]) => ({ id, invocations: a.invocations, observed: a.observed, samples: a.samples }))
    .sort((a, b) => b.invocations - a.invocations || a.id.localeCompare(b.id));
}

export async function runTraces(args: ParsedArgs): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("usage: hayven traces <id> [--json]\n");
    return 2;
  }
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  const db = openProjectDb(ctx, { readonly: true });
  try {
    if (!db.getNode(id)) {
      process.stderr.write(
        `No node with id \`${id}\` — try \`hayven query ${id}\` to fuzzy-find it.\n`,
      );
      return 1;
    }

    // Observed callers: someone called <id> (dst = id). Observed callees:
    // <id> called someone (src = id). Read straight from the observation cache.
    const callerRows = db.handle
      .query<{ other: string; observed: number; weight: number }, [string]>(
        "SELECT src AS other, observed, weight FROM observations WHERE dst = ?",
      )
      .all(id);
    const calleeRows = db.handle
      .query<{ other: string; observed: number; weight: number }, [string]>(
        "SELECT dst AS other, observed, weight FROM observations WHERE src = ?",
      )
      .all(id);

    const callers = aggregate(callerRows);
    const callees = aggregate(calleeRows);

    // Resolved trace edges: every observation edge whose RUNTIME `src`/`dst`
    // resolves to this entity `id` via the node index (PRD §7 trace-augmented
    // edges). Raw names that resolved exactly to `id` would already match the
    // verbatim caller/callee aggregation above; the value here is surfacing the
    // edges where the runtime name was a DIFFERENT string that resolved to `id`
    // (e.g. `myapp.auth:loginHandler` → `auth/login/loginHandler`), which the
    // raw `src = id`/`dst = id` lookups miss. We compute resolution at read time
    // against the live index; unresolved endpoints stay flagged (null).
    const allEdges = db.resolvedTraceEdges();
    const resolvedCallers = allEdges
      .filter((e) => e.resolvedDst === id)
      .map((e) => ({
        raw: e.rawSrc,
        resolved: e.resolvedSrc,
        invocations: e.weight,
        observed: e.observed,
        samples: e.samples,
      }))
      .sort((a, b) => b.invocations - a.invocations || a.raw.localeCompare(b.raw));
    const resolvedCallees = allEdges
      .filter((e) => e.resolvedSrc === id)
      .map((e) => ({
        raw: e.rawDst,
        resolved: e.resolvedDst,
        invocations: e.weight,
        observed: e.observed,
        samples: e.samples,
      }))
      .sort((a, b) => b.invocations - a.invocations || a.raw.localeCompare(b.raw));

    if (isJson(args.flags)) {
      process.stdout.write(
        JSON.stringify(
          { id, callers, callees, resolvedCallers, resolvedCallees },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }

    const lines: string[] = [`# Traces for \`${id}\``, ""];
    if (
      callers.length === 0 &&
      callees.length === 0 &&
      resolvedCallers.length === 0 &&
      resolvedCallees.length === 0
    ) {
      lines.push("_No observations yet._ Record runtime traces with the `hayven_trace` collector.");
      process.stdout.write(lines.join("\n") + "\n");
      return 0;
    }

    lines.push("## Observed callers (from traces)");
    lines.push(...renderNeighbors(callers));
    lines.push("");
    lines.push("## Observed callees (from traces)");
    lines.push(...renderNeighbors(callees));
    if (resolvedCallers.length > 0 || resolvedCallees.length > 0) {
      lines.push("");
      lines.push("## Resolved trace edges (runtime name → entity)");
      lines.push("Callers (resolved to this entity):");
      lines.push(...renderResolved(resolvedCallers));
      lines.push("Callees (resolved to this entity):");
      lines.push(...renderResolved(resolvedCallees));
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

function renderNeighbors(neighbors: ObservedNeighbor[]): string[] {
  if (neighbors.length === 0) return ["_None observed yet._"];
  return neighbors.map(
    (n) => `- \`${n.id}\` (${n.invocations} invocation${n.invocations === 1 ? "" : "s"})`,
  );
}

interface ResolvedNeighbor {
  raw: string;
  resolved: string | null;
  invocations: number;
}

function renderResolved(neighbors: ResolvedNeighbor[]): string[] {
  if (neighbors.length === 0) return ["_None._"];
  return neighbors.map((n) => {
    const inv = `${n.invocations} invocation${n.invocations === 1 ? "" : "s"}`;
    const target = n.resolved ?? "?: unresolved";
    return `- \`${n.raw}\` → \`${target}\` (${inv})`;
  });
}
