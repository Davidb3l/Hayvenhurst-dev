#!/usr/bin/env bun
/**
 * `hayven` CLI entry point.
 *
 * We roll our own argv parsing — it's simple, has zero deps, and keeps the
 * CLI surface small. Each subcommand lives in its own cohesive module under
 * `cli/`, exporting a `run*` handler. Dispatch + help are both driven by the
 * single {@link COMMANDS} table below: adding a subcommand is ONE entry there
 * (name + group + help line + handler), not a separate import-list edit, a
 * `switch` case, AND a hand-maintained help block that can silently drift.
 */
import { runAffectedTests } from "./cli/affected_tests.ts";
import { runBranches } from "./cli/branches.ts";
import { runClaim } from "./cli/claim.ts";
import { runConfig } from "./cli/config.ts";
import { runContext } from "./cli/context.ts";
import { runDaemon } from "./cli/daemon.ts";
import { runDoctor } from "./cli/doctor.ts";
import { runImpact } from "./cli/impact.ts";
import { runFleetContext } from "./cli/fleet_context.ts";
import { runImporters } from "./cli/importers.ts";
import { runIngest } from "./cli/ingest.ts";
import { runInit } from "./cli/init.ts";
import { runMcp } from "./cli/mcp.ts";
import { runProxy } from "./cli/proxy.ts";
import { runRecall, runRemember } from "./cli/memory.ts";
import { runRefs } from "./cli/refs.ts";
import { runModels } from "./cli/models.ts";
import { runNeighbors } from "./cli/neighbors.ts";
import { runPlanLanes } from "./cli/plan_lanes.ts";
import { runNode } from "./cli/node.ts";
import { runQuery } from "./cli/query.ts";
import { runReindex } from "./cli/reindex.ts";
import { runRelease } from "./cli/release.ts";
import { runSummarize } from "./cli/summarize.ts";
import { runSync } from "./cli/sync.ts";
import { runTraces } from "./cli/traces.ts";
import { runView } from "./cli/view.ts";
import { VERSION } from "./version.ts";

export { VERSION };

/** Lightweight argv parser. Returns `{ positionals, flags }`. */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Which help section a command renders under. */
type CommandGroup = "common" | "coordination";

/**
 * A CLI subcommand: its dispatch `name`, the help `group` + pre-aligned `help`
 * line shown by `hayven help`, and the `run` handler. The single source of
 * truth for both dispatch and help — see the module header.
 */
interface Command {
  name: string;
  group: CommandGroup;
  /** Help line as rendered (the text after the 2-space indent), pre-aligned. */
  help: string;
  run: (args: ParsedArgs) => Promise<number>;
}

const COMMANDS: readonly Command[] = [
  { name: "init", group: "common", run: runInit,
    help: "init                       Initialize .hayven/ in the current project and run a first ingest" },
  { name: "ingest", group: "common", run: runIngest,
    help: "ingest [path] [--full]     Re-scan the codebase (incremental by default)" },
  { name: "query", group: "common", run: runQuery,
    help: "query <terms...> [--json]  Full-text search across the indexed graph" },
  { name: "neighbors", group: "common", run: runNeighbors,
    help: "neighbors <id> [--depth N] Walk the graph around an entity" },
  { name: "importers", group: "common", run: runImporters,
    help: "importers <module-id> [--json] EXHAUSTIVE list of every node that imports the module (edges, not ranked)" },
  { name: "refs", group: "common", run: runRefs,
    help: "refs <symbol-id> [--json]  EXHAUSTIVE callers ∪ importers of a symbol (edges, not ranked)" },
  { name: "impact", group: "common", run: runImpact,
    help: "impact <symbol-id> [--depth N] [--json] Transitive blast radius: change this → these N break" },
  { name: "plan-lanes", group: "coordination", run: runPlanLanes,
    help: "plan-lanes <files...> [--symbols] [--depth N] [--max-hub-degree N] [--json]  Partition a change-set into blast-radius-disjoint parallel lanes" },
  { name: "affected-tests", group: "common", run: runAffectedTests,
    help: "affected-tests <symbol> [--changed a,b] [--trace-only] [--runner vitest] [--json] Minimal tests to run (static graph ∪ runtime traces)" },
  { name: "context", group: "common", run: runContext,
    help: "context <symbol> [--escalate [--budget N]] [--json] Minimal precise slice pack (header + body + 1-hop callees)" },
  { name: "fleet-context", group: "common", run: runFleetContext,
    help: "fleet-context --lanes <file.json|-> Deduped shared+per-lane briefing for a fan-out of agents" },
  { name: "mcp", group: "common", run: runMcp,
    help: "mcp                        Serve the context packer over MCP (stdio JSON-RPC) — stateless, read-only" },
  { name: "proxy", group: "common", run: runProxy,
    help: "proxy [--provider ...] [--compact-history] Transparent LLM-API proxy: graph slices + history compaction" },
  { name: "node", group: "common", run: runNode,
    help: "node body <id> [--body|--file] Update a node's markdown body (LWW CRDT write)" },
  { name: "summarize", group: "common", run: runSummarize,
    help: "summarize [<id>] [--all] [--json] Summarize one node or every node (heuristic; LLM when a model is present)" },
  { name: "view", group: "common", run: runView,
    help: "view                       Open the Astro viewer at http://localhost:7777" },
  { name: "daemon", group: "common", run: runDaemon,
    help: "daemon <start|stop|status> Daemon control" },
  { name: "doctor", group: "common", run: runDoctor,
    help: "doctor [--json]            Check Bun, native binary, and config (--json: the SUITE_CONTRACTS §3 discovery envelope)" },
  { name: "config", group: "common", run: runConfig,
    help: "config [key] [value]       Read/write configuration values" },
  { name: "reindex", group: "common", run: runReindex,
    help: "reindex                    Drop the SQLite index and rebuild from markdown" },
  { name: "branches", group: "common", run: runBranches,
    help: "branches [--json] [--prune] [--keep N]  List per-branch index caches (size/mtime/counts); --prune removes stale ones" },
  { name: "models", group: "common", run: runModels,
    help: "models <list|pull>         List local models or pull one (download + verify)" },
  { name: "claim", group: "coordination", run: runClaim,
    help: 'claim <ids...> --intent "..." [--force]  Register a work claim (409 overlap / 202 adjacent-conflict)' },
  { name: "release", group: "coordination", run: runRelease,
    help: "release <claim_id>         Release a claim" },
  { name: "sync", group: "coordination", run: runSync,
    help: "sync <peer_url> [--peer-project <alias>]  Sync CRDT state with a peer" },
  { name: "traces", group: "coordination", run: runTraces,
    help: "traces <id>                Runtime trace history for an entity" },
  { name: "remember", group: "coordination", run: runRemember,
    help: 'remember "<note>" [--node <id>] [--kind decision|deadend|gotcha|note] [--scope a,b] [--ttl S]  Record a fleet-memory note' },
  { name: "recall", group: "coordination", run: runRecall,
    help: "recall [<term>] [--node <id>] [--kind K] [--json]  Recall fleet memory (or --forget <id>)" },
];

const BY_NAME: ReadonlyMap<string, Command> = new Map(COMMANDS.map((c) => [c.name, c]));

/** Render `hayven help` from the {@link COMMANDS} table so it can never drift. */
function renderHelp(): string {
  const section = (group: CommandGroup): string =>
    COMMANDS.filter((c) => c.group === group)
      .map((c) => `  ${c.help}`)
      .join("\n");
  return `hayven — distributed code intelligence for AI coding agents

Usage:
  hayven <command> [options]

Common commands:
${section("common")}

Coordination:
${section("coordination")}

Flags:
  -h, --help                 Show this help and exit
  -v, --version              Show version and exit

See https://hayvenhurst.dev for more.`;
}

const HELP = renderHelp();

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const rest = a.slice(2);
      const eq = rest.indexOf("=");
      if (eq >= 0) {
        flags[rest.slice(0, eq)] = rest.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        // A following token is this flag's value when it doesn't start with `-`,
        // OR when it's a negative NUMBER (e.g. `--limit -5`). Without the
        // numeric carve-out the parser sees the leading `-` and treats `--limit`
        // as a boolean `true`, silently dropping the value.
        if (next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) {
          flags[rest] = next;
          i++;
        } else {
          flags[rest] = true;
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      const short = a.slice(1);
      // Aggregate `-abc` as three booleans, except when it has a value.
      for (const c of short) flags[c] = true;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags["help"] || parsed.flags["h"]) {
    console.log(HELP);
    return 0;
  }
  if (parsed.flags["version"] || parsed.flags["v"]) {
    console.log(VERSION);
    return 0;
  }

  const [cmd, ...rest] = parsed.positionals;
  if (!cmd || cmd === "help") {
    console.log(HELP);
    return 0;
  }

  const command = BY_NAME.get(cmd);
  if (command) {
    return command.run({ positionals: rest, flags: parsed.flags });
  }

  console.error(`Unknown command: ${cmd}\n`);
  console.error(HELP);
  return 2;
}

// If this module is the entrypoint (it always is via the shebang), invoke main.
if (import.meta.main) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
