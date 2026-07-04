/**
 * `hayven affected-tests <symbol> [--changed a,b,c] [--json] [--trace-only]
 * [--limit N] [--depth N] [--runner vitest|bun]` — the MINIMAL ranked set of
 * tests to run for a change (ROADMAP "trace-augmented test-impact selection").
 *
 * Wraps the pure query in `../db/affected_tests.ts`, which reverse-walks the
 * UNION of the STATIC impact graph and the RUNTIME trace-coverage graph from the
 * changed symbol (or the entities defined in a set of changed files) and returns
 * the reached TESTS, ranked trace-first. The CLI is a thin presenter mirroring
 * `impact.ts`: `requireProject` → readonly `openProjectDb` → `warnIfStale` →
 * `--json` vs markdown split → `finally db.close()`.
 *
 * ENTRY POINTS (the query has two, this command exposes both):
 *   - a SYMBOL positional → {@link affectedTests} (reverse-walk from that symbol);
 *   - `--changed a,b,c` (a comma-separated changed-file list) →
 *     {@link affectedTestsForFiles} (reverse-walk from every entity in those
 *     files). When BOTH are given, `--changed` WINS — it is the file-oriented
 *     entry point a `git diff` naturally produces, so we prefer it.
 *
 * `test.patterns` from config (OPTIONAL; may not exist yet) is forwarded to the
 * query's test detection when present — accessed defensively so the command
 * works before the integrator wires the config field into defaults.
 */
import type { ParsedArgs } from "../cli.ts";
import {
  affectedTests,
  affectedTestsForFiles,
  type AffectedTest,
  type AffectedTestsOpts,
  type AffectedTestsResult,
} from "../db/affected_tests.ts";
import { warnIfStale } from "../db/freshness.ts";
import { prioritize, type PrioritizableTest } from "../db/test_prioritization.ts";
import { isJson, openProjectDb, requireProject } from "./_shared.ts";

/**
 * Config carrying an OPTIONAL `test.patterns` list. The integrator adds the
 * `test` field to `HayvenConfig` in defaults.ts later; until then we narrow to
 * this shape so reading `config.test?.patterns` type-checks without us touching
 * defaults.ts. Optional-chained at the call site so an absent field is fine.
 */
interface ConfigWithTestPatterns {
  test?: { patterns?: readonly string[] };
}

/**
 * Read `--limit N` / `--depth N`-style numeric flags. A boolean-true flag (no
 * value) or a NaN value is ignored (returns undefined), mirroring impact.ts's
 * NaN guard so a bare `--limit` doesn't blow up the query.
 */
function numericFlag(value: string | boolean | undefined): number | undefined {
  if (value === undefined || value === true) return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

/** Boolean flag truthiness, matching the rest of the CLI (`=== true || "true"`). */
function boolFlag(value: string | boolean | undefined): boolean {
  return value === true || value === "true";
}

/**
 * Runners `--runner` can emit ready-to-paste invocation args for: vitest (the
 * TS bench gap — bench/affected-tests-typescript-RESULTS.md §5 item 5) and bun
 * (Bun's NATIVE `bun test` runner — the Lydgr dogfooding gap: its whole suite
 * runs under `bun test`, so a vitest-only handoff was unreachable there).
 * pytest already gets node ids via `runnable`, and go/cargo runnables carry
 * their own `-run` shape.
 */
const EMIT_RUNNERS = ["vitest", "bun"] as const;
type EmitRunner = (typeof EMIT_RUNNERS)[number];

/**
 * Quote one shell arg for the ready-to-paste command line. Paths that are plain
 * (letters/digits/`_-./:@`) pass through verbatim; anything else — spaces,
 * vitest dynamic-route brackets (`[id].test.ts`), glob chars — is single-quoted
 * with the POSIX `'\''` escape so the pasted line survives a real shell.
 */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_\-./:@]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The runner invocation args for an affected set: `["run", ...specFiles]` for
 * vitest, `["test", ...specFiles]` for bun (`bun test <paths…>`).
 *
 * FILE granularity is BOTH runners' own selection granularity (their
 * positional CLI filters are substring-matched against test-file PATHS; there
 * is no per-test node-id form — vitest's `-t` / bun's `--test-name-pattern`
 * filter by test NAME, which our file-level runnables don't carry). We
 * therefore emit each affected spec file's FULL repo-relative path — full
 * paths are unique within the repo, which defuses the substring gotcha
 * (`router.test.ts` alone would match all five of hono's routers;
 * `src/router/reg-exp-router/router.test.ts` matches one). Residual substring
 * over-match (one repo path a suffix of another) errs toward running MORE,
 * never missing.
 *
 * Only `runner === "vitest"` tests with a non-null runnable contribute — FOR
 * BOTH emitters. Graph-side, a TS/JS spec file is classified `"vitest"` by
 * repo convention (db/test_nodes.ts — a bun:test spec is statically
 * indistinguishable from a vitest one; both are plain `*.test.ts` files), so
 * `--runner bun` is the USER's declaration of which runner actually executes
 * that same file-selected set. `skipped` counts the affected tests that did
 * NOT contribute (other runners / no runnable) so the presenter can say so
 * honestly. Files are deduped (many test nodes share one spec file)
 * preserving the ranked order, so a truncating `--limit`'s head-of-list
 * semantics carry through to the command line.
 */
function runnerInvocationArgs(
  runner: EmitRunner,
  tests: readonly AffectedTest[],
): { args: string[]; skipped: number } {
  const subcommand = runner === "vitest" ? "run" : "test";
  const files: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const t of tests) {
    if (t.runner !== "vitest" || t.runnable === null) {
      skipped++;
      continue;
    }
    if (!seen.has(t.runnable)) {
      seen.add(t.runnable);
      files.push(t.runnable);
    }
  }
  return { args: files.length > 0 ? [subcommand, ...files] : [], skipped };
}

export async function runAffectedTests(args: ParsedArgs): Promise<number> {
  const symbol = args.positionals[0];
  // `--changed` is the comma-separated changed-file list (the file entry point).
  const changedRaw = args.flags["changed"];
  const changedFiles =
    typeof changedRaw === "string"
      ? changedRaw
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f.length > 0)
      : [];
  const hasChanged = changedFiles.length > 0;

  // `--runner vitest|bun`: emit ready-to-paste runner invocation args for the
  // affected set. Validated BEFORE any work so a typo fails fast. NB the
  // hand-rolled parser (cli.ts parseArgs) consumes the token AFTER a value-flag
  // as its value — `--runner vitest` parses as intended, but a BARE `--runner`
  // at the end of the line arrives as boolean `true` (missing value), and
  // `--runner <symbol>` would eat the symbol; put the symbol FIRST (the same
  // documented discipline as `impact --preview`).
  const runnerRaw = args.flags["runner"];
  let emitRunner: EmitRunner | undefined;
  if (runnerRaw !== undefined) {
    if (typeof runnerRaw !== "string" || runnerRaw.length === 0) {
      process.stderr.write(
        `error: --runner requires a value (supported: ${EMIT_RUNNERS.join(", ")}), ` +
          "e.g. `hayven affected-tests <symbol> --runner vitest`\n",
      );
      return 2;
    }
    if (!(EMIT_RUNNERS as readonly string[]).includes(runnerRaw)) {
      process.stderr.write(
        `error: unsupported --runner \`${runnerRaw}\` (supported: ${EMIT_RUNNERS.join(", ")})\n`,
      );
      return 2;
    }
    emitRunner = runnerRaw as EmitRunner;
  }

  if (!symbol && !hasChanged) {
    process.stderr.write(
      "usage: hayven affected-tests <symbol> [--changed a,b,c] [--json] " +
        "[--trace-only] [--order] [--limit N] [--depth N] [--runner vitest|bun]\n" +
        "  (when both a symbol and --changed are given, --changed wins; " +
        "--order = fail-fast APFD ordering; --runner vitest|bun = print a " +
        "ready-to-paste runner command for the affected set)\n",
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

  const opts: AffectedTestsOpts = {};
  if (boolFlag(args.flags["trace-only"])) {
    opts.traceOnly = true;
    // Safety by default: a minimal selector must never return ZERO tests for a
    // changed symbol. When the symbol has no per-test coverage, fall back to its
    // reachable safety set. `--strict-observed` opts out (e.g. to SURFACE symbols
    // with no coverage — an empty result then means "no observed coverage here").
    if (!boolFlag(args.flags["strict-observed"])) opts.fallbackReachableWhenEmpty = true;
  }
  const limit = numericFlag(args.flags["limit"]);
  if (limit !== undefined) opts.limit = limit;
  const depth = numericFlag(args.flags["depth"]);
  if (depth !== undefined) opts.maxDepth = depth;
  // OPTIONAL config field — may not exist yet; access defensively. Only set
  // opts.patterns when actually present so the query keeps its own default.
  const patterns = (ctx.config as ConfigWithTestPatterns).test?.patterns;
  if (patterns !== undefined) opts.patterns = patterns;

  const db = openProjectDb(ctx, { readonly: true });
  try {
    warnIfStale(db, ctx.paths);

    // `--changed` wins when both are given (the file-oriented entry point).
    const result: AffectedTestsResult = hasChanged
      ? affectedTestsForFiles(db, changedFiles, opts)
      : affectedTests(db, symbol as string, opts);

    // Symbol not found (only meaningful on the single-symbol path): mirror
    // impact.ts's not-found exit so the agent gets a fuzzy-find nudge.
    if (
      !hasChanged &&
      result.note === "symbol not found" &&
      result.roots.length === 0
    ) {
      process.stderr.write(
        `No node with id \`${symbol}\` — try \`hayven query ${symbol}\` to fuzzy-find it.\n`,
      );
      return 1;
    }

    // `--order` re-sorts the selected tests for EARLIEST fault detection (APFD):
    // trace tests first, then closest/heaviest/recently-failed. Default order is
    // the query's relevance ranking; --order optimizes for fail-fast feedback.
    if (boolFlag(args.flags["order"])) {
      const ranked = prioritize(result.tests as PrioritizableTest[]);
      const byId = new Map(result.tests.map((t) => [t.id, t]));
      result.tests = ranked.map((r) => byId.get(r.id)!).filter(Boolean);
    }

    const label = hasChanged
      ? `${changedFiles.length} file(s)`
      : (symbol as string);

    if (isJson(args.flags)) {
      const payload: Record<string, unknown> = hasChanged
        ? { changed: changedFiles }
        : { symbol };
      payload.roots = result.roots;
      payload.count = result.tests.length;
      payload.precise = result.precise ?? false;
      payload.observedCount = result.tests.filter((t) => t.confidence === "observed").length;
      // ADDITIVE: the dispatch-only differentiator + hub honesty. Per-test
      // `dispatchOnly`/`staticReachable` ride along on each `tests[]` entry.
      payload.dispatchOnlyCount = result.dispatchOnlyCount;
      payload.hub = result.hub;
      payload.blastRadiusFraction = result.blastRadiusFraction;
      payload.traceEdgeCount = result.traceEdgeCount;
      payload.note = result.note;
      // STRICTLY ADDITIVE `--runner` block: absent the flag, the payload is
      // byte-identical to before the feature existed. With it, three keys ride
      // along: the runner name, its argv tail, and the pasteable command line
      // (null when the affected set has no such runnable — an empty command
      // would mean "run the whole suite", the opposite of a selector).
      if (emitRunner !== undefined) {
        const { args: runnerArgs, skipped } = runnerInvocationArgs(emitRunner, result.tests);
        payload.runner = emitRunner;
        payload.runnerArgs = runnerArgs;
        payload.runnerCommand =
          runnerArgs.length > 0
            ? [emitRunner, ...runnerArgs.map(shellQuote)].join(" ")
            : null;
        payload.runnerSkippedCount = skipped;
      }
      payload.tests = result.tests;
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      return 0;
    }

    // `--runner` without `--json`: stdout is EXACTLY the ready-to-paste command
    // (pipeable — `$(hayven affected-tests X --runner vitest)` runs it); every
    // note stays on stderr, mirroring the markdown path's clean-stdout rule.
    if (emitRunner !== undefined) {
      if (result.note !== undefined) process.stderr.write(`note: ${result.note}\n`);
      if (result.hub) {
        const pct = (result.blastRadiusFraction * 100).toFixed(0);
        process.stderr.write(
          `note: this symbol is a hub; its blast radius is ~${pct}% of the suite\n`,
        );
      }
      const { args: runnerArgs, skipped } = runnerInvocationArgs(emitRunner, result.tests);
      if (skipped > 0) {
        process.stderr.write(
          `note: ${skipped} affected test(s) not in the ${emitRunner} command ` +
            "(other runner or no runnable) — run those separately\n",
        );
      }
      if (runnerArgs.length === 0) {
        // NOTHING to stdout: an empty `vitest run` would run the ENTIRE suite,
        // silently inverting the selection. Say why on stderr instead.
        process.stderr.write(
          `note: no ${emitRunner}-runnable tests in the affected set ` +
            `(${result.tests.length} test(s) total) — nothing to emit\n`,
        );
        return 0;
      }
      process.stdout.write(
        [emitRunner, ...runnerArgs.map(shellQuote)].join(" ") + "\n",
      );
      return 0;
    }

    // markdown. The cold/degrade note + the hub note go to STDERR so stdout stays
    // a clean, pipe-able run list.
    if (result.note !== undefined) {
      process.stderr.write(`note: ${result.note}\n`);
    }
    if (result.hub) {
      const pct = (result.blastRadiusFraction * 100).toFixed(0);
      process.stderr.write(
        `note: this symbol is a hub; its blast radius is ~${pct}% of the suite ` +
          `(${result.tests.length} test(s)) — this map degrades toward "run almost everything"\n`,
      );
    }

    const observed = result.tests.filter((t) => t.confidence === "observed").length;
    const traceCount = result.tests.filter((t) => t.evidence === "trace").length;
    const staticCount = result.tests.length - traceCount;
    const dispatchOnly = result.dispatchOnlyCount;
    // LEAD with the dispatch-only count when > 0 — the whole differentiated value
    // is surfacing tests reached ONLY via runtime dispatch (a grep/static search
    // would miss them). Otherwise fall back to the precise tier split / evidence
    // split as before.
    const baseSummary = result.precise
      ? `${result.tests.length} test(s) — ${observed} observed (run these first), ` +
        `${result.tests.length - observed} reachable (safety net)`
      : `${result.tests.length} test(s) to run — ${traceCount} trace, ${staticCount} static`;
    const summary = dispatchOnly > 0
      ? `${result.tests.length} test(s) — ${dispatchOnly} reach the change ONLY via ` +
        `runtime dispatch (a grep/static search would miss these). ${baseSummary}`
      : baseSummary;
    const lines = [
      `# Affected tests for \`${label}\``,
      "",
      summary,
      "",
    ];
    if (result.tests.length === 0) {
      lines.push(
        `- (none — nothing reaches this symbol${
          result.traceEdgeCount === 0 ? "; no traces yet, static-only" : ""
        })`,
      );
    } else {
      // GROUP the run list so the most useful run first: dispatch-only (the
      // grep/static-would-miss differentiator), then observed, then the reachable
      // safety net. Within each group the query's stable rank order is preserved.
      const precise = result.precise ?? false;
      const dispatchOnlyTests = result.tests.filter((t) => t.dispatchOnly);
      const rest = result.tests.filter((t) => !t.dispatchOnly);
      const observedTests = rest.filter((t) => t.confidence === "observed");
      const reachableTests = rest.filter((t) => t.confidence !== "observed");

      const pushGroup = (heading: string, group: AffectedTest[]): void => {
        if (group.length === 0) return;
        lines.push(`## ${heading}`);
        for (const t of group) lines.push(formatTestLine(t, precise));
        lines.push("");
      };

      pushGroup("dispatch-only (grep/static would miss)", dispatchOnlyTests);
      // In precise mode split the remainder by tier; otherwise it's one list (the
      // fallback path has no observed tier — all `reachable`).
      if (precise) {
        pushGroup("observed (per-test coverage proves it ran the change)", observedTests);
        pushGroup("reachable (safety net)", reachableTests);
      } else {
        pushGroup("reachable", rest);
      }
      // Drop the trailing blank line for a tidy tail.
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

/** One markdown run-list line. In precise mode the lead tag is the confidence
 *  tier (`observed`/`reachable`); otherwise the evidence (`trace`/`static`). A
 *  `dispatch-only` test gets an extra `!dispatch-only` tag so a reader can see
 *  which lines are the grep/static-would-miss differentiator even within a group. */
function formatTestLine(t: AffectedTest, precise: boolean): string {
  const run = t.runnable ?? "(no runnable)";
  const tier = precise ? t.confidence : t.evidence;
  const tag = t.dispatchOnly ? `${tier}, dispatch-only` : tier;
  return `- [${tag}] \`${t.id}\`  (depth ${t.depth}, run: ${run})`;
}
