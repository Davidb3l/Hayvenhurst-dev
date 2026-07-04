/**
 * `hayven impact <symbol-id> [--depth N] [--json]` — TRANSITIVE
 * callers/dependents = the blast radius (ROADMAP Tier 3, the grep-can't-do-this
 * differentiator). BFS the INCOMING call+import edges transitively: "change
 * this → these N things break." Reports each hit's depth and the total count,
 * and is cycle-safe (a visited set bounds cycles; depth is additionally capped).
 *
 * `--depth N` caps the walk (default: unbounded, which maps to the
 * MAX_IMPACT_DEPTH=64 cycle/runaway guard). If the cap stops a still-expanding
 * frontier, a note is printed to STDERR. If the id isn't found exactly, it
 * resolves via the top FTS hit and prints the chosen id to STDERR (stdout stays
 * clean for `--json`).
 */
import type { ParsedArgs } from "../cli.ts";
import { warnIfStale } from "../db/freshness.ts";
import {
  impactOf,
  MAX_IMPACT_DEPTH,
  refsSummary,
  resolveNodeId,
} from "../db/graph_walk.ts";
import { previewImpact } from "../db/impact_preview.ts";
import { tryLocateNativeBinary } from "../native/locate.ts";
import { isJson, openProjectDb, requireProject } from "./_shared.ts";

/**
 * Does `rawId` LOOK like a structured node id rather than a loose search term?
 * The id scheme is slash-separated (e.g. `werkzeug/http/dump_cookie`), so a `/`
 * is a strong signal the user typed an exact id — which means a fuzzy FTS
 * substitution when it isn't found exactly is almost certainly a typo, not a
 * convenience. A bare term (no `/`, e.g. `dump_cookie`) is a legitimate loose
 * term and keeps the fuzzy-resolve behavior.
 */
function looksLikeExactId(rawId: string): boolean {
  return rawId.includes("/");
}

export async function runImpact(args: ParsedArgs): Promise<number> {
  const rawId = args.positionals[0];
  if (!rawId) {
    process.stderr.write(
      "usage: hayven impact <symbol-id> [--preview] [--depth N] [--json]\n",
    );
    return 2;
  }
  // `--preview` is a NEW mode (the pre-edit "what breaks if I change this
  // contract" decision tool); the plain `impact` path below is untouched.
  if (args.flags["preview"] === true || args.flags["preview"] === "true") {
    return runImpactPreview(args, rawId);
  }
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  // No --depth → unbounded (capped at MAX_IMPACT_DEPTH inside impactOf).
  const depthFlag = args.flags["depth"];
  const requestedDepth =
    depthFlag === undefined || depthFlag === true
      ? MAX_IMPACT_DEPTH
      : Number(depthFlag);
  const maxDepth = Number.isNaN(requestedDepth) ? MAX_IMPACT_DEPTH : requestedDepth;

  const db = openProjectDb(ctx, { readonly: true });
  try {
    warnIfStale(db, ctx.paths);
    const resolved = resolveNodeId(db, rawId);
    if (!resolved) {
      process.stderr.write(
        `No node with id \`${rawId}\` — try \`hayven query ${rawId}\` to fuzzy-find it.\n`,
      );
      return 1;
    }
    // A `/`-containing input LOOKS like a structured node id (the id scheme is
    // slash-separated, e.g. `werkzeug/http/dump_cookie`). If no node has it
    // EXACTLY, a fuzzy top-FTS-hit substitution is almost certainly NOT what the
    // user meant — proceeding would print a confident, WRONG "0 dependents" for a
    // fat-fingered id. Treat it as a not-found error instead (mirrors the
    // fully-not-found path above), so a typo can't masquerade as a real answer.
    if (resolved.resolved && looksLikeExactId(rawId)) {
      process.stderr.write(
        `No node with id \`${rawId}\` — try \`hayven query ${rawId}\` to search.\n`,
      );
      return 1;
    }
    const id = resolved.id;
    if (resolved.resolved) {
      process.stderr.write(`note: \`${rawId}\` not found exactly; using \`${id}\` (top search hit).\n`);
    }

    const result = impactOf(db, id, maxDepth);
    if (result.capped) {
      process.stderr.write(
        `note: walk capped at depth ${result.depth}; deeper dependents may exist (raise --depth).\n`,
      );
    }
    const maxHitDepth = result.hits.reduce((m, h) => Math.max(m, h.depth), 0);

    // Direct (depth-1) dependents carry a meaningful call/import occurrence
    // count from the edges into the root; surface it so "what breaks if I change
    // this" distinguishes a dependent that calls the root once from one that
    // calls it many times. Transitive (depth ≥ 2) hits have no single edge to
    // the root, so we only annotate direct ones.
    const directRefs = refsSummary(db, id);
    const directCallSites = directRefs.callSites;
    const weightOfDirect = new Map<string, number>();
    for (const r of directRefs.refs) {
      weightOfDirect.set(r.id, (weightOfDirect.get(r.id) ?? 0) + r.weight);
    }

    if (isJson(args.flags)) {
      process.stdout.write(
        JSON.stringify(
          {
            symbol: id,
            // `null` when `rawId` matched exactly; the chosen id when it was
            // fuzzy-resolved via the top FTS hit (matches the HTTP `resolved`
            // shape so a `--json` consumer can tell it got a DIFFERENT symbol).
            resolved: resolved.resolved ? id : null,
            depth: result.depth,
            capped: result.capped,
            count: result.hits.length,
            // Direct (depth-1) dependents and their total call occurrences.
            directDependents: directRefs.callerCount + directRefs.importerCount,
            directCallSites,
            max_depth_reached: maxHitDepth,
            // Each hit gains `weight` for depth-1 (occurrences into the root);
            // null for transitive hits where no single edge to the root exists.
            hits: result.hits.map((h) => ({
              ...h,
              weight: h.depth === 1 ? weightOfDirect.get(h.id) ?? null : null,
            })),
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    const lines = [
      `# Impact (transitive blast radius) of \`${id}\``,
      "",
      `${result.hits.length} dependent(s) within ${result.depth} hop(s)` +
        (result.capped ? " (capped)" : "") +
        ` — ${directRefs.callerCount + directRefs.importerCount} direct, ` +
        `${directCallSites} direct call site(s).`,
      "",
    ];
    for (const h of result.hits) {
      const w = h.depth === 1 ? weightOfDirect.get(h.id) : undefined;
      const occ =
        w !== undefined && w > 1 ? `  (${w} calls)` : "";
      lines.push(`- [depth ${h.depth}] \`${h.id}\`${occ}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hayven impact --preview <symbol-id> [--depth N] [--json]` — the PRE-EDIT
 * decision mode. Resolves the symbol, extracts its current contract (best-effort,
 * via the native signature index when a binary is present), computes the
 * transitive blast radius, and CLASSIFIES dependents into DIRECT contract-
 * breakers (depth-1, highest risk) vs TRANSITIVE (depth ≥ 2), each RANKED by
 * blast radius. Advisory only — see {@link PREVIEW_ADVISORY}.
 */
async function runImpactPreview(args: ParsedArgs, rawId: string): Promise<number> {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  const depthFlag = args.flags["depth"];
  const requestedDepth =
    depthFlag === undefined || depthFlag === true
      ? MAX_IMPACT_DEPTH
      : Number(depthFlag);
  const maxDepth = Number.isNaN(requestedDepth) ? MAX_IMPACT_DEPTH : requestedDepth;

  // Contract enrichment is best-effort: locate the native binary if present, but
  // degrade gracefully (contract = null) when it (or the index) is unavailable.
  const binary = tryLocateNativeBinary({ repoRoot: ctx.paths.repoRoot }) ?? undefined;

  const db = openProjectDb(ctx, { readonly: true });
  try {
    warnIfStale(db, ctx.paths);
    const preview = previewImpact(db, rawId, {
      repoRoot: ctx.paths.repoRoot,
      binary,
      depth: maxDepth,
    });
    if (!preview) {
      process.stderr.write(
        `No node with id \`${rawId}\` — try \`hayven query ${rawId}\` to fuzzy-find it.\n`,
      );
      return 1;
    }
    // Same typo guard as the plain walk: a `/`-looking id that only FUZZY-matched
    // is treated as not-found so a fat-fingered id can't silently preview an
    // unrelated symbol's blast radius. (`preview.resolved` is the chosen id when
    // fuzzy-resolved, null on an exact match.)
    if (preview.resolved && looksLikeExactId(rawId)) {
      process.stderr.write(
        `No node with id \`${rawId}\` — try \`hayven query ${rawId}\` to search.\n`,
      );
      return 1;
    }
    if (preview.resolved) {
      process.stderr.write(
        `note: \`${rawId}\` not found exactly; using \`${preview.symbol}\` (top search hit).\n`,
      );
    }
    if (preview.capped) {
      process.stderr.write(
        `note: walk capped at depth ${preview.depth}; deeper dependents may exist (raise --depth).\n`,
      );
    }
    if (!preview.contract && binary === undefined) {
      process.stderr.write(
        "note: no native binary found — contract details omitted (graph classification is unaffected). " +
          "Build it with `cd native && cargo build --release` for signature enrichment.\n",
      );
    }

    if (isJson(args.flags)) {
      process.stdout.write(
        JSON.stringify(
          {
            symbol: preview.symbol,
            resolved: preview.resolved,
            contract: preview.contract,
            depth: preview.depth,
            capped: preview.capped,
            directBreakers: preview.directBreakers,
            transitive: preview.transitive,
            advisory: preview.advisory,
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }

    const lines: string[] = [
      `# Impact preview — what breaks if you change \`${preview.symbol}\``,
      "",
    ];
    if (preview.contract) {
      lines.push(`Contract: \`${preview.contract.summary}\``);
    } else {
      lines.push("Contract: (no callable signature resolved — graph-only preview)");
    }
    lines.push("");
    lines.push(
      `${preview.directBreakers.length} DIRECT contract-breaker(s), ` +
        `${preview.transitive.length} transitive dependent(s) within ` +
        `${preview.depth} hop(s)${preview.capped ? " (capped)" : ""}.`,
    );
    lines.push("");

    lines.push(
      `## Direct contract-breakers (depth 1, highest risk) — ${preview.directBreakers.length}`,
    );
    if (preview.directBreakers.length === 0) {
      lines.push("- (none — nothing references this symbol directly)");
    }
    for (const b of preview.directBreakers) {
      const calls =
        b.callSites > 0
          ? `${b.callSites} call site${b.callSites === 1 ? "" : "s"}`
          : "import only";
      const sub = b.subtree > 0 ? `, drags ${b.subtree} transitive` : "";
      lines.push(`- \`${b.id}\`  (${b.via}, ${calls}${sub})`);
    }
    lines.push("");

    lines.push(
      `## Transitive dependents (depth ≥ 2, indirect risk) — ${preview.transitive.length}`,
    );
    if (preview.transitive.length === 0) {
      lines.push("- (none)");
    }
    for (const t of preview.transitive) {
      const sub = t.subtree > 0 ? `, drags ${t.subtree}` : "";
      lines.push(`- [depth ${t.depth}] \`${t.id}\`${sub}`);
    }
    lines.push("");
    lines.push(`> ${preview.advisory}`);

    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}
