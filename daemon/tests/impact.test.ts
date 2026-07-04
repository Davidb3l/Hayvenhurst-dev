/**
 * CLI-level tests for `hayven impact` (and `impact --preview`) — specifically
 * the TYPO GUARD that stops a fat-fingered `/`-looking symbol id from silently
 * fuzzy-resolving to an unrelated top-FTS hit and printing a confident, WRONG
 * "0 dependents" answer.
 *
 * The rule under test:
 *   - a `/`-looking id (structured node id) that is NOT found exactly ⇒ ERROR
 *     (exit 1 + stderr "No node with id ..."), no fuzzy substitution, empty stdout;
 *   - a bare term (no `/`) that is not found exactly ⇒ KEEP fuzzy-resolve
 *     (exit 0 + a stderr `note:`), the legitimate loose-term convenience;
 *   - an exact, real id ⇒ unchanged success.
 *
 * Mirrors the fixture style of `branches_cli.test.ts`: build a temp project with
 * a `.hayven/` dir (so `requireProject` resolves it) and NO `.git` (so the read
 * path falls back to the legacy `index.sqlite`), seed that index, `chdir` in, and
 * drive `runImpact` capturing stdout/stderr.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runImpact } from "../src/cli/impact.ts";
import { Db } from "../src/db/queries.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

/** Capture process.stdout/stderr writes for the duration of `fn`. */
async function capture(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    err += s;
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

let projectCwd: string | undefined;
const origCwd = process.cwd();

afterEach(() => {
  process.chdir(origCwd);
  if (projectCwd) {
    rmSync(projectCwd, { recursive: true, force: true });
    projectCwd = undefined;
  }
});

/**
 * Build a temp project with a seeded legacy index. Two real nodes so the FTS
 * trigram index has content:
 *   - `werkzeug/http/dump_cookie`  (the symbol a user MEANT to type)
 *   - `werkzeug/routing/build`     (an unrelated symbol, and the top FTS hit a
 *                                   `/`-looking typo would otherwise resolve to)
 * `caller` calls `dump_cookie` so the exact-id success path has a dependent to
 * report. No `.git`, so `openProjectDb` uses the legacy `index.sqlite`.
 */
function buildProject(): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-impact-cli-"));
  const paths = hayvenPathsFor(root);
  mkdirSync(paths.hayvenDir, { recursive: true });

  const db = new Db(paths.sqliteFile);
  try {
    db.migrate();
    for (const id of [
      "werkzeug/http/dump_cookie",
      "werkzeug/routing/build",
      "caller",
    ]) {
      db.upsertNode({
        id,
        name: id.split("/").pop() ?? id,
        qualified_name: id,
        kind: "function",
        language: "python",
        file: `${id}.py`,
        range: [1, 10],
        ast_hash: `h-${id}`,
        last_seen: 0,
        logical_clock: 0,
      });
    }
    // caller -> dump_cookie, so `impact dump_cookie`'s exact target has 1 dependent.
    db.upsertEdge({
      src: "caller",
      dst: "werkzeug/http/dump_cookie",
      kind: "static_call",
      weight: 1,
      last_seen: 0,
    });
  } finally {
    db.close();
  }

  process.chdir(root);
  projectCwd = root;
  return root;
}

describe("hayven impact — typo guard for `/`-looking ids", () => {
  test("a `/`-looking id that doesn't exist EXACTLY errors (exit 1), no fuzzy substitution", async () => {
    buildProject();
    const badId = "werkzeug/http/does_not_exist";
    const { code, out, err } = await capture(() =>
      runImpact({ positionals: [badId], flags: {} }),
    );
    // Non-zero exit — a typo must not masquerade as a real "nothing breaks" answer.
    expect(code).toBe(1);
    // Names the input + suggests `hayven query` (mirrors the fully-not-found path).
    expect(err).toContain(`No node with id \`${badId}\``);
    expect(err).toContain(`hayven query ${badId}`);
    // It did NOT print the misleading fuzzy `note: ... using ... (top search hit)`.
    expect(err).not.toContain("top search hit");
    // stdout stays clean (no "0 dependent(s)" confident-wrong answer).
    expect(out).toBe("");
  });

  test("a `/`-looking id that FUZZY-matches (the real footgun) is guarded, not substituted", async () => {
    // `werkzeug/http/dump_cooki` (truncated) DOES fuzzy-resolve to
    // `werkzeug/http/dump_cookie` via FTS — this is precisely the case the old
    // code silently substituted (exit 0 + wrong "note: using ..."). The guard
    // must turn it into a hard not-found error instead.
    buildProject();
    const badId = "werkzeug/http/dump_cooki";
    const { code, out, err } = await capture(() =>
      runImpact({ positionals: [badId], flags: {} }),
    );
    expect(code).toBe(1);
    expect(err).toContain(`No node with id \`${badId}\``);
    // The tell-tale of the OLD footgun behavior must be ABSENT.
    expect(err).not.toContain("top search hit");
    expect(err).not.toContain("using `werkzeug/http/dump_cookie`");
    expect(out).toBe("");
  });

  test("--json: a `/`-looking typo still errors with empty stdout", async () => {
    buildProject();
    const badId = "werkzeug/http/does_not_exist";
    const { code, out, err } = await capture(() =>
      runImpact({ positionals: [badId], flags: { json: true } }),
    );
    expect(code).toBe(1);
    expect(err).toContain(`No node with id \`${badId}\``);
    // No JSON body emitted on the typo-error path.
    expect(out).toBe("");
  });

  test("--preview: a `/`-looking FUZZY-matching typo errors too (guards the second fuzzy path)", async () => {
    // Uses the genuinely-fuzzy id so the --preview resolution block's own guard
    // (impact.ts::runImpactPreview) is exercised, not just the null path.
    buildProject();
    const badId = "werkzeug/http/dump_cooki";
    const { code, out, err } = await capture(() =>
      runImpact({ positionals: [badId], flags: { preview: true } }),
    );
    expect(code).toBe(1);
    expect(err).toContain(`No node with id \`${badId}\``);
    expect(err).not.toContain("top search hit");
    expect(out).toBe("");
  });

  test("--preview: a fully-not-found `/`-id (no fuzzy hit) still errors", async () => {
    buildProject();
    const badId = "werkzeug/http/does_not_exist";
    const { code, out, err } = await capture(() =>
      runImpact({ positionals: [badId], flags: { preview: true } }),
    );
    expect(code).toBe(1);
    expect(err).toContain(`No node with id \`${badId}\``);
    expect(out).toBe("");
  });

  test("a BARE term (no `/`) still fuzzy-resolves with exit 0 (convenience preserved)", async () => {
    buildProject();
    const { code, out, err } = await capture(() =>
      runImpact({ positionals: ["dump_cookie"], flags: {} }),
    );
    // The convenience path is untouched: exit 0 + the fuzzy note on stderr.
    expect(code).toBe(0);
    expect(err).toContain("not found exactly");
    expect(err).toContain("top search hit");
    // Resolved to the real node and produced a real impact report on stdout.
    expect(out).toContain("werkzeug/http/dump_cookie");
  });

  test("an EXACT, real `/`-looking id works unchanged (exit 0, no note)", async () => {
    buildProject();
    const { code, out, err } = await capture(() =>
      runImpact({ positionals: ["werkzeug/http/dump_cookie"], flags: {} }),
    );
    expect(code).toBe(0);
    // No fuzzy note for an exact match.
    expect(err).not.toContain("top search hit");
    // The real dependent (`caller`) shows up.
    expect(out).toContain("caller");
    expect(out).toContain("dependent(s)");
  });

  test("an EXACT, real id with --json emits the report with resolved=null", async () => {
    buildProject();
    const { code, out } = await capture(() =>
      runImpact({ positionals: ["werkzeug/http/dump_cookie"], flags: { json: true } }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { symbol: string; resolved: string | null };
    expect(parsed.symbol).toBe("werkzeug/http/dump_cookie");
    expect(parsed.resolved).toBeNull();
  });
});
