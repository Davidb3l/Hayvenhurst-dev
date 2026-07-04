/**
 * CLI-level tests for `hayven refs` — the TYPO GUARD that stops a fat-fingered
 * `/`-looking symbol id from silently fuzzy-resolving to an unrelated top-FTS
 * hit and printing a confident, WRONG references list.
 *
 * The rule under test (identical to `impact`):
 *   - a `/`-looking id (structured node id) not found exactly ⇒ ERROR (exit 1 +
 *     stderr "No node with id ..."), no fuzzy substitution, empty stdout;
 *   - a bare term (no `/`) not found exactly ⇒ KEEP fuzzy-resolve (exit 0 + note);
 *   - an exact, real id ⇒ unchanged success.
 *
 * Fixture style mirrors `branches_cli.test.ts` (temp `.hayven/` project, no
 * `.git` → legacy index) and `impact.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRefs } from "../src/cli/refs.ts";
import { Db } from "../src/db/queries.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

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
 * Same fixture as impact.test.ts: `caller` calls `werkzeug/http/dump_cookie`, and
 * `werkzeug/routing/build` is an unrelated node the typo would otherwise fuzzy
 * resolve to. No `.git` ⇒ legacy index.
 */
function buildProject(): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-refs-cli-"));
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

describe("hayven refs — typo guard for `/`-looking ids", () => {
  test("a `/`-looking id that doesn't exist EXACTLY errors (exit 1), no fuzzy substitution", async () => {
    buildProject();
    const badId = "werkzeug/http/does_not_exist";
    const { code, out, err } = await capture(() =>
      runRefs({ positionals: [badId], flags: {} }),
    );
    expect(code).toBe(1);
    expect(err).toContain(`No node with id \`${badId}\``);
    expect(err).toContain(`hayven query ${badId}`);
    expect(err).not.toContain("top search hit");
    expect(out).toBe("");
  });

  test("a `/`-looking id that FUZZY-matches (the real footgun) is guarded, not substituted", async () => {
    // `werkzeug/http/dump_cooki` (truncated) DOES fuzzy-resolve to
    // `werkzeug/http/dump_cookie` — the case the old code silently substituted.
    buildProject();
    const badId = "werkzeug/http/dump_cooki";
    const { code, out, err } = await capture(() =>
      runRefs({ positionals: [badId], flags: {} }),
    );
    expect(code).toBe(1);
    expect(err).toContain(`No node with id \`${badId}\``);
    expect(err).not.toContain("top search hit");
    expect(err).not.toContain("using `werkzeug/http/dump_cookie`");
    expect(out).toBe("");
  });

  test("--json: a `/`-looking typo still errors with empty stdout", async () => {
    buildProject();
    const badId = "werkzeug/http/does_not_exist";
    const { code, out, err } = await capture(() =>
      runRefs({ positionals: [badId], flags: { json: true } }),
    );
    expect(code).toBe(1);
    expect(err).toContain(`No node with id \`${badId}\``);
    expect(out).toBe("");
  });

  test("a BARE term (no `/`) still fuzzy-resolves with exit 0 (convenience preserved)", async () => {
    buildProject();
    const { code, out, err } = await capture(() =>
      runRefs({ positionals: ["dump_cookie"], flags: {} }),
    );
    expect(code).toBe(0);
    expect(err).toContain("not found exactly");
    expect(err).toContain("top search hit");
    expect(out).toContain("werkzeug/http/dump_cookie");
  });

  test("an EXACT, real `/`-looking id works unchanged (exit 0, no note)", async () => {
    buildProject();
    const { code, out, err } = await capture(() =>
      runRefs({ positionals: ["werkzeug/http/dump_cookie"], flags: {} }),
    );
    expect(code).toBe(0);
    expect(err).not.toContain("top search hit");
    // `caller` references it.
    expect(out).toContain("caller");
    expect(out).toContain("References to");
  });

  test("an EXACT, real id with --json emits the report with resolved=null", async () => {
    buildProject();
    const { code, out } = await capture(() =>
      runRefs({ positionals: ["werkzeug/http/dump_cookie"], flags: { json: true } }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { symbol: string; resolved: string | null };
    expect(parsed.symbol).toBe("werkzeug/http/dump_cookie");
    expect(parsed.resolved).toBeNull();
  });
});
