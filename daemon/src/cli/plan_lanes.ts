/**
 * `hayven plan-lanes <files...> [--symbols] [--depth N] [--json]` — GRAPH-COMPUTED
 * disjoint work lanes (the "10x where grep is 0x" capability).
 *
 * Given the files (or, with `--symbols`, the symbol ids) an operator intends to
 * change, partition them along the transitive blast-radius graph into lanes that
 * are pairwise disjoint in both files and symbols — i.e. safe to hand to parallel
 * agents that won't collide. Coupled changes (overlapping blast radius) land in
 * the same lane and must serialize; independent changes split into separate lanes.
 *
 * grep can tell you a symbol appears in a file; it cannot compute the
 * transitivity that decides whether two changes are actually independent. This
 * does, off the call/import graph (`db/lane_planner.ts`, the same reverse-BFS as
 * `hayven impact`).
 *
 * Default: positionals are FILE paths (the natural "I edited these files" entry
 * point, which also sidesteps symbol-name ambiguity). `--symbols` treats them as
 * symbol ids instead. `--depth N` caps the blast-radius walk. Read-only.
 */
import type { ParsedArgs } from "../cli.ts";
import { planLanes } from "../db/lane_planner.ts";
import { warnIfStale } from "../db/freshness.ts";
import { isJson, openProjectDb, requireProject } from "./_shared.ts";

export async function runPlanLanes(args: ParsedArgs): Promise<number> {
  // `--symbols` is a boolean flag, but the shared parser greedily treats the
  // token AFTER any `--flag` as its value (`--symbols foo bar` → symbols:"foo",
  // positionals:["bar"]). Recover the eaten token: a STRING value means the
  // parser swallowed the first symbol, so prepend it back. (`=`-forms and a
  // trailing `--symbols` both yield a boolean, the normal case.)
  const symFlag = args.flags["symbols"];
  const asSymbols = symFlag !== undefined && symFlag !== false;
  const positionals = [...args.positionals];
  if (typeof symFlag === "string" && symFlag !== "true") positionals.unshift(symFlag);

  if (positionals.length === 0) {
    process.stderr.write(
      "usage: hayven plan-lanes <files...> [--symbols] [--depth N] [--max-hub-degree N] [--json]\n",
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

  const depthFlag = args.flags["depth"];
  const maxDepth =
    depthFlag === undefined || depthFlag === true ? undefined : Number(depthFlag);
  const hubFlag = args.flags["max-hub-degree"];
  const maxHubDegree =
    hubFlag === undefined || hubFlag === true ? undefined : Number(hubFlag);

  const db = openProjectDb(ctx, { readonly: true });
  try {
    warnIfStale(db, ctx.paths);
    const plan = planLanes(
      db,
      asSymbols ? { symbols: positionals } : { files: positionals },
      {
        maxDepth: maxDepth !== undefined && !Number.isNaN(maxDepth) ? maxDepth : undefined,
        maxHubDegree:
          maxHubDegree !== undefined && !Number.isNaN(maxHubDegree) ? maxHubDegree : undefined,
      },
    );

    if (isJson(args.flags)) {
      process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
      return 0;
    }

    const lines = [`# Disjoint lane plan`, "", plan.note, ""];
    plan.lanes.forEach((lane, i) => {
      lines.push(`## Lane ${i + 1} — ${lane.seeds.length} seed(s)`);
      lines.push(`- seeds: ${lane.seeds.map((s) => `\`${s}\``).join(", ")}`);
      lines.push(`- files (${lane.files.length}): ${lane.files.join(", ")}`);
      lines.push(`- blast radius: ${lane.symbols.length} symbol(s)`);
      lines.push("");
    });
    if (plan.lanes.length > 1) {
      lines.push(
        `> ${plan.lanes.length} lanes are blast-radius-disjoint — safe to run concurrently.`,
      );
    }
    if (plan.hubsExcluded && plan.hubsExcluded.length > 0) {
      lines.push(
        `> excluded ${plan.hubsExcluded.length} hub(s) from coupling (in-degree > ${maxHubDegree}): ${plan.hubsExcluded.slice(0, 8).join(", ")}${plan.hubsExcluded.length > 8 ? ", …" : ""}`,
      );
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}
