/**
 * Task C — the ONE shared test/scaffold predicate (`src/util/test_files.ts`).
 *
 * Two definitions used to exist: a JS/TS-only regex in `db/context_pack.ts` and
 * a partly-overlapping SQL LIKE chain in `db/fts.ts`. This pins the unified
 * behavior across all six indexed languages, and — critically — pins the
 * NEAR-MISSES, because the failure mode of a broadened predicate is
 * over-matching (`contest.ts`, `latest.py`, `attestation.go` are real source and
 * must stay real source).
 *
 * The TS-predicate / SQL-fragment agreement test lives in
 * `dedupe_bc_sql_agreement.test.ts`; that one is the anti-drift guarantee.
 */
import { describe, expect, it } from "bun:test";

import { isScaffoldFile, isTestFile } from "../src/util/test_files.ts";

/** Every path here is a TEST file in some indexed language. */
export const TEST_PATHS: readonly string[] = [
  // JS / TS
  "src/cookie.test.ts",
  "src/cookie.test.tsx",
  "src/cookie.test.mts",
  "src/cookie.test.cjs",
  "src/cookie.spec.js",
  "packages/a/src/router.spec.tsx",
  "__tests__/router.ts",
  "src/__tests__/router.ts",
  // Python
  "test_parser.py",
  "pkg/test_parser.py",
  "pkg/parser_test.py",
  "tests/conftest.py",
  "pkg/tests/conftest.py",
  // Go
  "internal/walk_test.go",
  "walk_test.go",
  // Rust
  "tests/integration.rs",
  "crates/core/tests/integration.rs",
  // The UNDERSCORE forms, adopted from the affected-tests selector's `_test.` /
  // `_spec.` after the divergence audit (tests/win_b_glob_divergence.test.ts).
  // `_test.` is extension-open (Deno/Google-style TS, Rust, Go, Python all use
  // it); `_spec.` was taken for Ruby RSpec ONLY, because elsewhere a `_spec`
  // stem means SPECIFICATION rather than test.
  "src/cookie_test.ts",
  "src/cookie_test.tsx",
  "src/parser_test.rs",
  "spec/foo_spec.rb",
  "spec/models/user_spec.rb",
  "test/user_test.rb",
];

/** Real source that a naive broadening would wrongly capture. */
export const NON_TEST_PATHS: readonly string[] = [
  "src/contest.ts", // contains "test" but not ".test."
  "src/latest.py", // "test.py" suffix, but not "_test.py"
  "src/attestation.go", // "test" inside the stem, no "_test.go"
  "src/manifest.tsx",
  "src/testing.py", // starts with "test" but no "test_" prefix
  "src/protests/handler.py", // "tests/" only as a suffix of "protests/"
  "src/latest/index.ts",
  "src/spectrum.ts", // "spec" without the dots
  "src/testify.go",
  "src/detest.rs",
  "cookie.ts",
  "src/db/context_pack.ts",
  // The blast-radius edge of the adopted `*_test.*` / `*_spec.*` rows. Each of
  // these contains `_test` or `_spec` and must still be real source, because
  // the adopted patterns require a LITERAL dot immediately after.
  "src/latest_test_helpers.go", // `_test` followed by `_`, not `.`
  "src/inspector_spectrum.ts", // `_spec` followed by `t`, not `.`
  "src/greatest_hits.ts",
  "src/protest_utils.py",
  // Deliberately divergent from the affected-tests selector, which DOES call
  // these tests. A `test_`-prefixed Go/Rust file compiles into its package, so
  // it is production source here. See the divergence ledger in
  // `src/util/test_files.ts`.
  "src/test_helpers.go",
  "src/test_util.rs",
  // "spec" as the production noun SPECIFICATION. The shared list took only
  // `*_spec.rb`, so these stay real source even though the selector calls them
  // tests. An extension-open `*_spec.*` would have dropped all four from
  // context packs silently.
  "src/api_spec.ts",
  "src/openapi_spec.py",
  "internal/wire_spec.go",
  "src/protocol_spec.rs",
];

/** Scaffold but NOT a test: bench and mock files. The packer still treats these
 *  as legitimate dependencies; only search ranking demotes them. */
export const SCAFFOLD_ONLY_PATHS: readonly string[] = [
  "bench/agent-nav-eval.ts",
  "daemon/bench/toil-scoreboard.ts",
  "src/api/mocks.ts",
  "mocks.ts",
  "src/api/server.mock.ts",
  "src/mocks/handlers.ts",
  "src/__mocks__/fs.ts",
];

describe("isTestFile — per-language positives", () => {
  for (const p of TEST_PATHS) {
    it(`classifies ${p} as a test`, () => {
      expect(isTestFile(p)).toBe(true);
    });
  }
});

describe("isTestFile — near-miss negatives", () => {
  for (const p of NON_TEST_PATHS) {
    it(`does NOT classify ${p} as a test`, () => {
      expect(isTestFile(p)).toBe(false);
    });
  }
});

describe("isTestFile — the languages the old packer regex missed", () => {
  // Paths the JS/TS-only regex returned FALSE for. They are the behavior change
  // this task ships; pinning them here means a regression to the narrow regex
  // fails loudly instead of quietly re-admitting test noise. (`*.spec.ts` is
  // deliberately absent: the old regex already matched it.)
  const NEWLY_CLASSIFIED = [
    "pkg/test_parser.py",
    "pkg/parser_test.py",
    "internal/walk_test.go",
    "crates/core/tests/integration.rs",
    "tests/conftest.py",
    "src/__tests__/deep/nested.py",
    "src/router.spec.py",
  ];
  for (const p of NEWLY_CLASSIFIED) {
    it(`now classifies ${p} as a test`, () => {
      expect(isTestFile(p)).toBe(true);
    });
  }
});

describe("singular `test/` directories", () => {
  // Added at integration time: `db/test_nodes.ts` has always matched `/test/`,
  // and the shared module disagreeing with it was the exact drift this module
  // exists to end. Maven/Gradle, Ruby, and many JS repos use the singular form.
  for (const p of ["test/foo.py", "src/test/java/A.java", "a/test/b.rb"]) {
    it(`classifies ${p} as a test`, () => {
      expect(isTestFile(p)).toBe(true);
    });
  }
  // The anchoring must still hold: a directory that merely ENDS in "test" is
  // not a test directory.
  for (const p of ["latest/x.ts", "protest/x.ts", "src/attest/y.go"]) {
    it(`does NOT classify ${p} as a test`, () => {
      expect(isTestFile(p)).toBe(false);
    });
  }
});

describe("test vs scaffold are different concepts", () => {
  it("every test file is also scaffold", () => {
    for (const p of TEST_PATHS) {
      expect(isScaffoldFile(p)).toBe(true);
    }
  });

  it("bench and mock files are scaffold but NOT tests", () => {
    for (const p of SCAFFOLD_ONLY_PATHS) {
      expect(isScaffoldFile(p)).toBe(true);
      expect(isTestFile(p)).toBe(false);
    }
  });

  it("real source is neither", () => {
    for (const p of NON_TEST_PATHS) {
      expect(isScaffoldFile(p)).toBe(false);
    }
  });

  it("treats a null/empty path as neither (nothing to classify)", () => {
    expect(isTestFile(null)).toBe(false);
    expect(isTestFile(undefined)).toBe(false);
    expect(isTestFile("")).toBe(false);
    expect(isScaffoldFile(null)).toBe(false);
    expect(isScaffoldFile("")).toBe(false);
  });
});

describe("LIKE underscore escaping is real", () => {
  // `test_%.py` with an UNESCAPED underscore would match `testX.py` because `_`
  // is a LIKE single-character wildcard. This is the single most likely way for
  // the pattern list to silently over-match, so pin it directly.
  it("does not let `_` act as a wildcard", () => {
    expect(isTestFile("testX.py")).toBe(false);
    expect(isTestFile("pkg/testX.py")).toBe(false);
    expect(isTestFile("pkg/walkXtest.go")).toBe(false);
    expect(isTestFile("XXtests__/a.ts")).toBe(false);
    // The adopted `*_test.*` / `*_spec.*` rows each carry an underscore too, so
    // they double the surface for this failure: unescaped, they would match any
    // single character before `test.` / `spec.`.
    expect(isTestFile("src/aXtest.ts")).toBe(false);
    expect(isTestFile("src/aXspec.rb")).toBe(false);
  });
});
