/**
 * `hayven models <pull|list>` — local model lifecycle (ARCHITECTURE.md §18.3).
 *
 *   hayven models list                 Show registry entries, on-disk presence,
 *                                      and WHERE each copy lives.
 *   hayven models pull <id>            Download + sha256-verify + atomically
 *                                      install a model into the GLOBAL
 *                                      ~/.hayven/models/<dir>/.
 *
 * Weights are an opt-in pull (~1–2 GB), never bundled (§18.3). The pull is
 * idempotent — present + verified artifacts are skipped.
 *
 * WEIGHTS ARE GLOBAL. They used to be downloaded per-project, which meant the
 * same byte-identical multi-GB GGUF once per repo. They now live in the global
 * store, with a read fallback to a project's own legacy copy so nothing anyone
 * already downloaded is re-fetched. See `models/registry.ts`.
 */
import { detectRepoRoot, hayvenPathsFor } from "../util/paths.ts";
import {
  MODEL_REGISTRY,
  isModelPresent,
  modelLocations,
  type ModelEntry,
} from "../models/registry.ts";
import { PullError, installedBytesIn, pullModel } from "../models/install.ts";
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

/** Human-readable byte size, e.g. "3.1 GB". */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${bytes} B`;
}

function runList(args: ParsedArgs): number {
  // `list` is informational and works anywhere. Presence is GLOBAL-first, so it
  // is meaningful even outside a project; the project root only matters for
  // finding a legacy per-project copy, and a missing/uninitialized one simply
  // contributes no locations.
  const { root } = detectRepoRoot();
  const hayvenDir = hayvenPathsFor(root).hayvenDir;
  // Reflex tier-3 (the broadly-used Layer C models) first, then tier-2;
  // within a tier, smallest RAM floor first.
  const entries = Object.values(MODEL_REGISTRY).sort(
    (a, b) => b.tier - a.tier || a.minRamMb - b.minRamMb,
  );

  // Where each id lives, global-first. A copy in BOTH stores is REDUNDANT: the
  // global one wins resolution, so the per-project bytes are dead weight.
  // REPORT ONLY — this command never moves or deletes a weight file. An earlier
  // incident in this codebase had automated cleanup delete files it did not own,
  // and a mistaken `rm` here costs the user a multi-GB re-download. The human
  // decides.
  const located = new Map(entries.map((e) => [e.id, modelLocations(e.id, hayvenDir)]));
  const redundant = entries
    .map((e) => {
      const locs = located.get(e.id) ?? [];
      const project = locs.find((l) => l.scope === "project" && l.present);
      const global = locs.find((l) => l.scope === "global" && l.present);
      return project && global
        ? { id: e.id, dir: project.dir, bytes: installedBytesIn(project.hayvenDir, e.id) }
        : null;
    })
    .filter((r): r is { id: string; dir: string; bytes: number } => r !== null);

  const usedLoc = (id: string): { scope: string; dir: string } | null => {
    const hit = (located.get(id) ?? []).find((l) => l.present);
    return hit ? { scope: hit.scope, dir: hit.dir } : null;
  };

  if (args.flags["json"] === true || args.flags["json"] === "true") {
    const rows = entries.map((e) => {
      const used = usedLoc(e.id);
      return {
        id: e.id,
        tier: e.tier,
        params: e.params,
        minRamMb: e.minRamMb,
        present: isModelPresent(hayvenDir, e.id),
        /** Scope of the copy that would actually be loaded, or null. */
        scope: used?.scope ?? null,
        /** Directory of the copy that would actually be loaded, or null. */
        dir: used?.dir ?? null,
        /** Every candidate home, global first, with presence + size. */
        locations: (located.get(e.id) ?? []).map((l) => ({
          scope: l.scope,
          dir: l.dir,
          present: l.present,
          bytes: l.present ? installedBytesIn(l.hayvenDir, e.id) : 0,
        })),
        /** True when a per-project copy is shadowed by the global one. */
        redundant: redundant.some((r) => r.id === e.id),
      };
    });
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }

  const rows = entries.map((e) => {
    const used = usedLoc(e.id);
    return {
      id: e.id,
      tier: `tier-${e.tier}`,
      params: e.params,
      ram: `${(e.minRamMb / 1024).toFixed(1)} GB`,
      present: used ? "yes" : "no",
      where: used ? (used.scope === "global" ? "global" : "project (legacy)") : "-",
    };
  });

  const headers = {
    id: "ID",
    tier: "TIER",
    params: "PARAMS",
    ram: "MIN RAM",
    present: "PRESENT?",
    where: "WHERE",
  };
  const cols: (keyof typeof headers)[] = ["id", "tier", "params", "ram", "present", "where"];
  const width: Record<string, number> = {};
  for (const c of cols) {
    width[c] = Math.max(headers[c].length, ...rows.map((r) => r[c].length));
  }
  const fmt = (r: Record<string, string>): string =>
    cols.map((c) => r[c]!.padEnd(width[c]!)).join("  ").trimEnd();

  const lines = [fmt(headers), cols.map((c) => "-".repeat(width[c]!)).join("  ")];
  for (const r of rows) lines.push(fmt(r));
  process.stdout.write(lines.join("\n") + "\n");

  if (redundant.length > 0) {
    const total = redundant.reduce((s, r) => s + r.bytes, 0);
    const out = [
      "",
      `Redundant per-project copies (${fmtBytes(total)} reclaimable):`,
      ...redundant.map((r) => `  ${r.id}  ${r.dir}  (${fmtBytes(r.bytes)})`),
      "Weights are now shared from the global store, so these are unused.",
      "Hayvenhurst will NOT delete them — remove them yourself if you want the space.",
      "",
    ];
    process.stdout.write(out.join("\n"));
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

  // NO `requireProject` (deliberate change). It was guarding against audit H1:
  // mkdirSync-ing a multi-GB download into a MIS-RESOLVED `.hayven/models/`,
  // which was a real hazard back when the target was "whatever `.hayven` the cwd
  // walk happened to land on" — in `$HOME` that walk resolves to the global
  // config dir, and a stray `.git` could put it somewhere else again.
  //
  // The target is now `globalHayvenDir()`, which is a pure function of
  // `$HAYVEN_HOME`/`homedir()` and does not depend on the cwd at all, so there is
  // nothing left to mis-resolve and nothing the guard protects. Requiring a repo
  // to fetch a shared, immutable asset would just mean "cd somewhere else and
  // this fails", which is the annoyance without the safety.
  //
  // The project root is still resolved, best-effort and read-only, for ONE
  // reason: so a legacy per-project copy is found and NOT re-downloaded. An
  // uninitialized or absent project simply contributes no candidate location.
  const hayvenDir = hayvenPathsFor(detectRepoRoot().root).hayvenDir;

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
