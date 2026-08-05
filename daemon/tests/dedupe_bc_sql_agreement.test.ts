/**
 * Task C, ANTI-DRIFT — the TypeScript predicate and the SQL fragment must agree
 * on every path, always.
 *
 * This is the most important test in the task. `db/context_pack.ts` asks the
 * question in TypeScript and `db/fts.ts` asks it in SQL; they are generated from
 * one pattern list precisely so they cannot answer differently. But "generated
 * from one list" is only a claim until something actually RUNS both mechanisms
 * over the same corpus and compares verdicts. That is what this does: it loads
 * every fixture path into a real in-memory SQLite table, evaluates the emitted
 * LIKE chain against it, and demands verdict-for-verdict equality with the TS
 * predicate.
 *
 * If someone adds a pattern that compiles to a LIKE the RegExp compiler handles
 * differently (an unescaped `_`, a stray `%`, a case-folding surprise), this
 * fails — even though both consumers still "share the list".
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import {
  isScaffoldFile,
  isTestFile,
  scaffoldFileSqlPredicate,
  testFileSqlPredicate,
} from "../src/util/test_files.ts";

/** The fixture corpus. Deliberately declared here rather than imported from the
 *  sibling predicate test: importing one bun test file from another registers
 *  its cases twice. It spans every language convention, the near-misses, the
 *  bench/mock scaffold-only paths, and adversarial paths aimed at the LIKE /
 *  RegExp seam specifically (wildcard characters appearing LITERALLY in a
 *  path). Only the VERDICTS need to agree, so the corpus just has to be wide. */
const CORPUS: readonly string[] = [
  // Tests, per language.
  "src/cookie.test.ts",
  "src/cookie.test.tsx",
  "src/cookie.test.mts",
  "src/cookie.spec.js",
  "packages/a/src/router.spec.tsx",
  "__tests__/router.ts",
  "src/__tests__/router.ts",
  "test_parser.py",
  "pkg/test_parser.py",
  "pkg/parser_test.py",
  "tests/conftest.py",
  "pkg/tests/conftest.py",
  // Singular `test/`, plus the ends-in-test directories that must stay out.
  "test/foo.py",
  "src/test/java/A.java",
  "latest/x.ts",
  "protest/x.ts",
  "internal/walk_test.go",
  "walk_test.go",
  "tests/integration.rs",
  "crates/core/tests/integration.rs",
  // Near-miss real source.
  "src/contest.ts",
  "src/latest.py",
  "src/attestation.go",
  "src/manifest.tsx",
  "src/testing.py",
  "src/protests/handler.py",
  "src/spectrum.ts",
  "src/testify.go",
  "src/detest.rs",
  "src/db/context_pack.ts",
  "testX.py",
  "pkg/walkXtest.go",
  // Scaffold but not test.
  "bench/agent-nav-eval.ts",
  "daemon/bench/toil-scoreboard.ts",
  "src/api/mocks.ts",
  "mocks.ts",
  "src/api/server.mock.ts",
  "src/mocks/handlers.ts",
  "src/__mocks__/fs.ts",
  // Adversarial: a real `%` or `_` in the path text, and case variants (SQLite
  // LIKE folds ASCII case, so the TS side must too).
  "src/100%.ts",
  "src/a_b.ts",
  "src/A.TEST.TS",
  "SRC/TESTS/x.py",
  "src/Walk_Test.go",
  "src/%/tests/x.rs",
  "src/x.test.",
  ".test.ts",
  // The `*_test.*` / `*_spec.*` rows adopted in the divergence audit, plus the
  // near-misses that stress the SAME LIKE/RegExp seam those rows introduce: an
  // unescaped underscore would make every `aXtest.ts` match, and SQLite and the
  // RegExp compiler must fall the same way on all of them.
  "src/cookie_test.ts",
  "src/cookie_test.tsx",
  "src/parser_test.rs",
  "src/cookie_spec.ts",
  "src/api_spec.ts",
  "src/openapi_spec.py",
  "internal/wire_spec.go",
  "src/protocol_spec.rs",
  "src/ab_test.ts",
  "fixtures/repo_test.d/src/main.go",
  "spec/foo_spec.rb",
  "spec/models/user_spec.rb",
  "test/user_test.rb",
  "src/aXtest.ts",
  "src/aXspec.rb",
  "src/latest_test_helpers.go",
  "src/inspector_spectrum.ts",
  "src/greatest_hits.ts",
  "src/test_helpers.go",
  "src/test_util.rs",
  "src/A_TEST.RB",
  "src/x_spec.",
  "tests/",
  "bench/",
  "src/bench/x.ts",
  "benchmarks/x.ts",
];

/** Evaluate a generated SQL boolean fragment over the corpus, returning the set
 *  of paths for which it is TRUE — using the real SQLite LIKE implementation,
 *  not a re-implementation of it. */
function sqlVerdicts(fragment: string): Set<string> {
  const db = new Database(":memory:");
  db.run("CREATE TABLE nodes (id INTEGER PRIMARY KEY, file TEXT)");
  const insert = db.query("INSERT INTO nodes (file) VALUES (?)");
  for (const p of CORPUS) insert.run(p);
  const rows = db
    .query<{ file: string }, []>(
      `SELECT n.file AS file FROM nodes n WHERE ${fragment}`,
    )
    .all();
  db.close();
  return new Set(rows.map((r) => r.file));
}

describe("TS predicate and SQL fragment agree on every path", () => {
  it("isTestFile matches testFileSqlPredicate exactly", () => {
    const fromSql = sqlVerdicts(testFileSqlPredicate("n.file"));
    const disagreements = CORPUS.filter(
      (p) => isTestFile(p) !== fromSql.has(p),
    ).map((p) => `${p}: ts=${isTestFile(p)} sql=${fromSql.has(p)}`);
    expect(disagreements).toEqual([]);
  });

  it("isScaffoldFile matches scaffoldFileSqlPredicate exactly", () => {
    const fromSql = sqlVerdicts(scaffoldFileSqlPredicate("n.file"));
    const disagreements = CORPUS.filter(
      (p) => isScaffoldFile(p) !== fromSql.has(p),
    ).map((p) => `${p}: ts=${isScaffoldFile(p)} sql=${fromSql.has(p)}`);
    expect(disagreements).toEqual([]);
  });

  it("scaffold is a strict superset of test on both sides", () => {
    const tests = sqlVerdicts(testFileSqlPredicate("n.file"));
    const scaffold = sqlVerdicts(scaffoldFileSqlPredicate("n.file"));
    for (const p of tests) expect(scaffold.has(p)).toBe(true);
    // And the superset is PROPER: bench/mock paths are scaffold-only.
    expect(scaffold.size).toBeGreaterThan(tests.size);
  });

  it("agrees on a NULL file, the one input class the corpus cannot carry", () => {
    // `nodes.file` is nullable. TS short-circuits on the falsy value; in SQL
    // `NULL LIKE …` is NULL, so the row is not selected by a bare WHERE and the
    // fts call site's `CASE … ELSE 0` scores it 0. Both mean "not scaffold".
    const db = new Database(":memory:");
    db.run("CREATE TABLE nodes (id INTEGER PRIMARY KEY, file TEXT)");
    db.run("INSERT INTO nodes (file) VALUES (NULL)");
    const selected = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM nodes n WHERE ${scaffoldFileSqlPredicate("n.file")}`,
      )
      .get()!.n;
    const scored = db
      .query<{ s: number }, []>(
        `SELECT CASE WHEN ${scaffoldFileSqlPredicate("n.file")} THEN 1 ELSE 0 END AS s
           FROM nodes n`,
      )
      .get()!.s;
    db.close();
    expect(selected).toBe(0);
    expect(scored).toBe(0);
    expect(isScaffoldFile(null)).toBe(false);
  });
});

describe("the emitted SQL is a safe, parameter-free literal fragment", () => {
  it("binds no parameters", () => {
    const fragment = scaffoldFileSqlPredicate("n.file");
    expect(fragment).not.toContain("?");
  });

  it("carries an explicit ESCAPE clause on every LIKE", () => {
    // Without ESCAPE the backslash escapes in the patterns are inert and `_`
    // silently becomes a wildcard again.
    const fragment = scaffoldFileSqlPredicate("n.file");
    const likes = fragment.match(/LIKE/g)?.length ?? 0;
    const escapes = fragment.match(/ESCAPE/g)?.length ?? 0;
    expect(likes).toBeGreaterThan(0);
    expect(escapes).toBe(likes);
  });

  it("rejects a column reference that is not a plain identifier", () => {
    expect(() => testFileSqlPredicate("n.file' OR '1'='1")).toThrow();
    expect(() => testFileSqlPredicate("(SELECT 1)")).toThrow();
    expect(() => testFileSqlPredicate("")).toThrow();
  });

  it("accepts a bare column and an alias.column", () => {
    expect(() => testFileSqlPredicate("file")).not.toThrow();
    expect(() => testFileSqlPredicate("n.file")).not.toThrow();
  });
});
