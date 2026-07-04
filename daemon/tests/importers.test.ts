/**
 * CLI-level tests for `hayven importers` — the TYPO GUARD (parity with impact/refs).
 * A fat-fingered `/`-looking module id must not silently fuzzy-resolve to an
 * unrelated top-FTS hit and print a confident, WRONG importers list.
 *
 * Rule (identical to impact/refs):
 *   - a `/`-looking id not found exactly ⇒ ERROR (exit 1 + stderr "No node with
 *     id ..."), no fuzzy substitution, empty stdout;
 *   - a bare term (no `/`) not found exactly ⇒ KEEP fuzzy-resolve (exit 0 + note);
 *   - an exact, real id ⇒ unchanged success.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runImporters } from "../src/cli/importers.ts";
import { Db } from "../src/db/queries.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

async function capture(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
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

/** `caller` imports `werkzeug/exceptions`; `werkzeug/routing/build` is an
 *  unrelated node the typo would otherwise fuzzy-resolve to. No `.git` ⇒ legacy. */
function buildProject(): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-importers-cli-"));
  const paths = hayvenPathsFor(root);
  mkdirSync(paths.hayvenDir, { recursive: true });
  const db = new Db(paths.sqliteFile);
  try {
    db.migrate();
    for (const id of ["werkzeug/exceptions", "werkzeug/routing/build", "caller"]) {
      db.upsertNode({
        id, name: id.split("/").pop() ?? id, qualified_name: id,
        kind: id === "werkzeug/exceptions" ? "module" : "function",
        language: "python", file: `${id}.py`, range: [1, 10],
        ast_hash: `h-${id}`, last_seen: 0, logical_clock: 0,
      });
    }
    db.upsertEdge({ src: "caller", dst: "werkzeug/exceptions", kind: "import", weight: 1, last_seen: 0 });
  } finally {
    db.close();
  }
  process.chdir(root);
  projectCwd = root;
  return root;
}

describe("hayven importers — typo guard for `/`-looking ids", () => {
  test("a `/`-looking id that doesn't exist EXACTLY errors (exit 1), no substitution", async () => {
    buildProject();
    const badId = "werkzeug/exceptions_does_not_exist";
    const { code, out, err } = await capture(() => runImporters({ positionals: [badId], flags: {} }));
    expect(code).toBe(1);
    expect(err).toContain(`No node with id \`${badId}\``);
    expect(err).not.toContain("top search hit");
    expect(out).toBe("");
  });

  test("a `/`-looking id that FUZZY-matches (the real footgun) is guarded, not substituted", async () => {
    buildProject();
    const badId = "werkzeug/exception"; // fuzzy-resolves to werkzeug/exceptions
    const { code, out, err } = await capture(() => runImporters({ positionals: [badId], flags: {} }));
    expect(code).toBe(1);
    expect(err).toContain(`No node with id \`${badId}\``);
    expect(err).not.toContain("top search hit");
    expect(out).toBe("");
  });

  test("--json: a `/`-looking typo still errors with empty stdout", async () => {
    buildProject();
    const badId = "werkzeug/exceptions_does_not_exist";
    const { code, out } = await capture(() => runImporters({ positionals: [badId], flags: { json: true } }));
    expect(code).toBe(1);
    expect(out).toBe("");
  });

  test("a BARE term (no `/`) still fuzzy-resolves with exit 0 (convenience preserved)", async () => {
    buildProject();
    const { code, err } = await capture(() => runImporters({ positionals: ["exception"], flags: {} }));
    expect(code).toBe(0);
    expect(err).toContain("top search hit");
  });

  test("an EXACT, real `/`-looking id works unchanged (exit 0)", async () => {
    buildProject();
    const { code, out } = await capture(() => runImporters({ positionals: ["werkzeug/exceptions"], flags: { json: true } }));
    expect(code).toBe(0);
    expect(out).toContain("caller");
  });
});
