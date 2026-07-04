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
  /** Node kind (`function`/`method`/`module`/…). A `module` node is the test
   *  FILE, not a `::`-addressable test — its runnable is the file, never
   *  `file::<module-name>` (which no runner can collect). Optional so existing
   *  callers keep working; absent = treated as a non-module symbol. */
  kind?: string | null;
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
 * True when `file` is a file pytest's DEFAULT collection would discover as a
 * test module: basename `test_*.py` or `*_test.py` (pytest's default
 * `python_files`). This is deliberately a LANGUAGE FACT, not project policy, so
 * it is NOT driven by the configurable `test.patterns` (which control test
 * *detection*, i.e. what counts as a test node — a wider net by design).
 *
 * WHY (the MEASURED bug, bench/requests-ci-RESULTS.md "Product gap found"):
 * detection's wide net legitimately classifies nodes in `tests/conftest.py`
 * and `tests/testserver/server.py` as test nodes (they live under `/tests/`,
 * the impact walk reaches them), but pytest cannot RUN them —
 * `tests/testserver/server.py::Server::run` → "not found", exit 4, ZERO tests
 * executed; a bare `tests/conftest.py` arg collects nothing. Such nodes stay in
 * the affected set as graph EVIDENCE (`runnable: null`), they just stop being
 * run targets.
 *
 * Residual honesty note: a repo with a CUSTOM `python_files` ini wider than the
 * default would have its extra test modules nulled here — the CI recipe's
 * `--collect-only` intersection + full-suite fallbacks are the safety net for
 * that (docs/CI_AFFECTED_TESTS.md).
 */
export function isPytestCollectableFile(file: string): boolean {
  const norm = normalizePath(file);
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  return /^test_.*\.py$/.test(base) || /^.+_test\.py$/.test(base);
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
 *   4. POSITIVE collection shape (the requests-measured fix,
 *      bench/requests-ci-RESULTS.md "Product gap found"): the id must mirror
 *      what pytest's DEFAULT collection actually discovers —
 *        - the file is a pytest test module (`test_*.py` / `*_test.py`,
 *          {@link isPytestCollectableFile}) — excludes `conftest.py`,
 *          `tests/testserver/server.py`, …;
 *        - the LEAF is `test`-prefixed (pytest's default `python_functions`
 *          prefix, so `test_x` AND `testX` both keep working) OR is itself a
 *          `Test*` class name (a `file::TestClass` arg pytest collects whole);
 *        - a dotted `Class.method` qualname requires a `Test*`-NAMED class
 *          (pytest's default `python_classes`), not merely PascalCase — a
 *          helper class in a test file (`RedirectSession.send`) and a non-test
 *          method on a real test class (`TestRequests.build_response`) are
 *          both "not found" to pytest and MUST NOT be emitted as run targets.
 *      Checks 1–3 null on positive NESTING signals; check 4 additionally
 *      requires the id to be positively test-shaped, because the measured
 *      failure mode was helper callables that carried no nesting signal at all
 *      (they aborted real CI runs with exit 4 and ZERO tests executed).
 *
 * A nulled runnable never DELETES information: the node stays in the affected
 * set as graph evidence (`runnable: null`), it just stops being a run target.
 * Residual honesty note: a `unittest.TestCase` subclass NOT named `Test*` (or a
 * custom `python_classes`/`python_functions` ini) is collectable to pytest but
 * invisible to this name-only predicate — those runnables are nulled; the CI
 * recipe's full-suite fallbacks cover them (docs/CI_AFFECTED_TESTS.md).
 *
 * Only pytest distinguishes collectable-by-node-id; vitest/jest/go/cargo select
 * by FILE, so this predicate is pytest-scoped and returns `true` for the others
 * (their file runnable is always valid).
 */
export function isCollectableTest(candidate: TestCandidate): boolean {
  const runner = inferRunner(candidate.file, candidate.language);
  if (runner !== "pytest") return true; // non-pytest runners select by file.

  const { name, id } = candidate;

  // (4a) Only a pytest test MODULE yields node-id-runnable tests. conftest.py /
  // testserver helpers are evidence, never run targets.
  if (candidate.file !== null && !isPytestCollectableFile(candidate.file)) return false;

  // (1) CPython nested-scope marker — definitive, in either field.
  if (name.includes(".<locals>.") || id.includes(".<locals>.")) return false;

  // The qualname we reason about: prefer the explicit `name`; fall back to the
  // id's local-path tail (`<scope>/<module>/<qualname>`) when the name is bare
  // but the id still carries a dotted nested qualname.
  const idTail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;

  // (3) A bare `test` leaf is not a collectable pytest test.
  if (qualnameLeaf(name) === "test" || qualnameLeaf(idTail) === "test") return false;

  // (2) A dotted qualname qualified by a non-`Test*`-class head is nested (a
  // function-scoped local) — and per (4c) a merely-PascalCase HELPER class
  // (`RedirectSession`) is not a pytest class either: the head must be
  // `Test*`-named, mirroring pytest's default `python_classes`.
  for (const qual of name === idTail ? [name] : [name, idTail]) {
    const dot = qual.lastIndexOf(".");
    if (dot <= 0) continue; // bare leaf — top-level; leaf shape checked in (4b).
    // The class candidate is the LAST head segment (`pkg.TestFoo` → `TestFoo`).
    const head = qual.slice(0, dot);
    const headLeaf = head.includes(".") ? head.slice(head.lastIndexOf(".") + 1) : head;
    if (!isPascalCase(headLeaf)) return false; // function-qualified ⇒ nested.
    if (!/^Test/.test(headLeaf)) return false; // helper class ⇒ pytest won't collect it.
  }

  // (4b) The LEAF itself must be test-shaped: a `test`-prefixed function/method
  // (pytest's default `python_functions` prefix) or a `Test*` class node (a
  // whole-class run target). `TestRequests.build_response` fails here — the
  // class is real but the METHOD is not a test, so pytest reports "not found".
  const qual = name.includes(".") ? name : idTail.includes(".") ? idTail : name;
  const leaf = qualnameLeaf(qual);
  if (!/^test/.test(leaf) && !/^Test/.test(leaf)) return false;

  return true;
}

/**
 * Derive the pytest runnable node id from a `file` + entity `name` + node `id`.
 * pytest selects by node id `file::func`; for a method of a `Test*` class it wants
 * `file::Class::method`.
 *
 * The class qualifier is recovered from the richest qualname available: a dotted
 * `name` (`TestFoo.test_x`) when the parser carried it, ELSE the id's local tail
 * (`<scope>/<module>/<qualname>` → `TestRequests.test_content_…`). The fallback is
 * load-bearing for CLASS-BASED test suites (unittest-style `class TestX:` — common
 * in requests/Django): there the node `name` is just the BARE method, so a
 * name-only derivation emitted `file::test_x` (MISSING the class), which pytest
 * cannot collect — the test silently never runs (a real product bug + a spurious
 * affected-tests "miss"). We take the LAST head segment as the class and emit the
 * `Class::method` form only when it's PascalCase (a real class, not a `module.`
 * namespace).
 */
function pytestRunnable(file: string, name: string, id: string): string {
  const idTail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  // Prefer a dotted `name`; fall back to the dotted id tail (carries the class
  // when `name` is the bare method).
  const qual = name.includes(".") ? name : idTail.includes(".") ? idTail : name;
  const dot = qual.lastIndexOf(".");
  if (dot > 0) {
    const head = qual.slice(0, dot);
    const method = qual.slice(dot + 1);
    // The class is the LAST head segment (`pkg.TestFoo` → `TestFoo`); emit the
    // Class::method form only for a PascalCase class, not a lowercase namespace.
    const cls = head.includes(".") ? head.slice(head.lastIndexOf(".") + 1) : head;
    if (isPascalCase(cls)) return `${file}::${cls}::${method}`;
  }
  return `${file}::${name}`;
}

/**
 * Derive the `go test` runnable handle from a `file` + entity `name`.
 *
 * WHY this exists (the MEASURED gap, bench/affected-tests-RESULTS.md "Go"): until
 * now a Go test node's runnable was just its FILE (`command_test.go`), so the
 * agent had no way to run the ONE affected test — it had to run the whole file.
 * Go's per-test coverage (trace/go/coverage.go) now gives a high-precision
 * `observed` tier; this makes that tier ACTIONABLE by emitting a `-run`-shaped
 * handle so the agent can run exactly the affected test.
 *
 * Form (mirrors pytest's `file::func`, kept parseable): `file::TestName`, where
 * `TestName` is the test FUNCTION name a `go test -run '^TestName$'` would select.
 * The graph `name` is the bare function (`TestExecute`) for a top-level test, or a
 * receiver-qualified `(*Suite).TestThing` for a method — we take the leaf via
 * {@link qualnameLeaf} (after stripping a receiver group) so the `-run` target is
 * the actual test symbol. When the name isn't a Go test shape (a reached helper in
 * a `_test.go` file), we keep the FILE handle — `go test` selects that helper's
 * package by file, and there is no single `-run` target for it.
 */
function goRunnable(file: string, name: string): string {
  const leaf = qualnameLeaf(name);
  // Only emit the per-test `-run` handle for a real Go test function name; a
  // reached non-test helper has no `-run` target, so the file remains its handle.
  return isGoName(leaf) ? `${file}::${leaf}` : file;
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
  } else if (candidate.kind === "module") {
    // A MODULE node is the test FILE, not a `::`-addressable test. Its name is
    // the module stem (`test_http`), so the naive pytest handle would be
    // `tests/test_http.py::test_http` — which pytest reports "not found" and,
    // fatally, aborts an ENTIRE `pytest <ids…>` run when passed alongside real
    // tests (measured: it silently zero'd a 170-test affected set). Run the file
    // instead — valid for pytest AND the file-selecting runners. For pytest the
    // file must ITSELF be a collectable test module: a `tests/conftest.py` /
    // `tests/testserver/server.py` module node is graph evidence, not a run
    // target (the requests-measured bare-file-path bug — bench/requests-ci-
    // RESULTS.md "Product gap found" class 2).
    runnable = runner === "pytest" && !isPytestCollectableFile(file) ? null : file;
  } else if (runner === "pytest") {
    // A NESTED function (a callback / helper defined inside a real test), a
    // helper-class callable (`RedirectSession.send`), a non-test method on a
    // real Test* class (`TestRequests.build_response`), or ANY callable in a
    // non-test-module file (`tests/testserver/server.py`) is a node the impact
    // walk legitimately reached, but pytest cannot collect it by node id
    // (`file::cmd` → "not found", exit 4, ZERO tests run — measured on
    // psf/requests). Keep the node (so counts/evidence are unaffected) but null
    // its runnable. See isCollectableTest.
    runnable = isCollectableTest(candidate) ? pytestRunnable(file, candidate.name, candidate.id) : null;
  } else if (runner === "go") {
    // go: per-test `-run` handle (`file::TestName`) when the name is a Go test
    // function, else the file (a reached `_test.go` helper has no `-run` target).
    // Makes the high-precision per-test `observed` tier actionable (the affected
    // test is runnable as `go test -run '^TestName$'`, not the whole file).
    runnable = goRunnable(file, candidate.name);
  } else if (runner === "vitest" || runner === "jest") {
    // vitest / jest select by FILE — but only a file that IS a test/spec file
    // (by the same PATH patterns detection uses) is a valid spec filter. A node
    // detected as a test by NAME alone (`testFoo` in `src/helpers.ts`) would
    // otherwise leak a NON-spec path into the emitted `vitest run <files…>` /
    // `bun test <files…>` line — the same bug class as the pytest one (and a
    // lone non-spec filter makes vitest exit "no test files found"). Keep the
    // node as evidence; null the runnable.
    runnable = isTestFile(file, patterns) ? file : null;
  } else {
    // go (non-test-shape fallback handled above) / cargo / unknown: the runner
    // selects by file.
    runnable = file;
  }

  return { id: candidate.id, file, runnable, runner };
}
