/**
 * `hayven importers <module-id> [--json]` — EXHAUSTIVE list of every node that
 * imports the module (ROADMAP Tier 1.2). Backed by the incoming `"import"`
 * edges of the graph, NOT FTS ranking: this is a complete enumeration, never a
 * top-N. If the id isn't found exactly, it resolves via the top FTS hit and
 * prints the chosen id to STDERR (stdout stays clean for `--json`).
 */
import type { ParsedArgs } from "../cli.ts";
import { warnIfStale } from "../db/freshness.ts";
import { importersOf, resolveNodeId } from "../db/graph_walk.ts";
import { isJson, openProjectDb, requireProject } from "./_shared.ts";

/** A `/`-containing input is a structured node id (the id scheme is slash-
 *  separated); a bare term is a loose search query. Mirrors impact/refs. */
function looksLikeExactId(rawId: string): boolean {
  return rawId.includes("/");
}

export async function runImporters(args: ParsedArgs): Promise<number> {
  const rawId = args.positionals[0];
  if (!rawId) {
    process.stderr.write("usage: hayven importers <module-id> [--json]\n");
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
    // A `/`-looking id (structured node id) that only FUZZY-resolved is almost
    // certainly a typo — proceeding would answer for a DIFFERENT module. Error out
    // (mirrors impact/refs so a fat-fingered id can't masquerade as a real answer);
    // a bare term keeps the fuzzy convenience.
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

    const edges = importersOf(db, id);
    if (isJson(args.flags)) {
      process.stdout.write(
        JSON.stringify(
          {
            module: id,
            // `null` when `rawId` matched exactly; the chosen id when it was
            // fuzzy-resolved via the top FTS hit (matches the HTTP `resolved`
            // shape so a `--json` consumer can tell it got a DIFFERENT module).
            resolved: resolved.resolved ? id : null,
            count: edges.length,
            importers: edges.map((e) => ({ id: e.src, kind: e.kind, weight: e.weight })),
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    // Importer weight is the import-edge occurrence count; it's rarely > 1 and
    // less meaningful than caller call-counts, but we surface the total import
    // edges for output symmetry with `refs`.
    const importSites = edges.reduce((sum, e) => sum + e.weight, 0);
    const sitesNote =
      importSites === edges.length ? "" : ` (${importSites} import edge(s))`;
    const lines = [
      `# Importers of \`${id}\``,
      "",
      `${edges.length} importer(s)${sitesNote}`,
      "",
    ];
    for (const e of edges) {
      const occ = e.weight === 1 ? "" : `  (${e.weight} imports)`;
      lines.push(`- \`${e.src}\`${occ}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}
