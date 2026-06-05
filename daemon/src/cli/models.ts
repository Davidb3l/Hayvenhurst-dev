/**
 * `hayven models <pull|list>` — local model lifecycle (ARCHITECTURE.md §18.3).
 *
 *   hayven models list                 Show registry entries + on-disk presence.
 *   hayven models pull <id>            Download + sha256-verify + atomically
 *                                      install a model into .hayven/models/<dir>/.
 *
 * Weights are an opt-in pull (~1–2 GB), never bundled (§18.3). The pull is
 * idempotent — present + verified artifacts are skipped.
 */
import { existsSync } from "node:fs";

import { detectRepoRoot, hayvenPathsFor } from "../util/paths.ts";
import {
  MODEL_REGISTRY,
  isModelPresent,
  type ModelEntry,
} from "../models/registry.ts";
import { PullError, pullModel } from "../models/install.ts";
import { requireProject } from "./_shared.ts";
import type { ParsedArgs } from "../cli.ts";

export async function runModels(args: ParsedArgs): Promise<number> {
  const [sub, ...rest] = args.positionals;
  const subArgs: ParsedArgs = { positionals: rest, flags: args.flags };

  switch (sub) {
    case "list":
      return runList(subArgs);
    case "pull":
      return runPull(subArgs);
    case undefined:
      process.stderr.write(USAGE);
      return 2;
    default:
      process.stderr.write(`unknown models subcommand: ${sub}\n\n${USAGE}`);
      return 2;
  }
}

const USAGE = `usage:
  hayven models list            Show registry models + whether they're downloaded
  hayven models pull <id>       Download + verify + install a model
`;

function runList(args: ParsedArgs): number {
  // `list` is informational and works anywhere (so you can see what's available
  // before `init`). Presence is per-project, read against the resolved root; we
  // note when there's no initialized project so a "no" isn't mistaken for a
  // mis-read (audit H1, soft variant).
  const { root } = detectRepoRoot();
  const hayvenDir = hayvenPathsFor(root).hayvenDir;
  const initialized = existsSync(hayvenDir);
  // Reflex tier-3 (the broadly-used Layer C models) first, then tier-2;
  // within a tier, smallest RAM floor first.
  const entries = Object.values(MODEL_REGISTRY).sort(
    (a, b) => b.tier - a.tier || a.minRamMb - b.minRamMb,
  );

  if (args.flags["json"] === true || args.flags["json"] === "true") {
    const rows = entries.map((e) => ({
      id: e.id,
      tier: e.tier,
      params: e.params,
      minRamMb: e.minRamMb,
      present: isModelPresent(hayvenDir, e.id),
    }));
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }

  const rows = entries.map((e) => ({
    id: e.id,
    tier: `tier-${e.tier}`,
    params: e.params,
    ram: `${(e.minRamMb / 1024).toFixed(1)} GB`,
    present: isModelPresent(hayvenDir, e.id) ? "yes" : "no",
  }));

  const headers = { id: "ID", tier: "TIER", params: "PARAMS", ram: "MIN RAM", present: "PRESENT?" };
  const cols: (keyof typeof headers)[] = ["id", "tier", "params", "ram", "present"];
  const width: Record<string, number> = {};
  for (const c of cols) {
    width[c] = Math.max(headers[c].length, ...rows.map((r) => r[c].length));
  }
  const fmt = (r: Record<string, string>): string =>
    cols.map((c) => r[c]!.padEnd(width[c]!)).join("  ").trimEnd();

  const lines = [fmt(headers), cols.map((c) => "-".repeat(width[c]!)).join("  ")];
  for (const r of rows) lines.push(fmt(r));
  process.stdout.write(lines.join("\n") + "\n");
  if (!initialized) {
    process.stderr.write(
      "note: no initialized project here — PRESENT? reflects an uninitialized location. " +
        "Run `hayven init`, then `hayven models pull <id>`.\n",
    );
  }
  return 0;
}

async function runPull(args: ParsedArgs): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("usage: hayven models pull <id>   (see `hayven models list`)\n");
    return 2;
  }
  const entry: ModelEntry | undefined = MODEL_REGISTRY[id];
  if (!entry) {
    const known = Object.keys(MODEL_REGISTRY).join(", ");
    process.stderr.write(`error: unknown model id "${id}".\nKnown ids: ${known}\n`);
    return 1;
  }

  // Require an initialized project before downloading multi-GB weights — never
  // mkdirSync + pull into a mis-resolved or uninitialized `.hayven/models/`
  // (audit H1). Weights are per-project; `requireProject` refuses with the
  // friendly "run `hayven init`" message when there's no project here.
  let hayvenDir: string;
  try {
    hayvenDir = requireProject().paths.hayvenDir;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}`);
    return 1;
  }

  try {
    const result = await pullModel(hayvenDir, id, {
      onProgress: (line) => process.stdout.write(line + "\n"),
    });

    const counts = { downloaded: 0, "skipped-present": 0, "verify-skipped": 0 };
    for (const a of result.artifacts) counts[a.status]++;

    const parts: string[] = [];
    if (counts.downloaded) parts.push(`${counts.downloaded} downloaded+verified`);
    if (counts["verify-skipped"]) parts.push(`${counts["verify-skipped"]} downloaded (UNVERIFIED)`);
    if (counts["skipped-present"]) parts.push(`${counts["skipped-present"]} already present`);

    process.stdout.write(
      `\nDone: ${id} → ${result.dir}\n  ${parts.join(", ")}\n` +
        (counts["verify-skipped"]
          ? "  NOTE: one or more artifacts were installed without sha256 verification (see warnings above).\n"
          : ""),
    );
    return 0;
  } catch (err) {
    if (err instanceof PullError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
