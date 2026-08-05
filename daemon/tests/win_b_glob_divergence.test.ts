/**
 * THE DIVERGENCE LEDGER, executable.
 *
 * Two "is this a test file?" definitions exist on purpose and answer different
 * questions:
 *   - `util/test_files.ts::TEST_GLOBS` — "is this scaffolding the packer must
 *     not inline and search must not rank as implementation?"
 *   - `db/test_nodes.ts::DEFAULT_TEST_PATH_PATTERNS` — "can the test runner RUN
 *     this file?"
 * They must be free to disagree, and the review finding this test answers is
 * that nobody had DECIDED which disagreements were intentional. So rather than
 * asserting the two agree (they must not) or eyeballing the lists, this
 * evaluates BOTH over a corpus spanning every indexed language plus the Ruby and
 * Java conventions that show up in real repos, and PINS the exact set of paths
 * where they differ.
 *
 * That pin is the point. Any future edit to either list which changes what the
 * two disagree about fails here with the specific paths named, forcing the next
 * author to make the same decision consciously instead of inheriting a diff.
 * Adding a path to the corpus that lands in neither list changes nothing;
 * adding one that lands in exactly one is a decision and must be recorded below.
 */
import { describe, expect, it } from "bun:test";

import { DEFAULT_TEST_PATH_PATTERNS, isTestNode } from "../src/db/test_nodes.ts";
import { isTestFile } from "../src/util/test_files.ts";

/**
 * The selector's PATH leg in isolation. `isTestNode` is a UNION of path and
 * NAME conventions, and only the PATH leg is comparable with the shared list,
 * so every candidate here carries a name (`parse`) that no naming convention
 * matches. That keeps a divergence attributable to the pattern lists rather
 * than to `isTestName`.
 */
function selectorSaysTest(file: string): boolean {
  return isTestNode({ id: "n1", name: "parse", file });
}

/** Realistic paths across every indexed language, plus Ruby and Java, plus the
 *  near-misses whose whole job is to stay negative on BOTH sides. */
const CORPUS: readonly string[] = [
  // JS / TS, dotted and underscore forms, and the nested/root dir forms.
  "src/cookie.test.ts",
  "src/cookie.spec.ts",
  "src/cookie_test.ts",
  "src/cookie_test.tsx",
  "src/cookie_spec.ts",
  "src/cookie.test.mts",
  "__tests__/router.ts",
  "src/__tests__/router.ts",
  "test/foo.js",
  "tests/e2e.ts",
  // Python.
  "test_parser.py",
  "pkg/test_parser.py",
  "pkg/parser_test.py",
  "tests/conftest.py",
  "src/test_helpers.py",
  // Go.
  "internal/walk_test.go",
  "walk_test.go",
  "src/test_helpers.go",
  // Rust.
  "tests/integration.rs",
  "crates/core/tests/integration.rs",
  "src/parser_test.rs",
  "src/test_util.rs",
  // Ruby (RSpec + minitest) and Java (Maven/Gradle).
  "spec/foo_spec.rb",
  "spec/models/user_spec.rb",
  "test/user_test.rb",
  "app/models/user.rb",
  "src/test/java/A.java",
  "src/main/java/FooTest.java",
  // Near-misses. Every one of these is real source and the interesting failure
  // mode of any widening is capturing one of them.
  "latest/x.ts",
  "protest/x.ts",
  "src/contest.ts",
  "src/attestation.go",
  "src/testing.py",
  "src/detest.rs",
  "src/spectrum.ts",
  "src/testify.go",
  "src/manifest.tsx",
  "src/latest.py",
  "src/protests/handler.py",
  "src/db/context_pack.ts",
  "src/greatest_hits.ts",
  "src/inspector_spectrum.ts",
  "src/latest_test_helpers.go",
  "src/protest_utils.py",
  "src/attest_helpers.go",
  "src/mytest_thing.py",
  "testX.py",
  "pkg/walkXtest.go",
  // "spec" as the production noun SPECIFICATION. These are why the shared list
  // took only `*_spec.rb` and not an extension-open `*_spec.*`.
  "src/api_spec.ts",
  "src/openapi_spec.py",
  "internal/wire_spec.go",
  "src/protocol_spec.rs",
];

/**
 * The pinned ledger: every path where the two definitions differ, with the
 * DECISION that keeps it that way. Nothing may differ that is not listed here,
 * and nothing listed here may stop differing, without a deliberate edit.
 */
const EXPECTED_DIVERGENCE: ReadonlyArray<{
  path: string;
  shared: boolean;
  selector: boolean;
  why: string;
}> = [
  {
    path: "src/test_helpers.go",
    shared: false,
    selector: true,
    why: "Go compiles a test_-prefixed file into the package, so it is production source to the packer while still being worth reaching as a runnable-adjacent node.",
  },
  {
    path: "src/test_util.rs",
    shared: false,
    selector: true,
    why: "Same as the Go case: rustc builds it into the crate, so the packer must keep inlining it.",
  },
  {
    path: "src/greatest_hits.ts",
    shared: false,
    selector: true,
    why: "Collateral of the selector's UNANCHORED bare `test_` substring. A false positive the selector tolerates (union detection, re-filtered downstream) and the packer must never take, since there it would delete a real dependency.",
  },
  {
    path: "src/protest_utils.py",
    shared: false,
    selector: true,
    why: "Same unanchored `test_` collateral.",
  },
  {
    path: "src/attest_helpers.go",
    shared: false,
    selector: true,
    why: "Same unanchored `test_` collateral.",
  },
  {
    path: "src/mytest_thing.py",
    shared: false,
    selector: true,
    why: "Same unanchored `test_` collateral.",
  },
  {
    path: "src/latest_test_helpers.go",
    shared: false,
    selector: true,
    why: "Same unanchored `test_` collateral, and the exact path that proves adopting bare `test_` into the shared list would be wrong.",
  },
  {
    path: "src/cookie_spec.ts",
    shared: false,
    selector: true,
    why: "The shared list adopted `_spec` for Ruby ONLY. Outside Ruby the dotted `foo.spec.ts` is the test convention and a `_spec` stem usually means SPECIFICATION, so sharing the wide form would swallow real source.",
  },
  {
    path: "src/api_spec.ts",
    shared: false,
    selector: true,
    why: "The concrete cost of a wider `_spec` rule: an API specification module, real source, which an extension-open `*_spec.*` would silently drop from context packs.",
  },
  {
    path: "src/openapi_spec.py",
    shared: false,
    selector: true,
    why: "Same specification-not-test collision, in Python.",
  },
  {
    path: "internal/wire_spec.go",
    shared: false,
    selector: true,
    why: "Same specification-not-test collision, in Go.",
  },
  {
    path: "src/protocol_spec.rs",
    shared: false,
    selector: true,
    why: "Same specification-not-test collision, in Rust.",
  },
];

describe("shared TEST_GLOBS vs the affected-tests selector", () => {
  it("differs on exactly the pinned set of paths, and no others", () => {
    const actual = CORPUS.filter((p) => isTestFile(p) !== selectorSaysTest(p)).sort();
    const expected = EXPECTED_DIVERGENCE.map((d) => d.path).sort();
    expect(actual).toEqual(expected);
  });

  it("each pinned divergence still runs in the recorded direction", () => {
    for (const d of EXPECTED_DIVERGENCE) {
      expect({ path: d.path, shared: isTestFile(d.path), selector: selectorSaysTest(d.path) }).toEqual({
        path: d.path,
        shared: d.shared,
        selector: d.selector,
      });
    }
  });

});

describe("the accepted costs of the adopted globs, recorded not hidden", () => {
  // These are the known false positives of `*_test.*`. They are pinned so the
  // cost is visible and so a future narrowing shows up here as a change rather
  // than as a silent improvement nobody notices.
  it("captures a production stem ending in the NOUN test", () => {
    expect(isTestFile("src/ab_test.ts")).toBe(true);
  });

  it("is not basename-anchored: a _test. DIRECTORY marks everything beneath it", () => {
    // `*` compiles to SQL `%`, which matches `/` too. Already true of `*.test.*`
    // before `*_test.*` was added; the glob DSL cannot express "basename only".
    expect(isTestFile("fixtures/repo_test.d/src/main.go")).toBe(true);
    expect(isTestFile("fixtures/repo.test.d/src/main.go")).toBe(true);
  });
});

describe("the conventions the shared list ADOPTED from the selector", () => {
  // `_test.` (all extensions) and `_spec.` (Ruby only) used to be selector-only.
  // These are real test files in languages Hayven indexes, and treating them as
  // production source meant the packer inlined them and search ranked them as
  // implementation. Every path here must FAIL if the corresponding glob is
  // removed, so `test/user_test.rb` is deliberately absent: it already matched
  // via the pre-existing `test/*` glob and would prove nothing about adoption.
  const NEWLY_SHARED = [
    "src/cookie_test.ts",
    "src/cookie_test.tsx",
    "src/parser_test.rs",
    "spec/foo_spec.rb",
    "spec/models/user_spec.rb",
  ];
  for (const p of NEWLY_SHARED) {
    it(`both definitions now agree ${p} is a test`, () => {
      expect(isTestFile(p)).toBe(true);
      expect(selectorSaysTest(p)).toBe(true);
    });
  }

  // The adopted patterns require a LITERAL dot after `_test` / `_spec`. These
  // are the paths that would fall in if that dot were dropped or if the
  // underscore stopped being escaped in the LIKE pattern.
  const STILL_NEGATIVE = [
    "src/latest_test_helpers.go",
    "src/inspector_spectrum.ts",
    "src/spectrum.ts",
    "src/attestation.go",
    "src/detest.rs",
    "pkg/walkXtest.go",
    "src/greatest_hits.ts",
    "src/contest.ts",
    "src/testify.go",
    "src/manifest.tsx",
    // The `_spec`-means-specification family, which an extension-open
    // `*_spec.*` would have captured.
    "src/api_spec.ts",
    "src/openapi_spec.py",
    "internal/wire_spec.go",
    "src/protocol_spec.rs",
  ];
  for (const p of STILL_NEGATIVE) {
    it(`${p} is still real source to the shared list`, () => {
      expect(isTestFile(p)).toBe(false);
    });
  }
});

describe("the selector's repo-root __tests__ gap is closed", () => {
  // This ran the OTHER way: the shared list said test, the selector did not,
  // because its `/__tests__/` pattern needs a leading slash a repo-root path
  // does not have. Fixed on the selector side.
  it("matches a repo-root __tests__ directory", () => {
    expect(selectorSaysTest("__tests__/router.ts")).toBe(true);
    expect(isTestFile("__tests__/router.ts")).toBe(true);
  });

  it("still matches the nested form, and still normalizes backslashes", () => {
    expect(selectorSaysTest("src/__tests__/router.ts")).toBe(true);
    expect(selectorSaysTest("__tests__\\router.ts")).toBe(true);
  });

  it("does not match a directory that merely ends in __tests__", () => {
    expect(selectorSaysTest("XX__tests__/a.ts")).toBe(false);
  });
});

describe("the selector's pattern list is untouched by this work", () => {
  // The adopted conventions moved INTO the shared list only: no pattern was
  // added here, because this list is user-overridable config surface.
  //
  // HONESTY NOTE: the list is unchanged but selector BEHAVIOR is not. The
  // `__tests__/` prefix added above flows through isTestNode into classifyTest's
  // vitest/jest branch, so a repo-root `__tests__/x.ts` now emits a runnable
  // into the `vitest run <files…>` line where it previously emitted null. That
  // is the intended fix, not a side effect, but it does mean a CI run can select
  // files it did not select before.
  it("is still the exact agreed list", () => {
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
