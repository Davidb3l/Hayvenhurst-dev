/**
 * `hayven refs <symbol-id> [--json]` — EXHAUSTIVE references/usages of a symbol
 * (ROADMAP Tier 1.2): ALL callers (incoming call edges, kinds like
 * `static_call`) UNION ALL importers (incoming `"import"` edges). Complete,
 * edges-backed, unbounded — NOT a ranked top-N. If the id isn't found exactly,
 * it resolves via the top FTS hit and prints the chosen id to STDERR (stdout
 * stays clean for `--json`).
 */
import type { ParsedArgs } from "../cli.ts";
import { warnIfStale } from "../db/freshness.ts";
import { refsSummary, resolveNodeId, sitesOf } from "../db/graph_walk.ts";
import { isJson, openProjectDb, requireProject } from "./_shared.ts";

export async function runRefs(args: ParsedArgs): Promise<number> {
  const rawId = args.positionals[0];
  if (!rawId) {
    process.stderr.write("usage: hayven refs <symbol-id> [--json]\n");
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
    warnIfStale(db, ctx.paths);
    const resolved = resolveNodeId(db, rawId);
    if (!resolved) {
      process.stderr.write(
        `No node with id \`${rawId}\` — try \`hayven query ${rawId}\` to fuzzy-find it.\n`,
      );
      return 1;
    }
    const id = resolved.id;
    if (resolved.resolved) {
      process.stderr.write(`note: \`${rawId}\` not found exactly; using \`${id}\` (top search hit).\n`);
    }

    const { refs, callerCount, importerCount, callSites, importSites } =
      refsSummary(db, id);
    const callers = refs.filter((r) => r.via === "call");
    const importers = refs.filter((r) => r.via === "import");
    // `--sites`: line-precise EXHAUSTIVE call sites (file:line:col per
    // occurrence), backed by the `call_sites` table. Empty until the native
    // binary emits line/col AND the index has been re-ingested at schema v5.
    const wantSites = args.flags["sites"] === true || args.flags["sites"] === "true";
    const sites = wantSites ? sitesOf(db, id) : [];
    if (isJson(args.flags)) {
      process.stdout.write(
        JSON.stringify(
          {
            symbol: id,
            // `null` when `rawId` matched exactly; the chosen id when it was
            // fuzzy-resolved via the top FTS hit (matches the HTTP `resolved`
            // shape so a `--json` consumer can tell it got a DIFFERENT symbol).
            resolved: resolved.resolved ? id : null,
            count: refs.length,
            // Convenience aggregates for refactors: `callerCount` = distinct
            // caller entities; `callSites` = SUM of caller weights = total
            // textual call occurrences a signature change must touch. The
            // per-edge `weight` fields below are unchanged (backward-compatible).
            callerCount,
            importerCount,
            callSites,
            importSites,
            callers: callers.map((r) => ({ id: r.id, kind: r.kind, weight: r.weight })),
            importers: importers.map((r) => ({ id: r.id, kind: r.kind, weight: r.weight })),
            // `--sites`: line-precise call-site array (ADDITIVE — present only
            // when `--sites` is passed, so default `--json` output is unchanged).
            ...(wantSites
              ? {
                  sites: sites.map((s) => ({
                    file: s.file,
                    line: s.line,
                    col: s.col,
                    caller: s.caller,
                  })),
                }
              : {}),
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    // Header states BOTH numbers so an agent can tell caller entities (dedup'd
    // call edges) apart from textual call sites (summed occurrences) — the gap
    // that made a signature-change refactor distrust `refs` and fall back to grep.
    const callSitesNote =
      callSites === callerCount
        ? ""
        : ` (a single caller can call \`${id}\` more than once)`;
    const lines = [
      `# References to \`${id}\``,
      "",
      `${callSites} call site(s) across ${callerCount} caller(s)${callSitesNote}; ` +
        `${importerCount} importer(s). ${refs.length} reference edge(s) total.`,
      "",
    ];
    lines.push(`## Callers (${callerCount} caller(s), ${callSites} call site(s))`);
    for (const r of callers) {
      const calls = `${r.weight} call${r.weight === 1 ? "" : "s"}`;
      lines.push(`- \`${r.id}\`  (${r.kind}, ${calls})`);
    }
    lines.push("");
    lines.push(`## Importers (${importerCount})`);
    for (const r of importers) lines.push(`- \`${r.id}\``);
    if (wantSites) {
      lines.push("");
      lines.push(`## Call sites (${sites.length})`);
      if (sites.length === 0) {
        // Empty either because no resolved call carried line/col (older native
        // binary) or the index predates the schema-v5 re-ingest. Be explicit so
        // the absence isn't mistaken for "no callers".
        lines.push(
          "- (none — re-run `hayven ingest` with a native binary that emits call-site line/col)",
        );
      } else {
        // Group line-precise occurrences under their caller. Each entry is an
        // EXHAUSTIVE `file:line:col`, never a top-N.
        const byCaller = new Map<string, typeof sites>();
        for (const s of sites) {
          let arr = byCaller.get(s.caller);
          if (!arr) {
            arr = [];
            byCaller.set(s.caller, arr);
          }
          arr.push(s);
        }
        for (const caller of [...byCaller.keys()].sort((a, b) => a.localeCompare(b))) {
          lines.push(`- \`${caller}\``);
          for (const s of byCaller.get(caller)!) {
            lines.push(`  - ${s.file}:${s.line}:${s.col}`);
          }
        }
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}
