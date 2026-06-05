/**
 * Unit tests for the PURE test-node detection module (`db/test_nodes.ts`).
 *
 * Coverage discipline (mirrors the per-language thoroughness of the rest of the
 * suite): for each of the five languages we assert at least a PATH true
 * positive, a NAME true positive, and a clear true NEGATIVE (an ordinary symbol
 * in a non-test file). On top of that the runnable/runner-shape edge cases the
 * caller (the affected-tests query) actually depends on: the pytest
 * `Class::method` node id, the vitest spec-FILE runnable, the config-`patterns`
 * override, and a `file: null` candidate (name-only detection, null runnable).
 */
import { describe, expect, it } from "bun:test";

import {
  classifyTest,
  DEFAULT_TEST_PATH_PATTERNS,
  isCollectableTest,
  isTestNode,
  type TestCandidate,
} from "../src/db/test_nodes.ts";

/** Tiny builder so each case reads as just the fields under test. */
function cand(over: Partial<TestCandidate>): TestCandidate {
  return { id: "n1", name: "fn", file: null, language: null, ...over };
}

describe("DEFAULT_TEST_PATH_PATTERNS", () => {
  it("is the exact agreed list (Lane 1 depends on this verbatim)", () => {
    expect([...DEFAULT_TEST_PATH_PATTERNS]).toEqual([
      "/test/",
      "/tests/",
      "/__tests__/",
      "_test.",
      "test_",
      ".test.",
      ".spec.",
      "_spec.",
    ]);
  });
});

describe("isTestNode — PATH detection", () => {
  it("matches a file under a /tests/ directory", () => {
    expect(isTestNode(cand({ name: "parse", file: "daemon/tests/x.ts" }))).toBe(true);
  });

  it("matches a leading tests/ path that has no leading slash", () => {
    expect(isTestNode(cand({ name: "parse", file: "tests/x.py" }))).toBe(true);
  });

  it("matches a __tests__ directory", () => {
    expect(isTestNode(cand({ name: "render", file: "src/__tests__/render.ts" }))).toBe(true);
  });

  it("normalizes backslash paths before matching", () => {
    expect(isTestNode(cand({ name: "parse", file: "daemon\\tests\\x.ts" }))).toBe(true);
  });

  it("does NOT match an ordinary source file with an ordinary name", () => {
    expect(isTestNode(cand({ name: "parse", file: "daemon/src/parser.ts" }))).toBe(false);
  });
});

describe("isTestNode — NAME detection per language", () => {
  it("python: test_* function name (non-test file) is a test", () => {
    expect(isTestNode(cand({ name: "test_echo", file: "src/echo.py" }))).toBe(true);
  });

  it("python: Test* class name is a test", () => {
    expect(isTestNode(cand({ name: "TestParser", file: "src/parser.py" }))).toBe(true);
  });

  it("js/ts: camelCase testFoo is a test, but bare 'test' is NOT", () => {
    expect(isTestNode(cand({ name: "testParse", file: "src/p.ts" }))).toBe(true);
    expect(isTestNode(cand({ name: "test", file: "src/p.ts" }))).toBe(false);
  });

  it("js/ts: *Spec / *Test suffix is a test", () => {
    expect(isTestNode(cand({ name: "parserSpec", file: "src/p.ts" }))).toBe(true);
  });

  it("go: exported Test*/Benchmark*/Fuzz* are tests; lowercase helper is not", () => {
    expect(isTestNode(cand({ name: "TestParse", file: "p.go" }))).toBe(true);
    expect(isTestNode(cand({ name: "BenchmarkParse", file: "p.go" }))).toBe(true);
    expect(isTestNode(cand({ name: "testingHelper", file: "p.go" }))).toBe(false);
  });

  it("rust: _test / test_ name signal (non-test path) is a test", () => {
    expect(isTestNode(cand({ name: "parse_test", file: "src/lib.rs" }))).toBe(true);
  });

  it("matches the LAST segment of a qualified Class.method name", () => {
    expect(isTestNode(cand({ name: "TestParser.test_echo", file: "src/parser.py" }))).toBe(true);
    expect(isTestNode(cand({ name: "Helpers.parse", file: "src/h.py" }))).toBe(false);
  });
});

describe("isTestNode — patterns override", () => {
  it("REPLACES the default list verbatim when patterns are passed", () => {
    // `/tests/` is no longer in the (custom) list, so a tests-dir file by PATH
    // is NOT a test — but a file matching the custom `/spec/` token is.
    const custom = ["/spec/"];
    expect(isTestNode(cand({ name: "parse", file: "src/tests/x.ts" }), custom)).toBe(false);
    expect(isTestNode(cand({ name: "parse", file: "src/spec/x.ts" }), custom)).toBe(true);
  });

  it("name detection still fires even when the custom patterns miss the path", () => {
    expect(isTestNode(cand({ name: "test_echo", file: "src/x.py" }), ["/spec/"])).toBe(true);
  });
});

describe("classifyTest — runner + runnable shapes", () => {
  it("returns null for a non-test candidate", () => {
    expect(classifyTest(cand({ name: "parse", file: "src/parser.ts" }))).toBeNull();
  });

  it("pytest: bare function → file::func node id", () => {
    const h = classifyTest(cand({ name: "test_echo", file: "tests/test_echo.py" }));
    expect(h).not.toBeNull();
    expect(h!.runner).toBe("pytest");
    expect(h!.runnable).toBe("tests/test_echo.py::test_echo");
  });

  it("pytest: PascalCase Class.method → file::Class::method node id", () => {
    const h = classifyTest(cand({ name: "TestParser.test_echo", file: "tests/test_parser.py" }));
    expect(h!.runner).toBe("pytest");
    expect(h!.runnable).toBe("tests/test_parser.py::TestParser::test_echo");
  });

  it("vitest: spec FILE is the runnable, not a symbol id", () => {
    const h = classifyTest(cand({ name: "renders", file: "src/__tests__/app.test.ts" }));
    expect(h!.runner).toBe("vitest");
    expect(h!.runnable).toBe("src/__tests__/app.test.ts");
  });

  it("jest: path containing jest selects the jest runner (file runnable)", () => {
    const h = classifyTest(cand({ name: "renders", file: "src/__tests__/jest/app.test.ts" }));
    expect(h!.runner).toBe("jest");
    expect(h!.runnable).toBe("src/__tests__/jest/app.test.ts");
  });

  it("go: file is the runnable, runner is go", () => {
    const h = classifyTest(cand({ name: "TestParse", file: "parser_test.go" }));
    expect(h!.runner).toBe("go");
    expect(h!.runnable).toBe("parser_test.go");
  });

  it("cargo: rust test file → cargo runner, file runnable", () => {
    const h = classifyTest(cand({ name: "parse", file: "tests/integration.rs" }));
    expect(h!.runner).toBe("cargo");
    expect(h!.runnable).toBe("tests/integration.rs");
  });

  it("file: null → name-only detection works, runnable is null", () => {
    const h = classifyTest(cand({ name: "test_echo", file: null, language: "python" }));
    expect(h).not.toBeNull();
    expect(h!.file).toBeNull();
    expect(h!.runnable).toBeNull();
    expect(h!.runner).toBe("pytest");
  });

  it("id is carried through unchanged from the candidate", () => {
    const h = classifyTest(cand({ id: "node-42", name: "test_x", file: "tests/t.py" }));
    expect(h!.id).toBe("node-42");
  });
});

/**
 * Nested-function / non-collectable detection — the MEASURED bug fix.
 *
 * The `affected-tests` walk reaches NESTED functions (a `def cmd(): ...` or a
 * `def test_callback(): ...` defined INSIDE a real test) because the parser
 * indexes nested `function_definition` nodes and the Python collector ids frames
 * by `<module>:<co_qualname>`. pytest CANNOT collect those (`file::cmd` → "not
 * found"), so they must stay test-FILE nodes that COUNT but carry a null
 * runnable. We assert: top-level + class-method tests KEEP their runnable; every
 * nesting signal (`.<locals>.`, a function-qualified dotted head in name OR id,
 * a bare `test`) NULLS the runnable while preserving id/file/runner; and the
 * decision is deterministic.
 */
describe("classifyTest — nested / non-collectable pytest tests get a null runnable", () => {
  it("KEEPS a top-level test_* function (unchanged)", () => {
    const h = classifyTest(cand({
      id: "tests/test_x/test_y",
      name: "test_y",
      file: "tests/test_x.py",
    }));
    expect(h!.runnable).toBe("tests/test_x.py::test_y");
    expect(isCollectableTest(cand({ id: "tests/test_x/test_y", name: "test_y", file: "tests/test_x.py" }))).toBe(true);
  });

  it("KEEPS a Test*-class method (PascalCase head — a real pytest class)", () => {
    const h = classifyTest(cand({
      id: "tests/test_x/TestFoo.test_y",
      name: "TestFoo.test_y",
      file: "tests/test_x.py",
    }));
    expect(h!.runnable).toBe("tests/test_x.py::TestFoo::test_y");
    // A namespaced head (pkg.TestFoo) still resolves to the PascalCase class.
    expect(isCollectableTest(cand({ id: "x", name: "pkg.TestFoo.test_y", file: "tests/test_x.py" }))).toBe(true);
  });

  it("NULLS a nested function via the CPython .<locals>. marker in the name", () => {
    const c = cand({
      id: "tests/test_commands/cmd",
      name: "test_real.<locals>.cmd",
      file: "tests/test_commands.py",
    });
    const h = classifyTest(c);
    expect(h).not.toBeNull();
    expect(h!.runnable).toBeNull(); // not independently runnable …
    expect(h!.id).toBe("tests/test_commands/cmd"); // … but still a counted node.
    expect(h!.file).toBe("tests/test_commands.py");
    expect(h!.runner).toBe("pytest");
    expect(isCollectableTest(c)).toBe(false);
  });

  it("NULLS a nested function whose .<locals>. marker survives only in the id", () => {
    const c = cand({
      id: "tests/test_commands/test_real.<locals>.cmd",
      name: "cmd",
      file: "tests/test_commands.py",
    });
    expect(classifyTest(c)!.runnable).toBeNull();
    expect(isCollectableTest(c)).toBe(false);
  });

  it("NULLS a nested test-named helper (function-qualified dotted head)", () => {
    // `test_real.test_callback` — a `def test_callback()` nested in `test_real`.
    // The head `test_real` is a function (not a Test* class) ⇒ nested.
    const c = cand({
      id: "tests/test_commands/test_callback",
      name: "test_real.test_callback",
      file: "tests/test_commands.py",
    });
    expect(classifyTest(c)!.runnable).toBeNull();
    expect(isCollectableTest(c)).toBe(false);
  });

  it("NULLS a nested function whose dotted nested qualname is only in the id", () => {
    const c = cand({
      id: "tests/test_commands/test_real.cmd",
      name: "cmd",
      file: "tests/test_commands.py",
    });
    expect(classifyTest(c)!.runnable).toBeNull();
    expect(isCollectableTest(c)).toBe(false);
  });

  it("NULLS a bare `test`-named node (can't be a real collectable test)", () => {
    const c = cand({
      id: "tests/test_x/test",
      name: "test",
      file: "tests/test_x.py",
    });
    const h = classifyTest(c);
    expect(h).not.toBeNull();
    expect(h!.runnable).toBeNull();
    expect(h!.id).toBe("tests/test_x/test"); // still counted.
    expect(isCollectableTest(c)).toBe(false);
  });

  it("does NOT over-filter: a deeply-namespaced top-level test stays runnable", () => {
    // No dotted qualname on the entity itself (the id `/`-segments are scope,
    // not a nested qualname), so it remains collectable.
    const c = cand({ id: "a/b/c/tests/deep/test_y", name: "test_y", file: "a/b/c/tests/deep.py" });
    expect(classifyTest(c)!.runnable).toBe("a/b/c/tests/deep.py::test_y");
    expect(isCollectableTest(c)).toBe(true);
  });

  it("non-pytest runners are unaffected (file runnable, always collectable)", () => {
    // A vitest spec selects by FILE; nesting is a pytest-only node-id concern.
    const v = cand({ id: "x", name: "inner", file: "src/__tests__/app.test.ts" });
    expect(isCollectableTest(v)).toBe(true);
    expect(classifyTest(v)!.runnable).toBe("src/__tests__/app.test.ts");
  });

  it("is deterministic — same candidate yields the same handle every call", () => {
    const c = cand({
      id: "tests/test_commands/cmd",
      name: "test_real.<locals>.cmd",
      file: "tests/test_commands.py",
    });
    const first = classifyTest(c);
    const second = classifyTest(c);
    expect(second).toEqual(first);
    expect(isCollectableTest(c)).toBe(isCollectableTest(c));
  });
});
