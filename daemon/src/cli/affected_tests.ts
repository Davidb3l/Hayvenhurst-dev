/**
 * `hayven affected-tests <symbol> [--changed a,b,c] [--json] [--trace-only]
 * [--limit N] [--depth N]` — the MINIMAL ranked set of tests to run for a change
 * (ROADMAP "trace-augmented test-impact selection").
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

  if (!symbol && !hasChanged) {
    process.stderr.write(
      "usage: hayven affected-tests <symbol> [--changed a,b,c] [--json] " +
        "[--trace-only] [--order] [--limit N] [--depth N]\n" +
        "  (when both a symbol and --changed are given, --changed wins; " +
        "--order = fail-fast APFD ordering)\n",
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
  if (boolFlag(args.flags["trace-only"])) opts.traceOnly = true;
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
      payload.traceEdgeCount = result.traceEdgeCount;
      payload.note = result.note;
      payload.tests = result.tests;
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      return 0;
    }

    // markdown. The cold/degrade note goes to STDERR so stdout stays a clean,
    // pipe-able run list.
    if (result.note !== undefined) {
      process.stderr.write(`note: ${result.note}\n`);
    }

    const observed = result.tests.filter((t) => t.confidence === "observed").length;
    const traceCount = result.tests.filter((t) => t.evidence === "trace").length;
    const staticCount = result.tests.length - traceCount;
    // In precise mode lead with the observed/reachable tier split (the headline:
    // the `observed` set is the high-precision minimal run); otherwise the
    // trace/static evidence split as before.
    const summary = result.precise
      ? `${result.tests.length} test(s) — ${observed} observed (run these first), ` +
        `${result.tests.length - observed} reachable (safety net)`
      : `${result.tests.length} test(s) to run — ${traceCount} trace, ${staticCount} static`;
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
      for (const t of result.tests) {
        lines.push(formatTestLine(t, result.precise ?? false));
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

/** One markdown run-list line. In precise mode the lead tag is the confidence
 *  tier (`observed`/`reachable`); otherwise the evidence (`trace`/`static`). */
function formatTestLine(t: AffectedTest, precise: boolean): string {
  const run = t.runnable ?? "(no runnable)";
  const tag = precise ? t.confidence : t.evidence;
  return `- [${tag}] \`${t.id}\`  (depth ${t.depth}, run: ${run})`;
}
