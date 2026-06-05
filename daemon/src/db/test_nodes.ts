/**
 * PURE test-node detection — classify a graph entity as a "test" and derive a
 * runnable handle a test runner can execute.
 *
 * WHY this exists: the `affected-tests` query (ROADMAP "trace-augmented
 * test-impact selection") walks the impact/coverage graph from a changed symbol
 * and reaches a mixed bag of nodes — production functions, helpers, AND the
 * tests that exercise them. To turn that reached set into a *run list* it must
 * filter down to the nodes that are actually tests, then hand each one to the
 * right runner. This module is that filter + the handle derivation.
 *
 * It is deliberately PURE and graph-free (mirrors the pure-function discipline
 * of `graph_walk.ts`): the caller supplies a {@link TestCandidate} carved out of
 * a `NodeRow` (`id`, `name`, `file`, `language`); we never touch the `Db`. That
 * keeps detection trivially unit-testable and lets BOTH the daemonless read path
 * and the daemon share one source of truth for "is this a test?".
 *
 * A node is a test when EITHER signal fires:
 *   1. PATH — its file lives in a test location (`/tests/`, `*.test.ts`, …).
 *   2. NAME — its entity name matches a per-language test-naming convention
 *      (`test_*`, `TestFoo`, `testFoo`, `*Test`, …).
 * Either is sufficient: a `test_echo` defined in a non-test file is still a
 * test, and an ordinary helper living inside a `_test.go` file is reached as
 * part of the test and should run with it. Detection is intentionally a UNION,
 * not an intersection, so we never drop a test the impact walk legitimately
 * reached.
 */

/**
 * A node's identity fields needed to classify it as a test. The caller (the
 * affected-tests query) supplies these from a `NodeRow` (`id`, `name`, `file`,
 * `language`).
 */
export interface TestCandidate {
  id: string;
  name: string;
  file: string | null;
  language?: string | null;
}

/** Inferred test runner for a candidate. */
export type TestRunner = "pytest" | "vitest" | "jest" | "go" | "cargo" | "unknown";

/**
 * A classified test node plus a runnable handle the agent can pass to a runner.
 */
export interface TestHandle {
  /** The test node id (unchanged from the candidate). */
  id: string;
  /** Test file (repo-relative), or null when the candidate had none. */
  file: string | null;
  /**
   * A runnable handle: for pytest a node id `file::funcName` (or
   * `file::Class::method` when the name is `Class.method`); for vitest/jest the
   * spec FILE path; for go/cargo the file (best-effort). null when not derivable
   * (e.g. no file).
   */
  runnable: string | null;
  /** Runner inferred from language/extension. */
  runner: TestRunner;
}

/**
 * Default PATH patterns that mark a file as a test file. Substring match on the
 * repo-relative path (forward-slash normalized). Config `test.patterns`
 * REPLACES this list when provided.
 *
 * These are the conventions across the five languages Hayven parses: directory
 * markers (`/tests/`, `__tests__/`), filename prefixes (`test_foo.py`), and
 * filename infixes/suffixes (`foo.test.ts`, `foo_test.go`, `foo.spec.ts`). The
 * leading `test/` / `tests/` (handled separately in {@link isTestFile}) catches
 * a path that STARTS with the dir and therefore has no leading slash to match.
 */
export const DEFAULT_TEST_PATH_PATTERNS: readonly string[] = [
  "/test/",
  "/tests/",
  "/__tests__/",
  "_test.",
  "test_",
  ".test.",
  ".spec.",
  "_spec.",
];

/**
 * Normalize a path for pattern matching: backslashes → forward slashes so a
 * Windows-style `daemon\tests\x` matches the same `/tests/` pattern a POSIX
 * path would. Pure string transform; no filesystem access.
 */
function normalizePath(file: string): string {
  return file.replace(/\\/g, "/");
}

/**
 * True when `file` is a test file by PATH. A file matches when any pattern is a
 * substring of the normalized path, OR the path STARTS with `test/` / `tests/`
 * (the no-leading-slash case the `/tests/` substring pattern can't see).
 *
 * `patterns` REPLACES {@link DEFAULT_TEST_PATH_PATTERNS} when provided (verbatim
 * — the caller's config wins), so a project can narrow or widen what counts as
 * a test location without code changes.
 */
function isTestFile(file: string, patterns: readonly string[]): boolean {
  const path = normalizePath(file);
  // Leading-dir case: a repo-relative path like `tests/foo.py` has no leading
  // slash, so the `/tests/` substring never fires — check the prefix directly.
  if (path.startsWith("test/") || path.startsWith("tests/")) return true;
  return patterns.some((p) => path.includes(p));
}

/**
 * Split a possibly-qualified entity name into its candidate segments: the WHOLE
 * name plus its LAST `.`-segment. A graph name may be a bare `foo` or a
 * qualified `Class.method` / `module.Class.method`; the naming conventions below
 * apply to BOTH the qualified head (`TestParser.test_x` → class is `TestParser`)
 * and the leaf method (`test_x`), so we test each.
 */
function nameSegments(name: string): string[] {
  const last = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return last === name ? [name] : [name, last];
}

/** PascalCase: starts with an uppercase letter (a class-shaped name). Used to
 *  distinguish `TestParser` (a test class) from `testParser` (a camelCase fn)
 *  and to gate the pytest `Class::method` runnable shape. */
function isPascalCase(s: string): boolean {
  return /^[A-Z]/.test(s);
}

/**
 * Python/pytest NAME convention: a function `test_*` or a class `Test*`.
 * `test_echo` and `TestParser` both collect; an ordinary `parse` does not.
 */
function isPytestName(seg: string): boolean {
  return seg.startsWith("test_") || /^Test[A-Z0-9_]/.test(seg) || seg === "Test";
}

/**
 * JS/TS NAME convention: a camelCase `test` function (`testFoo`, `test_foo`) or
 * a `*Test` / `*Spec` suffix. WHY the guard: we must NOT match a bare `test`
 * (that's the runner's global, not a named test entity) — only `test` followed
 * by an uppercase letter (`testFoo`) or an underscore (`test_foo`). `describe` /
 * `it` are anonymous callbacks, not named entities, so they never reach here.
 */
function isJsTsName(seg: string): boolean {
  if (/^test[A-Z_]/.test(seg)) return true; // testFoo / test_foo, never bare `test`
  return /(?:Test|Spec)$/.test(seg);
}

/**
 * Go NAME convention: exported `Test*` / `Benchmark*` / `Example*` / `Fuzz*`
 * functions (the four the `go test` runner discovers by name). The trailing
 * char must be uppercase/digit/underscore so a plain `Test`/`Tests` constant or
 * a `Testify` helper still counts as exported-test-shaped, while `testing` does
 * not (lowercase).
 */
function isGoName(seg: string): boolean {
  return /^(?:Test|Benchmark|Example|Fuzz)([A-Z0-9_]|$)/.test(seg);
}

/**
 * Rust NAME convention: a `#[test]` fn carries no naming convention by itself,
 * so Rust leans on PATH match (files under `tests/`). The best NAME signal is a
 * name that starts with `test_` or contains `_test` — caught here for the cases
 * a convention-following author does use.
 */
function isRustName(seg: string): boolean {
  return seg.startsWith("test_") || seg.includes("_test");
}

/**
 * True when `candidate`'s NAME matches any language's test-naming convention.
 * Language-agnostic by design: the impact walk reaches nodes from many
 * languages and a candidate's `language` may be absent, so we OR every
 * predicate over every name segment rather than branching on language. Each
 * predicate is conservative enough that cross-language false positives are
 * negligible (the conventions barely overlap).
 */
function isTestName(name: string): boolean {
  for (const seg of nameSegments(name)) {
    if (
      isPytestName(seg) ||
      isJsTsName(seg) ||
      isGoName(seg) ||
      isRustName(seg)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when `candidate` is a test: its file matches a PATH pattern OR its name
 * matches a test NAME convention. Pure — no `Db`, no filesystem.
 *
 * `patterns` (when provided) REPLACES {@link DEFAULT_TEST_PATH_PATTERNS} for the
 * path leg; the name leg is unaffected (naming conventions are not configurable
 * — they're language facts, not project policy).
 */
export function isTestNode(
  candidate: TestCandidate,
  patterns: readonly string[] = DEFAULT_TEST_PATH_PATTERNS,
): boolean {
  if (candidate.file !== null && isTestFile(candidate.file, patterns)) return true;
  return isTestName(candidate.name);
}

/**
 * The file extension (lowercase, no dot) of a repo-relative path, or "" when
 * there is none. Used only for runner inference, which prefers the extension
 * (a concrete fact) over the candidate's possibly-absent `language`.
 */
function extensionOf(file: string): string {
  const norm = normalizePath(file);
  const slash = norm.lastIndexOf("/");
  const base = slash >= 0 ? norm.slice(slash + 1) : norm;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Infer the test runner from the file extension first, then the candidate's
 * `language` as a fallback (for the `file: null` name-only case).
 *
 * `.py`→pytest; `.ts/.tsx/.js/.jsx`→vitest (this repo's default — jest is
 * name-compatible, so we only pick "jest" when the PATH itself says `jest`);
 * `.go`→go; `.rs`→cargo; otherwise "unknown". The jest-by-path rule keeps the
 * runnable correct for a project that genuinely runs jest without misclassifying
 * the vitest-default majority.
 */
function inferRunner(file: string | null, language: string | null | undefined): TestRunner {
  const ext = file !== null ? extensionOf(file) : "";
  const lang = (language ?? "").toLowerCase();
  const path = file !== null ? normalizePath(file) : "";

  if (ext === "py" || lang === "python") return "pytest";
  if (
    ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx" ||
    lang === "typescript" || lang === "javascript" || lang === "tsx"
  ) {
    // jest is naming/spec-file compatible with vitest; pick it only when the
    // path explicitly says jest, else default to vitest (repo convention).
    return path.includes("jest") ? "jest" : "vitest";
  }
  if (ext === "go" || lang === "go") return "go";
  if (ext === "rs" || lang === "rust") return "cargo";
  return "unknown";
}

/**
 * The qualname LEAF of a runtime/graph name: the final `.`-segment. A name may
 * be a bare `test_x`, a class-qualified `TestFoo.test_x`, or a nested runtime
 * qualname like `test_x.<locals>.cmd`; the leaf is the function/method symbol
 * itself (`test_x`, `cmd`). Mirrors the Python collector's own leaf extraction
 * (`tracer.py::_is_test_node`) so the graph side agrees with the runtime side.
 */
function qualnameLeaf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : name;
}

/**
 * True when a pytest candidate is a REAL, pytest-COLLECTABLE test — i.e. a
 * module-level `test_*` function or a `test_*` method of a `Test*` class — and
 * NOT a function defined *inside* another function (a nested local), which
 * pytest can never collect.
 *
 * WHY this predicate exists (the MEASURED bug it fixes): the `affected-tests`
 * selection reaches its run list through BOTH the static graph and the runtime
 * trace edges. The Python collector ids frames by `<module>:<co_qualname>`
 * (`tracer.py::_node_id`) and the parser captures NESTED `function_definition`
 * nodes too (`queries/python.scm` — "top-level and nested are both captured").
 * So the candidate set legitimately includes things like a command callback
 * `def cmd(): ...` or a helper `def test_callback(): ...` defined INSIDE a real
 * test. pytest CANNOT collect those — `tests/test_commands.py::cmd` (or `::test`)
 * resolves to "not found" and aborts a naive `pytest <nodeid> …` run. We must
 * still COUNT such a node as a test (it lives in a test file and the impact walk
 * reached it), but it is NOT independently runnable, so its `runnable` is nulled.
 *
 * Detection from the only signal we have (`{id, name}`), in reliability order:
 *
 *   1. `.<locals>.` anywhere in the name OR id. This is CPython's own
 *      `co_qualname` marker for a function defined inside another function
 *      (`outer.<locals>.inner`); the trace collector emits it verbatim. `<` and
 *      `>` are not legal Python identifier characters, so this token can ONLY be
 *      the runtime nested-scope marker — zero false positives. This is the
 *      ground-truth nesting signal whenever a runtime qualname is present.
 *
 *   2. A dotted qualname whose HEAD (everything before the leaf) is NOT a
 *      PascalCase test class — i.e. the leaf is qualified by a *function* rather
 *      than a `Test*` class. pytest's only legal dotted form is
 *      `Test<Class>::method`; a head like `test_real` (a function) or any other
 *      lowercase segment means the leaf is nested inside that function, not a
 *      class method. We reuse {@link isPascalCase} on the LAST head segment so a
 *      genuine `TestFoo.test_x` (and even a namespaced `pkg.TestFoo.test_x`)
 *      stays collectable while `test_real.cmd` / `test_real.test_callback` do not.
 *      We check the id's local-path tail too (`<scope>/<module>/<qualname>`), so
 *      a nested qualname surviving only in the id is still caught.
 *
 *   3. The leaf is exactly `test` — a bare `test`-named function. Per the run
 *      contract these are treated as non-collectable (`::test` is the shape that
 *      was observed polluting the list); a real test is `test_*` or a `Test*`
 *      method, never a lone `test`.
 *
 * Conservatism (the explicit design bias): when NONE of these fire we KEEP the
 * runnable. A plain top-level `test_echo` and a class method `TestFoo.test_echo`
 * are both collectable and unaffected. We only ever NULL on a positive nesting
 * signal, so we cannot drop a real test the impact walk legitimately reached.
 *
 * Only pytest distinguishes collectable-by-node-id; vitest/jest/go/cargo select
 * by FILE, so this predicate is pytest-scoped and returns `true` for the others
 * (their file runnable is always valid).
 */
export function isCollectableTest(candidate: TestCandidate): boolean {
  const runner = inferRunner(candidate.file, candidate.language);
  if (runner !== "pytest") return true; // non-pytest runners select by file.

  const { name, id } = candidate;

  // (1) CPython nested-scope marker — definitive, in either field.
  if (name.includes(".<locals>.") || id.includes(".<locals>.")) return false;

  // The qualname we reason about: prefer the explicit `name`; fall back to the
  // id's local-path tail (`<scope>/<module>/<qualname>`) when the name is bare
  // but the id still carries a dotted nested qualname.
  const idTail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;

  // (3) A bare `test` leaf is not a collectable pytest test.
  if (qualnameLeaf(name) === "test" || qualnameLeaf(idTail) === "test") return false;

  // (2) A dotted qualname qualified by a non-`Test*`-class head is nested.
  for (const qual of name === idTail ? [name] : [name, idTail]) {
    const dot = qual.lastIndexOf(".");
    if (dot <= 0) continue; // bare leaf — top-level, collectable.
    // The class candidate is the LAST head segment (`pkg.TestFoo` → `TestFoo`).
    const head = qual.slice(0, dot);
    const headLeaf = head.includes(".") ? head.slice(head.lastIndexOf(".") + 1) : head;
    if (!isPascalCase(headLeaf)) return false; // function-qualified ⇒ nested.
  }

  return true;
}

/**
 * Derive the pytest runnable node id from a `file` + entity `name`. pytest
 * selects by node id `file::func`; for a method named `Class.method` whose class
 * is PascalCase (a real test class, not a `module.func` qualifier) it wants
 * `file::Class::method`. We split on the LAST `.` to get the method and the
 * segment before it as the class.
 */
function pytestRunnable(file: string, name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const cls = name.slice(0, dot);
    const method = name.slice(dot + 1);
    // Only emit the Class::method form for a PascalCase class — a lowercase
    // qualifier (e.g. `module.test_x`) is a namespace, not a pytest class.
    if (isPascalCase(cls)) return `${file}::${cls}::${method}`;
  }
  return `${file}::${name}`;
}

/**
 * Classify a candidate into a {@link TestHandle}, or null when it is not a test.
 * Pure; derives `runner` + `runnable` from the file extension/language.
 *
 * RUNNABLE by runner:
 *   - pytest: a node id (`file::func` / `file::Class::method`) — pytest selects
 *     individual tests by node id.
 *   - vitest/jest/go/cargo: the spec FILE path — these runners select by file,
 *     not symbol, so the file IS the runnable.
 *   - null whenever `file` is null (nothing to hand a runner).
 */
export function classifyTest(
  candidate: TestCandidate,
  patterns: readonly string[] = DEFAULT_TEST_PATH_PATTERNS,
): TestHandle | null {
  if (!isTestNode(candidate, patterns)) return null;

  const runner = inferRunner(candidate.file, candidate.language);
  const file = candidate.file;

  let runnable: string | null;
  if (file === null) {
    runnable = null; // no file → nothing runnable, even for a name-only test
  } else if (runner === "pytest") {
    // A NESTED function (a callback / helper defined inside a real test) is a
    // test-FILE node the impact walk reached, but pytest cannot collect it by
    // node id (`file::cmd` → "not found", aborting a naive run). Keep the node
    // (so counts are unaffected) but null its runnable. See isCollectableTest.
    runnable = isCollectableTest(candidate) ? pytestRunnable(file, candidate.name) : null;
  } else {
    // vitest / jest / go / cargo / unknown: the runner selects by file.
    runnable = file;
  }

  return { id: candidate.id, file, runnable, runner };
}
