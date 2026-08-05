#!/usr/bin/env bun
/**
 * Agent navigation eval: "does Hayvenhurst actually help an agent find code?"
 *
 * WHY THIS EXISTS
 * ---------------
 * A multi-agent dogfood round found hayven's search is a useful identifier
 * LOCATOR but with real gaps: BM25-by-token-frequency buries well-connected
 * implementations under tests/types/interfaces, and a natural-language ask that
 * AND-s English glue words matches nothing at all. Those were narrative
 * observations. This turns the question into a TRACKED METRIC, so every
 * ranking / granularity / recall change is gated on a real score instead of on
 * a remembered impression.
 *
 * It is also the ONLY reproducible source for the α/τ figures quoted in
 * `daemon/src/db/fts.ts`. A tuned constant whose evidence cannot be re-run is a
 * claim, not a measurement; this harness is what keeps that doc block honest.
 *
 * WHAT IT MEASURES
 * ----------------
 * A fixed set of realistic "where is X?" tasks an agent working in THIS repo
 * would ask, each with a known ground-truth target (an entity-id substring).
 * For each task it runs the REAL search path (`searchFts`, the same function
 * the daemon's /api/search calls) and records the 1-based rank of the first hit
 * whose id contains the target. Per cohort:
 *   - top-1 rate:  target is the very first hit (the ideal)
 *   - top-5 rate:  target is in the first 5 (an agent will actually see it)
 *   - MRR:         mean reciprocal rank (1/pos, 0 on miss), the headline number
 *   - miss count:  target not in the top `limit` at all
 *
 * The cohorts and what each one gates:
 *   IMPL        exact-identifier asks. The locator's bread and butter, and the
 *               DO-NO-HARM guard on any ranking change: a re-rank that helps
 *               BROAD by disturbing IMPL has not helped.
 *   BROAD       ambiguous one-word queries. The RANKING gate, and the cohort
 *               the centrality re-rank exists to fix.
 *   UI          the Preact `.tsx` component layer. The standing regression gate
 *               for `.tsx` indexing: this whole surface once scored zero because
 *               the parser never reached the file type.
 *   PATH        targets named by their FOLDER or FILE rather than by any entity
 *               name. The gate for the searchable `path` column in `nodes_fts`.
 *   GRANULARITY inner / nested / arrow helpers below the module-level symbol.
 *   SEMANTIC    natural-language asks. Some are reachable by the model-free
 *               relaxed fallback; the ones marked `[needs model]` are HONEST
 *               expected misses and are labelled as such rather than retargeted
 *               to manufacture a pass.
 *
 * HONEST SCORING
 * --------------
 * Every task counts against its cohort's denominator, always. A target that no
 * longer resolves to any entity in the index is NOT quietly dropped: the
 * pre-flight below reports it by name as `target absent from index`, and it
 * still scores as a miss. Silently skipping a stale target would inflate the
 * headline by removing exactly the tasks that fail, which is the one failure
 * mode a benchmark must not have.
 *
 * SAFE ANYWHERE: with no index it prints how to build one and exits 0. Opens
 * the database READ-ONLY, writes nothing, and needs no running daemon.
 *
 * Usage (from the repo root):
 *   bun bench/agent-nav-eval.ts
 *   bun bench/agent-nav-eval.ts --limit 20 --json
 *   bun bench/agent-nav-eval.ts --repo /path/to/other/repo
 *   bun bench/agent-nav-eval.ts --db /path/to/index.sqlite
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { resolveReadIndex } from "../daemon/src/db/branch_index.ts";
import { searchFts } from "../daemon/src/db/fts.ts";
import { DEFAULT_CONFIG } from "../daemon/src/config/defaults.ts";
import { loadConfig } from "../daemon/src/config/load.ts";
import { hayvenPathsFor } from "../daemon/src/util/paths.ts";

type Category = "impl" | "broad" | "ui" | "granularity" | "semantic" | "path";

interface NavTask {
  /** What an agent is trying to find (for the report). */
  ask: string;
  /** The query an agent would actually type (code tokens, since hayven is FTS). */
  query: string;
  /** Ground truth: the first hit whose id INCLUDES this substring is the target. */
  target: string;
  category: Category;
}

/**
 * Ground-truth tasks. Every target below was verified to resolve to at least one
 * real entity in this repo's index; the pre-flight re-checks that on every run,
 * so a refactor that moves a target surfaces as a loud failure instead of a
 * quiet score drop.
 */
const TASKS: NavTask[] = [
  // ── IMPL: the locator's bread and butter (should be top-5, ideally top-1) ──
  { ask: "the conflict oracle selection seam", query: "selectOracle", target: "conflict/oracle/selectOracle", category: "impl" },
  { ask: "the heuristic conflict oracle", query: "HeuristicOracle", target: "conflict/oracle/HeuristicOracle", category: "impl" },
  { ask: "the FTS search implementation", query: "searchFts", target: "db/fts/searchFts", category: "impl" },
  { ask: "the deterministic contract-diff oracle", query: "ContractDiffOracle", target: "conflict/contract_diff_oracle/ContractDiffOracle", category: "impl" },
  { ask: "graph pan/zoom interaction", query: "attachPanZoom", target: "graph/interact/attachPanZoom", category: "impl" },
  { ask: "graph node tier/LOD application", query: "applyTier", target: "graph/render/applyTier", category: "impl" },
  { ask: "the neighbors graph walk", query: "walkNeighbors", target: "walkNeighbors", category: "impl" },
  { ask: "the default config", query: "DEFAULT_CONFIG", target: "config/defaults", category: "impl" },
  { ask: "the contract/internal edit classifier", query: "isContractEdit", target: "contract_diff_oracle/isContractEdit", category: "impl" },
  { ask: "the hand-rolled query hook", query: "useQuery", target: "useQuery", category: "impl" },
  { ask: "trace runtime-name to entity resolution", query: "TraceNameResolver", target: "traceResolve", category: "impl" },
  { ask: "the CRDT LWW register", query: "LwwRegister", target: "lww", category: "impl" },
  { ask: "the model-free query expansion floor", query: "expandQuery", target: "queryExpansion", category: "impl" },

  // ── BROAD: ambiguous one-word queries, the RANKING gate. The right impl
  //    should surface in the top-5 among many token matches (tests/types/etc).
  //    This is where BM25-by-frequency buries implementations (the dogfound
  //    "selectOracle at #20" symptom); the centrality re-rank should lift it. ──
  { ask: "oracle (broad), want the selection seam or main oracle", query: "oracle", target: "conflict/oracle", category: "broad" },
  { ask: "search (broad), want the FTS impl", query: "search", target: "db/fts", category: "broad" },
  { ask: "conflict (broad), want a conflict-defense impl", query: "conflict", target: "conflict/", category: "broad" },
  { ask: "neighbors (broad), want the graph walk", query: "neighbors", target: "walkNeighbors", category: "broad" },
  { ask: "merkle (broad), want the merkle tree impl", query: "merkle", target: "crdt/merkle", category: "broad" },
  { ask: "watcher (broad), want the native watcher supervisor", query: "watcher", target: "watcher", category: "broad" },

  // ── UI: the Preact component + graph-interaction layer. Before `.tsx` indexing
  //    landed, the ENTIRE `viewer/src/components/*.tsx` surface was invisible
  //    (`.tsx` entities = 0) and every one of these MISSED. They are the standing
  //    regression gate for that fix: if the parser stops reaching `.tsx` again,
  //    this cohort collapses. Mix of top-level components, the hand-rolled hook,
  //    inner-arrow component helpers, and plain `.ts` graph modules. ──
  { ask: "the graph view component (Preact .tsx)", query: "GraphView", target: "components/GraphView", category: "ui" },
  { ask: "the node-detail shell component", query: "NodeShell", target: "components/NodeShell", category: "ui" },
  { ask: "the search box component", query: "SearchBox", target: "components/SearchBox", category: "ui" },
  { ask: "the search-results list component", query: "SearchResults", target: "components/SearchResults", category: "ui" },
  { ask: "the search-box submit handler (nested fn in a .tsx component)", query: "onSubmit", target: "components/SearchBox/onSubmit", category: "ui" },
  { ask: "the useQuery fetch runner (inner fn in the hand-rolled hook)", query: "runFetch", target: "components/useQuery/runFetch", category: "ui" },
  { ask: "the search-result id splitter (inner arrow in SearchResults .tsx)", query: "splitId", target: "components/SearchResults/splitId", category: "ui" },
  { ask: "the graph degradation gate (when to drop to a coarser render)", query: "shouldDegrade", target: "graph/degradation/shouldDegrade", category: "ui" },

  // ── GRANULARITY: inner / arrow helpers below the module-level symbol. This
  //    cohort was authored as a known-ZERO gap when the parser indexed no `.tsx`
  //    at all; both targets live in `SearchResults.tsx`, so they now depend on
  //    the same `.tsx` path the UI cohort gates. Kept separate because what they
  //    measure is different: UI asks "is the FILE reachable", these ask "is a
  //    symbol NESTED inside a component reachable". ──
  { ask: "the search-result query highlighter (inner arrow fn)", query: "highlight", target: "SearchResults/highlight", category: "granularity" },
  { ask: "the readable-error mapper (inner fn in SearchResults)", query: "readableError", target: "readableError", category: "granularity" },

  // ── SEMANTIC: natural-language asks (full sentences, English glue words).
  //    These have NO usable hit on the precise AND-of-all-words path: every word
  //    is AND-ed, and the stopwords ("how"/"does"/"the"/"after"/"a") never appear
  //    in code, so the AND matches nothing. The model-free RELAXED fallback in
  //    `searchFts` (drop stopwords, OR the remaining CONTENT words, same ranking)
  //    gives them honest recall when, and ONLY when, the user's words share a
  //    literal token with the target identifier.
  //
  //    Two sub-cohorts, kept HONEST:
  //      • REACHABLE: token overlap exists, so the deterministic floor genuinely
  //        surfaces these.
  //      • NEEDS-MODEL: no token overlap, so the floor CANNOT reach them. They
  //        stay as labelled expected misses until the dormant `searchFtsSemantic`
  //        path is wired. Do NOT retarget them or overfit the abbreviation table
  //        to force a pass; that converts a known gap into a hidden one.
  { ask: "how does the daemon converge two peers after a partition?", query: "how does the daemon converge peers after a partition", target: "convergence", category: "semantic" },
  { ask: "where do we expand the search query?", query: "where do we expand the search query", target: "queryExpansion", category: "semantic" },
  { ask: "how does query expansion work?", query: "how does query expansion work", target: "queryExpansion", category: "semantic" },
  { ask: "how do we walk the graph to find neighbor nodes?", query: "how do we walk the graph to find neighbor nodes", target: "walkNeighbors", category: "semantic" },
  { ask: "how does the full text search work?", query: "how does the full text search work", target: "db/fts", category: "semantic" },
  { ask: "what stops two agents editing the same function at once? [needs model]", query: "what stops two agents editing the same function", target: "conflict", category: "semantic" },

  // ── PATH: the path-searchable-FTS gate. ROOT CAUSE it guards: `nodes_fts` once
  //    indexed only name/qualified_name/summary, so a query naming a FOLDER or
  //    FILE, the strongest locating signal an agent has, matched NOTHING unless
  //    some entity happened to be literally named that. Dogfound on a foreign
  //    repo: "schema" missed every `db/schema/*` table (named `auth`/`projects`/…)
  //    and found only an admin route NAMED `schema`. The fix adds a normalized,
  //    tokenized `path` column so folder/file segments are matchable. Each target
  //    below has its search term in the containing FILE or FOLDER and NOT in the
  //    entity name, so they flip back to misses if `path` stops being indexed. ──
  { ask: "the db query helpers (folder/file term, not an entity name)", query: "queries", target: "db/queries/", category: "path" },
  { ask: "the schema migration types (file term, not an entity name)", query: "migrations", target: "db/migrations/", category: "path" },
  { ask: "the model registry artifacts (file term, not an entity name)", query: "registry", target: "models/registry/", category: "path" },
  { ask: "the index freshness internals (file term, not an entity name)", query: "freshness", target: "db/freshness/", category: "path" },
];

interface Scored {
  task: NavTask;
  /** 1-based rank of the target; 0 = miss. */
  pos: number;
  topHit: string | null;
  /** True when NO entity in the index matches the target substring at all. */
  targetAbsent: boolean;
}

/**
 * Does any indexed entity id contain this target substring?
 *
 * This is the honesty check. A target that has been refactored away scores as a
 * miss either way, but without this we could not TELL a ranking regression
 * ("the entity is there, search just buried it") from a stale benchmark ("the
 * entity is gone, the task is meaningless"). The two demand opposite responses,
 * so the report names them differently.
 *
 * Returns `true` (assume present) when there is no `nodes` table to check
 * against. An FTS-only database can still be scored, it just cannot be audited.
 * Assuming presence is the correct direction to fail: it suppresses only the
 * audit note, and never changes a score. Assuming ABSENCE would stamp every task
 * "stale" on a database we simply could not inspect.
 *
 * The audit MUST use the same matching rule as the scoring. `scoreTask` decides
 * a hit with `String.includes`: literal, case-SENSITIVE, no wildcards. So this
 * uses `instr`, which is exactly that, and deliberately NOT `LIKE`. `LIKE` is
 * strictly more permissive on both axes: it is ASCII case-insensitive, and it
 * treats `_` as a single-character wildcard, which matters because these ids are
 * full of underscores (`contract_diff_oracle`, `pack_neighbors`). A more
 * permissive audit is the dangerous direction: it would certify a target as
 * present that the scorer cannot actually match, so the task would count as a
 * miss with no "stale" flag, and a benchmark bug would read as a ranking
 * regression. `instr` keeps the two predicates provably identical.
 */
function targetExists(db: Database, target: string): boolean {
  try {
    const row = db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM nodes WHERE instr(id, ?) > 0",
      )
      .get(target);
    return (row?.c ?? 0) > 0;
  } catch {
    return true;
  }
}

function scoreTask(db: Database, t: NavTask, limit: number): Scored {
  const hits = searchFts(db, t.query, limit);
  let pos = 0;
  for (let i = 0; i < hits.length; i++) {
    if (hits[i]!.id.includes(t.target)) {
      pos = i + 1;
      break;
    }
  }
  return { task: t, pos, topHit: hits[0]?.id ?? null, targetAbsent: !targetExists(db, t.target) };
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : ((n / d) * 100).toFixed(0) + "%";
}

interface CohortStats {
  n: number;
  top1: number;
  top5: number;
  found: number;
  misses: number;
  mrr: number;
}

function cohortStats(rows: Scored[]): CohortStats {
  const found = rows.filter((r) => r.pos > 0).length;
  return {
    n: rows.length,
    top1: rows.filter((r) => r.pos === 1).length,
    top5: rows.filter((r) => r.pos > 0 && r.pos <= 5).length,
    found,
    misses: rows.length - found,
    mrr: rows.reduce((s, r) => s + (r.pos > 0 ? 1 / r.pos : 0), 0) / (rows.length || 1),
  };
}

interface Args {
  db: string | null;
  repo: string;
  limit: number;
  json: boolean;
  help: boolean;
}

/** Thrown for a malformed command line. Caught in `main` and turned into a
 *  one-line message plus a NON-zero exit. */
class UsageError extends Error {}

/**
 * The value following `--flag`, or a UsageError.
 *
 * A missing or flag-shaped value must be LOUD, not silently absorbed. Absorbing
 * it is uniquely nasty here because of how this bench fails soft: a swallowed
 * value (`--db --json`) would leave `db` set to the literal `"--json"`, which
 * does not exist, which lands on the "no index, exit 0" path, so a typo would
 * print a reassuring message, exit green, and measure absolutely nothing. In CI
 * that is indistinguishable from a legitimate fresh clone. Fail instead.
 */
function valueFor(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith("--")) {
    throw new UsageError(`${flag} needs a value`);
  }
  return v;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { db: null, repo: join(import.meta.dir, ".."), limit: 20, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") a.db = valueFor(argv, ++i, "--db");
    else if (arg === "--repo") a.repo = valueFor(argv, ++i, "--repo");
    else if (arg === "--limit") {
      const raw = valueFor(argv, ++i, "--limit");
      const n = Number(raw);
      // Explicit integer check rather than `Number(x) || fallback`: the `||`
      // shape treats a deliberate `--limit 0` as "absent" and silently swaps in
      // the default, which is a confusing lie about what was measured.
      if (!Number.isInteger(n) || n < 1) {
        throw new UsageError(`--limit needs a positive integer, got "${raw}"`);
      }
      a.limit = n;
    } else if (arg === "--json") a.json = true;
    else if (arg === "--help" || arg === "-h") a.help = true;
    else throw new UsageError(`unknown argument "${arg}"`);
  }
  return a;
}

/**
 * Where the index actually lives.
 *
 * NOT simply `<repo>/.hayven/index.sqlite`. Under branch-aware indexing the real
 * database is `<repo>/.hayven/branches/<key>/index.sqlite`, and the legacy file
 * at the top level still exists but holds no nodes. Reading it directly is the
 * classic trap: every query returns zero rows and the harness cheerfully reports
 * a perfect zero score. We reuse the daemon's own `resolveReadIndex`, so the
 * bench opens exactly the database the CLI would.
 */
function resolveIndexPath(args: Args): string {
  if (args.db !== null) return args.db;
  const paths = hayvenPathsFor(args.repo);
  // `loadConfig` THROWS on a malformed config file, an out-of-range value, a bad
  // HAYVEN_PORT/HAYVEN_HOST, or a relative HAYVEN_HOME. None of that should be
  // able to crash a read-only benchmark before it has even decided whether an
  // index exists. That would turn the "safe anywhere" exit-0 path into an
  // exit-1 stack trace on machines whose global config happens to be broken.
  // A config we cannot read only affects WHICH index we would open, so fall back
  // to the defaults and let the existence check downstream have the final say.
  let config = DEFAULT_CONFIG;
  try {
    config = loadConfig(args.repo).config;
  } catch {
    config = DEFAULT_CONFIG;
  }
  return resolveReadIndex(paths, config).path;
}

const USAGE =
  "bench/agent-nav-eval.ts: does hayven help an agent find code?\n" +
  "  --repo <path>  repo whose index to read (default: this repo)\n" +
  "  --db <path>    explicit index.sqlite, bypassing branch resolution\n" +
  "  --limit N      hits per query (default 20)\n" +
  "  --json         machine-readable summary";

function main(): number {
  let args: Args;
  try {
    args = parseArgs(Bun.argv.slice(2));
  } catch (err) {
    // A bad command line is the ONE thing this bench exits non-zero for. Every
    // other failure mode (no index, no config, no graph) is a legitimate state
    // that must stay green; a typo is not.
    if (!(err instanceof UsageError)) throw err;
    console.error(`agent-nav-eval: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const dbPath = resolveIndexPath(args);
  // SAFE ANYWHERE: no index is a normal state (a fresh clone), not a failure.
  // Explain the one command that fixes it and exit 0 so this never breaks CI.
  if (!existsSync(dbPath)) {
    console.log(
      `no index at ${dbPath}\n` +
        `Build one from the repo root:  bun daemon/src/cli.ts init\n` +
        `then re-run:                   bun bench/agent-nav-eval.ts`,
    );
    return 0;
  }

  const db = new Database(dbPath, { readonly: true });
  const results = TASKS.map((t) => scoreTask(db, t, args.limit));
  db.close();

  console.log(`agent-nav-eval: real search path (searchFts), limit ${args.limit}`);
  console.log(`index: ${dbPath}\n`);

  const fmtRow = (r: Scored) =>
    `  [${r.pos > 0 ? "#" + String(r.pos).padStart(2) : " x "}] ${r.task.query.slice(0, 46).padEnd(46)} -> ${r.task.target}` +
    (r.targetAbsent
      ? "   (TARGET ABSENT FROM INDEX, task is stale, scored as a miss)"
      : r.pos === 0
        ? `   (top hit: ${r.topHit ?? "none"})`
        : "");

  const byCat = (c: Category) => results.filter((r) => r.task.category === c);
  const stats: Record<Category, CohortStats> = {
    impl: cohortStats(byCat("impl")),
    broad: cohortStats(byCat("broad")),
    ui: cohortStats(byCat("ui")),
    path: cohortStats(byCat("path")),
    granularity: cohortStats(byCat("granularity")),
    semantic: cohortStats(byCat("semantic")),
  };

  const section = (cat: Category, title: string, extra = "") => {
    const rows = byCat(cat);
    const s = stats[cat];
    console.log(`${title}:`);
    for (const r of rows) console.log(fmtRow(r));
    console.log(
      `\n  ${cat.toUpperCase()} headline:  top-1 ${s.top1}/${s.n} (${pct(s.top1, s.n)})  ` +
        `top-5 ${s.top5}/${s.n} (${pct(s.top5, s.n)})  ` +
        `MRR ${s.mrr.toFixed(3)}  misses ${s.misses}${extra}\n`,
    );
  };

  section("impl", "IMPL tasks (exact identifiers, the do-no-harm guard)");
  section("broad", "BROAD tasks (one-word queries, the RANKING gate)");
  section("ui", "UI tasks (Preact .tsx + graph layer, the .tsx-indexing gate)");
  section("path", "PATH tasks (folder/file-named targets, the path-column gate)");
  section("granularity", "GRANULARITY tasks (symbols nested inside a component)");

  const semRows = byCat("semantic");
  const semNeedsModel = semRows.filter((r) => /\[needs model\]/i.test(r.task.ask)).length;
  section(
    "semantic",
    "SEMANTIC tasks (natural language, the relaxed-fallback gate)",
    semNeedsModel > 0
      ? `\n  (model-free; ${semNeedsModel} of ${semRows.length} need the semantic model, expected miss)`
      : "",
  );

  // A stale task is a benchmark bug, not a ranking result. Call it out loudly and
  // separately so nobody reads a depressed headline as a search regression.
  const stale = results.filter((r) => r.targetAbsent);
  if (stale.length > 0) {
    console.log(`!! ${stale.length} task(s) target an entity that is NOT in this index (scored as misses):`);
    for (const r of stale) console.log(`   ${r.task.target}   (query "${r.task.query}")`);
    console.log("   Update or remove these tasks. The cohort scores above are understated until you do.\n");
  }

  console.log(
    `=== BASELINE: IMPL MRR ${stats.impl.mrr.toFixed(3)} (top-5 ${stats.impl.top5}/${stats.impl.n}) ` +
      `| BROAD MRR ${stats.broad.mrr.toFixed(3)} (top-5 ${stats.broad.top5}/${stats.broad.n}) ` +
      `| UI MRR ${stats.ui.mrr.toFixed(3)} (top-5 ${stats.ui.top5}/${stats.ui.n}) ` +
      `| PATH ${stats.path.found}/${stats.path.n} ` +
      `| granularity ${stats.granularity.found}/${stats.granularity.n} ` +
      `| semantic ${stats.semantic.found}/${stats.semantic.n} (${semNeedsModel} need model) ===`,
  );

  if (args.json) {
    console.log(
      JSON.stringify({
        index: dbPath,
        limit: args.limit,
        cohorts: Object.fromEntries(
          Object.entries(stats).map(([k, s]) => [
            k,
            { n: s.n, top1: s.top1, top5: s.top5, found: s.found, misses: s.misses, mrr: Number(s.mrr.toFixed(4)) },
          ]),
        ),
        semanticNeedsModel: semNeedsModel,
        staleTargets: stale.map((r) => r.task.target),
        rows: results.map((r) => ({
          q: r.task.query,
          target: r.task.target,
          cat: r.task.category,
          pos: r.pos,
          targetAbsent: r.targetAbsent,
        })),
      }),
    );
  }
  return 0;
}

process.exit(main());
