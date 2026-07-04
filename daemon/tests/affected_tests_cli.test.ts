/**
 * `hayven affected-tests` CLI presenter — the `--runner vitest|bun` entry
 * points (bench/affected-tests-typescript-RESULTS.md §5 item 5: a first-class
 * runner handoff instead of hand-assembling a command from the JSON; `bun` =
 * Bun's native `bun test` runner, same file-selected set).
 *
 * Contract under test:
 *   - `--runner vitest` (no --json): stdout is EXACTLY one ready-to-paste
 *     `vitest run <spec files...>` line (full repo-relative paths — vitest's
 *     positional filters are path substrings, so full paths are the
 *     file-granular form); every note goes to stderr. `--runner bun` mirrors
 *     it exactly with a `bun test <spec files...>` line (bun:test's
 *     positional filters are path substrings too).
 *   - spec files are DEDUPED (many test nodes per file) in ranked order; tests
 *     on other runners are skipped WITH a stderr note, never silently.
 *   - an EMPTY vitest set writes NOTHING to stdout (an empty `vitest run` would
 *     run the whole suite — the inverse of a selector).
 *   - `--json` WITHOUT the flag is byte-compatible (no new keys); WITH it the
 *     payload gains exactly {runner, runnerArgs, runnerCommand,
 *     runnerSkippedCount} and nothing else changes.
 *   - a bare `--runner` (the hand-rolled parser delivers boolean true) and an
 *     unsupported value both exit 2 with a clear error.
 *
 * Fixture style mirrors branches_cli.test.ts: a temp project (`.hayven/` +
 * seeded legacy index), chdir in, drive the run* handler capturing stdio.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAffectedTests } from "../src/cli/affected_tests.ts";
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

/** Seed one node with DISTINCT name == qualified_name (resolver-friendly). */
function seedNode(
  db: Db,
  id: string,
  name: string,
  file: string | null,
  language = "typescript",
): void {
  db.upsertNode({
    id,
    name,
    qualified_name: name,
    kind: "function",
    language,
    file: file as string,
    range: [1, 10],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

/**
 * Build a temp project whose legacy index holds one changed symbol
 * (`src/utils/url/getPath`) reached by:
 *   - TWO test nodes in ONE vitest spec (`src/utils/url.test.ts`) — the dedupe case;
 *   - one vitest spec needing shell quoting (`src/app pages/[id].test.ts`);
 *   - one pytest test (`tests/test_url.py`) — the skipped-runner case;
 * plus an isolated symbol (`src/only/py/helper`) reached ONLY by the pytest
 * test — the empty-vitest-set case.
 */
function buildProject(): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-at-cli-"));
  const paths = hayvenPathsFor(root);
  mkdirSync(paths.hayvenDir, { recursive: true });

  const db = new Db(paths.sqliteFile);
  try {
    db.migrate();
    seedNode(db, "src/utils/url/getPath", "getPathFn", "src/utils/url.ts");
    seedNode(db, "src/utils/url.test/testGetPathBasic", "testGetPathBasic", "src/utils/url.test.ts");
    seedNode(db, "src/utils/url.test/testGetPathQuery", "testGetPathQuery", "src/utils/url.test.ts");
    seedNode(db, "src/app pages/[id].test/testDynamicRoute", "testDynamicRoute", "src/app pages/[id].test.ts");
    seedNode(db, "tests/test_url/test_get_path", "test_get_path", "tests/test_url.py", "python");
    seedNode(db, "src/only/py/helper", "onlyPyHelper", "src/only/py.ts");

    const edge = (src: string, dst: string): void =>
      db.upsertEdge({ src, dst, kind: "static_call", weight: 1, last_seen: 0 });
    edge("src/utils/url.test/testGetPathBasic", "src/utils/url/getPath");
    edge("src/utils/url.test/testGetPathQuery", "src/utils/url/getPath");
    edge("src/app pages/[id].test/testDynamicRoute", "src/utils/url/getPath");
    edge("tests/test_url/test_get_path", "src/utils/url/getPath");
    edge("tests/test_url/test_get_path", "src/only/py/helper");
  } finally {
    db.close();
  }

  process.chdir(root);
  projectCwd = root;
  return root;
}

const SYMBOL = "src/utils/url/getPath";

describe("affected-tests --runner vitest (command mode)", () => {
  test("stdout is exactly one ready-to-paste `vitest run` line; files deduped; pytest skipped to stderr", async () => {
    buildProject();
    const { code, out, err } = await capture(() =>
      runAffectedTests({ positionals: [SYMBOL], flags: { runner: "vitest" } }),
    );
    expect(code).toBe(0);

    // Exactly ONE stdout line, starting with the invocation.
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const cmd = lines[0]!;
    expect(cmd.startsWith("vitest run ")).toBe(true);

    // The deduped spec file appears ONCE despite two test nodes in it.
    expect(cmd.split("src/utils/url.test.ts").length - 1).toBe(1);
    // The quoting-hostile path is single-quoted (space + brackets).
    expect(cmd).toContain("'src/app pages/[id].test.ts'");
    // The pytest test is NOT in the command...
    expect(cmd).not.toContain("test_url.py");
    // ...and its exclusion is said out loud on stderr.
    expect(err).toContain("1 affected test(s) not in the vitest command");
  });

  test("an affected set with NO vitest tests writes NOTHING to stdout (never an empty `vitest run`)", async () => {
    buildProject();
    const { code, out, err } = await capture(() =>
      runAffectedTests({ positionals: ["src/only/py/helper"], flags: { runner: "vitest" } }),
    );
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toContain("no vitest-runnable tests in the affected set");
  });

  test("bare --runner (parser eats no value → boolean true) exits 2 with a clear error", async () => {
    buildProject();
    const { code, out, err } = await capture(() =>
      runAffectedTests({ positionals: [SYMBOL], flags: { runner: true } }),
    );
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("--runner requires a value");
  });

  test("unsupported --runner value exits 2 naming the supported set", async () => {
    buildProject();
    const { code, err } = await capture(() =>
      runAffectedTests({ positionals: [SYMBOL], flags: { runner: "jest" } }),
    );
    expect(code).toBe(2);
    expect(err).toContain("unsupported --runner `jest`");
    expect(err).toContain("vitest");
    expect(err).toContain("bun");
  });
});

describe("affected-tests --runner bun (command mode)", () => {
  test("stdout is exactly one ready-to-paste `bun test` line; files deduped; pytest skipped to stderr", async () => {
    buildProject();
    const { code, out, err } = await capture(() =>
      runAffectedTests({ positionals: [SYMBOL], flags: { runner: "bun" } }),
    );
    expect(code).toBe(0);

    // Exactly ONE stdout line, starting with the invocation.
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const cmd = lines[0]!;
    expect(cmd.startsWith("bun test ")).toBe(true);

    // The deduped spec file appears ONCE despite two test nodes in it.
    expect(cmd.split("src/utils/url.test.ts").length - 1).toBe(1);
    // The quoting-hostile path is single-quoted (space + brackets).
    expect(cmd).toContain("'src/app pages/[id].test.ts'");
    // The pytest test is NOT in the command...
    expect(cmd).not.toContain("test_url.py");
    // ...and its exclusion is said out loud on stderr.
    expect(err).toContain("1 affected test(s) not in the bun command");
  });

  test("an affected set with NO bun-runnable tests writes NOTHING to stdout (never an empty `bun test`)", async () => {
    buildProject();
    const { code, out, err } = await capture(() =>
      runAffectedTests({ positionals: ["src/only/py/helper"], flags: { runner: "bun" } }),
    );
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toContain("no bun-runnable tests in the affected set");
  });
});

describe("affected-tests --runner bun (--json additivity)", () => {
  test("with --runner bun the payload gains EXACTLY the four runner keys, all else identical", async () => {
    buildProject();
    const plain = await capture(() =>
      runAffectedTests({ positionals: [SYMBOL], flags: { json: true } }),
    );
    const withRunner = await capture(() =>
      runAffectedTests({ positionals: [SYMBOL], flags: { json: true, runner: "bun" } }),
    );
    expect(withRunner.code).toBe(0);

    const base = JSON.parse(plain.out) as Record<string, unknown>;
    const augmented = JSON.parse(withRunner.out) as Record<string, unknown>;

    expect(augmented.runner).toBe("bun");
    const runnerArgs = augmented.runnerArgs as string[];
    expect(runnerArgs[0]).toBe("test");
    expect(runnerArgs).toContain("src/utils/url.test.ts");
    expect(runnerArgs).toContain("src/app pages/[id].test.ts"); // UNQUOTED in the array
    expect(runnerArgs).not.toContain("tests/test_url.py::test_get_path");
    // Dedupe holds in the array form too.
    expect(runnerArgs.filter((a) => a === "src/utils/url.test.ts")).toHaveLength(1);
    expect(typeof augmented.runnerCommand).toBe("string");
    expect(augmented.runnerCommand as string).toContain("bun test ");
    expect(augmented.runnerSkippedCount).toBe(1); // the pytest test

    // Strictly additive: strip the four new keys → deep-equal to the plain run.
    delete augmented.runner;
    delete augmented.runnerArgs;
    delete augmented.runnerCommand;
    delete augmented.runnerSkippedCount;
    expect(augmented).toEqual(base);
  });

  test("empty bun set in JSON: runnerArgs [] and runnerCommand null", async () => {
    buildProject();
    const { code, out } = await capture(() =>
      runAffectedTests({
        positionals: ["src/only/py/helper"],
        flags: { json: true, runner: "bun" },
      }),
    );
    expect(code).toBe(0);
    const payload = JSON.parse(out) as Record<string, unknown>;
    expect(payload.runnerArgs).toEqual([]);
    expect(payload.runnerCommand).toBeNull();
  });
});

describe("affected-tests --runner vitest (--json additivity)", () => {
  test("without --runner the JSON payload has NO runner keys (byte-compatible)", async () => {
    buildProject();
    const { code, out } = await capture(() =>
      runAffectedTests({ positionals: [SYMBOL], flags: { json: true } }),
    );
    expect(code).toBe(0);
    const payload = JSON.parse(out) as Record<string, unknown>;
    for (const k of ["runner", "runnerArgs", "runnerCommand", "runnerSkippedCount"]) {
      expect(k in payload).toBe(false);
    }
    // The pre-existing shape is intact.
    expect(payload.symbol).toBe(SYMBOL);
    expect(Array.isArray(payload.tests)).toBe(true);
  });

  test("with --runner vitest the payload gains EXACTLY the four runner keys, all else identical", async () => {
    buildProject();
    const plain = await capture(() =>
      runAffectedTests({ positionals: [SYMBOL], flags: { json: true } }),
    );
    const withRunner = await capture(() =>
      runAffectedTests({ positionals: [SYMBOL], flags: { json: true, runner: "vitest" } }),
    );
    expect(withRunner.code).toBe(0);

    const base = JSON.parse(plain.out) as Record<string, unknown>;
    const augmented = JSON.parse(withRunner.out) as Record<string, unknown>;

    expect(augmented.runner).toBe("vitest");
    const runnerArgs = augmented.runnerArgs as string[];
    expect(runnerArgs[0]).toBe("run");
    expect(runnerArgs).toContain("src/utils/url.test.ts");
    expect(runnerArgs).toContain("src/app pages/[id].test.ts"); // UNQUOTED in the array
    expect(runnerArgs).not.toContain("tests/test_url.py::test_get_path");
    // Dedupe holds in the array form too.
    expect(runnerArgs.filter((a) => a === "src/utils/url.test.ts")).toHaveLength(1);
    expect(typeof augmented.runnerCommand).toBe("string");
    expect(augmented.runnerCommand as string).toContain("vitest run ");
    expect(augmented.runnerSkippedCount).toBe(1); // the pytest test

    // Strictly additive: strip the four new keys → deep-equal to the plain run.
    delete augmented.runner;
    delete augmented.runnerArgs;
    delete augmented.runnerCommand;
    delete augmented.runnerSkippedCount;
    expect(augmented).toEqual(base);
  });

  test("empty vitest set in JSON: runnerArgs [] and runnerCommand null", async () => {
    buildProject();
    const { code, out } = await capture(() =>
      runAffectedTests({
        positionals: ["src/only/py/helper"],
        flags: { json: true, runner: "vitest" },
      }),
    );
    expect(code).toBe(0);
    const payload = JSON.parse(out) as Record<string, unknown>;
    expect(payload.runnerArgs).toEqual([]);
    expect(payload.runnerCommand).toBeNull();
  });
});
