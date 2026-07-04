/**
 * `hayven fleet-context --lanes <file.json|->` — a deduped briefing for a fan-out
 * of parallel agents.
 *
 * Input is a JSON array of lanes, `[{ "id": "...", "symbols": ["...", ...] }, ...]`
 * (from a file, or `-` for stdin). Output is the SHARED slice block (inject once
 * into every sub-agent), each lane's UNIQUE block, and the naive-vs-deduped token
 * accounting — so a builder hands each sub-agent `shared + perLane[i]` instead of N
 * full packs that each re-include the shared core.
 *
 * Read-only + daemonless, like `hayven context`.
 */
import type { ParsedArgs } from "../cli.ts";
import { fleetContext, type FleetLane } from "../db/fleet_context.ts";
import { warnIfStale } from "../db/freshness.ts";
import { isJson, openProjectDb, requireProject } from "./_shared.ts";

/** Read + validate the lanes JSON (from `--lanes <path>` or stdin via `-`). */
async function readLanes(spec: string): Promise<FleetLane[] | string> {
  let raw: string;
  try {
    raw = spec === "-" ? await Bun.stdin.text() : await Bun.file(spec).text();
  } catch (err) {
    return `could not read lanes from \`${spec}\`: ${(err as Error).message}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `lanes input is not valid JSON`;
  }
  if (!Array.isArray(parsed)) return `lanes must be a JSON array of { id, symbols }`;
  const lanes: FleetLane[] = [];
  for (const [i, l] of parsed.entries()) {
    if (
      typeof l !== "object" || l === null ||
      typeof (l as FleetLane).id !== "string" ||
      !Array.isArray((l as FleetLane).symbols) ||
      (l as FleetLane).symbols.some((s) => typeof s !== "string")
    ) {
      return `lane #${i} must be { id: string, symbols: string[] }`;
    }
    lanes.push({ id: (l as FleetLane).id, symbols: (l as FleetLane).symbols });
  }
  if (lanes.length < 2) return `need at least 2 lanes to dedup a fleet`;
  return lanes;
}

export async function runFleetContext(args: ParsedArgs): Promise<number> {
  const lanesFlag = args.flags["lanes"];
  if (typeof lanesFlag !== "string" || lanesFlag.length === 0) {
    process.stderr.write(
      'usage: hayven fleet-context --lanes <file.json|-> [--shared-min N] ' +
        '[--exemplars a,b] [--json]\n' +
        '  lanes JSON: [{ "id": "a", "symbols": ["pkg/foo", "pkg/bar"] }, ...]\n' +
        '  --exemplars: symbol ids pinned into the shared block as a canonical ' +
        'reference to copy (so lanes don\'t read each other\'s files)\n',
    );
    return 2;
  }
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  const lanes = await readLanes(lanesFlag);
  if (typeof lanes === "string") {
    process.stderr.write(`error: ${lanes}\n`);
    return 1;
  }

  const minFlag = args.flags["shared-min"];
  const sharedMinLanes =
    typeof minFlag === "string" && !Number.isNaN(Number(minFlag)) ? Number(minFlag) : undefined;

  const exemplarsFlag = args.flags["exemplars"];
  const exemplars =
    typeof exemplarsFlag === "string"
      ? exemplarsFlag.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;

  const db = openProjectDb(ctx, { readonly: true });
  try {
    warnIfStale(db, ctx.paths);
    const result = fleetContext(db, ctx.paths.repoRoot, lanes, { sharedMinLanes, exemplars });

    if (isJson(args.flags)) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }

    const { stats } = result;
    const lines: string[] = [
      `# Fleet context — ${stats.lanes} lanes`,
      "",
      `Shared ${stats.sharedSlices} slice(s) (~${result.shared.estTokens} tok) injected once` +
        (stats.exemplarSlices > 0
          ? `, incl. ${stats.exemplarSlices} pinned exemplar slice(s) (~${stats.exemplarTokens} tok)`
          : "") +
        `; naive ${stats.naiveTokens} → deduped ${stats.dedupedTokens} tokens, ` +
        `saved ${stats.savedTokens} (${stats.savedPct.toFixed(1)}%).`,
      "",
      "## Shared (inject into every lane)",
      "",
      result.shared.text.length > 0 ? result.shared.text : "_(no slice needed by ≥ the threshold lanes)_",
      "",
    ];
    for (const lane of result.perLane) {
      lines.push(`## Lane \`${lane.id}\` — unique (~${lane.uniqueTokens} tok)`);
      lines.push("");
      lines.push(lane.uniqueText.length > 0 ? lane.uniqueText : "_(fully covered by the shared block)_");
      lines.push("");
    }
    if (result.notes.length > 0) lines.push("> notes: " + result.notes.join("; "));
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}
