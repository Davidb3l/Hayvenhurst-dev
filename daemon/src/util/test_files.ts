/**
 * ONE source of truth for "is this path test/bench/mock scaffolding?".
 *
 * Consumers need this answer through two different MECHANISMS:
 *
 *   - `db/pack_neighbors.ts` and `db/imported_symbol.ts` need a TypeScript
 *     predicate (they filter graph neighbors in memory: a call or import edge
 *     that resolves into a test file is an ambiguous-name mis-resolution, not a
 *     real dependency).
 *   - `db/fts.ts` needs a SQL fragment (its `isScaffold` search-ranking penalty
 *     is computed inside the re-rank query, per matched row).
 *
 * Those two used to be hand-written separately and had already drifted: the
 * packer's regex covered JS/TS only, so Python/Go/Rust test files were treated
 * as real source, while fts's LIKE chain covered a different, partly
 * overlapping set. The fix is not "copy one into the other" — they cannot share
 * a mechanism. Instead BOTH are GENERATED from the single pattern list below,
 * so a pattern added here reaches both consumers or neither.
 *
 * The pattern language is SQL `LIKE`, because it is the strictly less
 * expressive of the two: anything expressible as a LIKE pattern can be compiled
 * down to an equivalent JS RegExp, but not the reverse. Patterns are authored
 * in a tiny glob DSL ({@link likePattern}) where `*` is the only wildcard and
 * every other character — notably `_`, which is a LIKE single-char wildcard —
 * is escaped to a literal. That is load-bearing: an unescaped `test_%.py` would
 * also match `testX.py`.
 *
 * Two related but NON-identical concepts live here, and callers must pick the
 * one matching their intent:
 *
 *   - {@link isTestFile} — tests only. This is the packer's question ("source
 *     never legitimately depends on a test").
 *   - {@link isScaffoldFile} — tests UNION bench UNION mocks. This is fts's
 *     question ("this file is scaffolding around the implementation, so demote
 *     it below the implementation").
 */

/** Every indexed language's test conventions, plus bench and mock scaffolding.
 *  Authored in the {@link likePattern} glob DSL: `*` is the ONLY wildcard. */
const TEST_GLOBS: readonly string[] = [
  // JS / TS (and their .mjs/.cjs/.tsx/.mts variants — the extension is left
  // open by the trailing `*` rather than enumerated, so a new variant needs no
  // change here). `*.test.*` requires the literal dots, so `contest.ts` and
  // `manifest.tsx` do NOT match.
  "*.test.*",
  "*.spec.*",
  "__tests__/*",
  "*/__tests__/*",

  // The UNDERSCORE twin of `*.test.*`, adopted from the affected-tests
  // selector's `_test.` substring. Cross-language and extension-open, because a
  // `_test` SUFFIX names the file after the thing it tests in every language we
  // index: `go test` compiles `*_test.go` only into the test binary,
  // Deno/Google-style TS uses `foo_test.ts`, and a Rust `parser_test.rs` is the
  // near-universal shape of a `#[cfg(test)] mod parser_test`. Note the contrast
  // with the `test_` PREFIX two blocks down, which is NOT shared: a `_test`
  // suffix reads "tests OF parser", while a `test_` prefix reads "helpers FOR
  // tests" (`test_util.rs`, `test_helpers.go`) and those are ordinary source.
  // That asymmetry, not the toolchain, is what justifies sharing one and not
  // the other.
  //
  // This SUBSUMES the former `*_test.py` and `*_test.go` rows, which are gone
  // rather than duplicated. The literal dot is what keeps the near-misses out:
  // `attestation.go`, `detest.rs`, `walkXtest.go` have no `_test.` at all, and
  // even `latest_test_helpers.go` misses, because the character after `_test`
  // there is `_`, not `.`.
  //
  // KNOWN RESIDUAL FALSE POSITIVE: a production file whose stem ends in the
  // NOUN "test" — `src/ab_test.ts` (A/B testing feature code) is the realistic
  // one. Accepted, because the alternative shapes (`load_test`, `smoke_test`,
  // `unit_test`) really are tests and enumerating extensions would not exclude
  // `ab_test.ts` anyway. If this bites, narrow by stem, not by extension.
  "*_test.*",

  // Ruby RSpec, and deliberately `.rb`-ONLY where the dotted `*.spec.*` above is
  // extension-open. `_spec` does NOT generalize the way `_test` does: outside
  // Ruby, "spec" is production vocabulary for SPECIFICATION, so an
  // extension-open `*_spec.*` swallows `src/api_spec.ts`, `src/openapi_spec.py`,
  // `internal/wire_spec.go` and `src/protocol_spec.rs` — all real source, all
  // then silently dropped from context packs. The JS/TS test convention is the
  // dotted `foo.spec.ts`, which `*.spec.*` already covers, so restricting to
  // `.rb` costs only the legacy Jasmine `foo_spec.js` shape. That leaves
  // `src/cookie_spec.ts` divergent from the selector on purpose; see the ledger.
  "*_spec.rb",

  // Python's PREFIX convention, and deliberately Python-ONLY. pytest's default
  // `python_files` makes `test_*.py` a genuine test MODULE, so it is scaffolding
  // to the packer too. No cross-language `test_*` row exists on purpose: outside
  // Python a `test_`-prefixed file (`src/test_helpers.go`, `src/test_util.rs`)
  // is ordinary source that merely SUPPORTS tests — the Go and Rust compilers
  // build it into the package, so the packer is right to inline it. The escaped
  // underscore keeps `testing.py` out (it needs a literal `test_`).
  "test_*.py",
  "*/test_*.py",

  // Rust (`tests/` integration-test dir), Python (`tests/` package), and the
  // many JS/Go repos that also use a top-level `tests/`. Both the repo-root
  // form and the nested form. `protests/foo.py` does NOT match: the leading
  // pattern is anchored and the nested one needs a literal `/tests/`.
  "tests/*",
  "*/tests/*",

  // Singular `test/`: Maven/Gradle (`src/test/java`), Ruby, and a large share of
  // JS repos. Added at integration time because `db/test_nodes.ts` (the
  // affected-tests selector, which answers the different question "can the test
  // runner run this file") has always matched `/test/`, and the two disagreeing
  // was the exact drift this module exists to end. `latest/x.ts` does NOT match:
  // the nested pattern needs a literal `/test/` and the root form is anchored.
  "test/*",
  "*/test/*",
];

/**
 * THE DIVERGENCE LEDGER: what this list deliberately does NOT take from
 * `db/test_nodes.ts::DEFAULT_TEST_PATH_PATTERNS`.
 *
 * That list is the affected-tests selector's, and it answers a different
 * question ("can the test runner RUN this file?"). The two were compared
 * mechanically over a corpus spanning every indexed language plus Ruby and Java
 * (`tests/win_b_glob_divergence.test.ts`, which PINS the result, so a future
 * edit to either list that changes the divergence set fails loudly). Every
 * remaining difference below is a decision, not an accident:
 *
 *   - BARE `test_` (unanchored substring). NOT adopted. It is a substring test
 *     with nothing before it, so it fires on `src/greatest_hits.ts`,
 *     `src/protest_utils.py`, `src/attest_helpers.go` and
 *     `src/latest_test_helpers.go` — all real source. The anchored Python rows
 *     above (root and nested `test_*.py`) exist precisely to get the Python
 *     convention without that. The selector can afford the false positives, its
 *     detection is an intentional UNION with NAME conventions and its run list
 *     is filtered again downstream; the packer cannot, because a false positive
 *     here silently DELETES a real dependency from a context pack.
 *
 *   - The selector matching `src/test_helpers.go` / `src/test_util.rs` as tests.
 *     NOT adopted, same reason stated at the `test_*.py` rows: a `test_` PREFIX
 *     names a helper FOR tests, which is ordinary source the packer must keep
 *     inlining, unlike the `_test` SUFFIX which names the file as tests.
 *
 *   - `_spec.` on any extension but `.rb`. PARTIALLY adopted only. The selector
 *     calls `src/cookie_spec.ts` and `src/openapi_spec.py` tests; the shared
 *     list takes just `*_spec.rb`, because "spec" is production vocabulary for
 *     SPECIFICATION outside Ruby. The selector can hold the wider form for the
 *     same reason it holds bare `test_`.
 *
 * ONE PROPERTY THAT SURPRISES READERS: none of these patterns are
 * basename-anchored. `*` compiles to SQL `%`, which matches `/` as well, so a
 * DIRECTORY whose name contains `.test.` / `_test.` marks everything beneath it
 * (`fixtures/repo_test.d/src/main.go` is a test file to this list). That was
 * already true of `*.test.*` before any of this and is left alone; the glob DSL
 * has no way to say "basename only", and the shapes it costs us are rare.
 *
 * And one difference that ran the OTHER way and was fixed on the selector's
 * side rather than here: a REPO-ROOT `__tests__/router.ts` was a test to this
 * list and not to the selector, whose `/__tests__/` substring needs a leading
 * slash. See the prefix check in `db/test_nodes.ts::isTestFile`.
 */

/** Benchmark scaffolding. Distinct from tests: a bench file is real source that
 *  exercises the implementation, so the packer still treats it as a legitimate
 *  dependency, but search must not rank it above the implementation. */
const BENCH_GLOBS: readonly string[] = ["bench/*", "*/bench/*"];

/** Mock scaffolding. A test mock (`api/mocks.ts` `mockNeighbors`) must not
 *  outrank the real implementation (`walkNeighbors`) in search. Covers
 *  `mocks.ts`, `foo.mock.ts`, `mocks/` dirs, and jest's `__mocks__/`. */
const MOCK_GLOBS: readonly string[] = [
  "*/mocks.*",
  "mocks.*",
  "*.mock.*",
  "*/mocks/*",
  "*/__mocks__/*",
];

/** The LIKE escape character used by every generated pattern and every emitted
 *  `ESCAPE` clause. Backslash never appears literally in a repo-relative path
 *  we index, so it costs nothing as an escape. */
const LIKE_ESCAPE = "\\";

/**
 * Compile one glob-DSL pattern into a SQL `LIKE` pattern.
 *
 * `*` becomes `%`; `\`, `%` and `_` become escaped literals. Escaping `_` is
 * the whole reason this helper exists rather than raw LIKE strings: `_` is a
 * LIKE wildcard, and every Python/Go test convention we match contains one.
 */
function likePattern(glob: string): string {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += "%";
    else if (ch === "\\" || ch === "%" || ch === "_") out += LIKE_ESCAPE + ch;
    else out += ch;
  }
  return out;
}

/**
 * Compile one SQL `LIKE` pattern into the equivalent anchored RegExp.
 *
 * LIKE matches the WHOLE string, hence `^…$`. `%` is any run, `_` is exactly
 * one character, and `LIKE_ESCAPE` makes the next character a literal.
 *
 * The `i` flag faithfully mirrors SQLite's default LIKE, which folds ASCII only:
 * the RegExp is built WITHOUT the `u` flag, so ECMA-262 canonicalization refuses
 * any fold whose input is >= U+0080 and whose result is < U+0080. U+212A KELVIN
 * therefore does not match `k` here, exactly as in SQLite. Adding `u` would
 * break that equivalence.
 *
 * Two LIKE constructs are currently UNREACHABLE because {@link likePattern}
 * escapes every `_` and the globs contain no bare wildcards beyond `*`:
 *   - a bare `_` maps to `[\s\S]`, one UTF-16 code UNIT, whereas SQLite counts
 *     one character (an astral-plane path character would disagree),
 *   - a pattern ending in a lone escape is an error in SQLite.
 * The second is rejected outright below; the first is documented rather than
 * solved, since solving it costs a flag that would break the case-folding match
 * above. Anyone authoring a pattern with a real single-char wildcard must
 * revisit both.
 */
function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === LIKE_ESCAPE) {
      if (i + 1 >= pattern.length) {
        throw new Error(`LIKE pattern ends with a dangling escape: ${pattern}`);
      }
      out += escapeRegExp(pattern[++i]!);
    } else if (ch === "%") {
      out += "[\\s\\S]*";
    } else if (ch === "_") {
      out += "[\\s\\S]";
    } else {
      out += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${out}$`, "i");
}

function escapeRegExp(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** The LIKE patterns for each concept, derived once at module load. */
const TEST_LIKE = TEST_GLOBS.map(likePattern);
const SCAFFOLD_LIKE = [...TEST_GLOBS, ...BENCH_GLOBS, ...MOCK_GLOBS].map(likePattern);

/** The RegExps for the SAME lists. Same input, two mechanisms — this is the
 *  anti-drift guarantee: nothing here reads a second pattern source. */
const TEST_RE = TEST_LIKE.map(likeToRegExp);
const SCAFFOLD_RE = SCAFFOLD_LIKE.map(likeToRegExp);

/**
 * Whether `file` is a test file in ANY language Hayven indexes.
 *
 * Used by the packer's neighbor filter: source never legitimately *depends on*
 * a test, so a call edge resolving into one is noise (an ambiguous-name
 * mis-resolution) and that neighbor is dropped when the target is real source.
 * A null/empty path is never a test (there is nothing to classify).
 */
export function isTestFile(file: string | null | undefined): boolean {
  if (!file) return false;
  return TEST_RE.some((re) => re.test(file));
}

/**
 * Whether `file` is scaffolding: a test file, a bench file, or a mock.
 *
 * Strictly wider than {@link isTestFile}. Search ranking asks this question,
 * but through SQL, so it calls {@link scaffoldFileSqlPredicate} rather than this
 * predicate: no production caller uses the TS form today. It is exported as the
 * TS half of the agreement test, which is what proves the two mechanisms agree.
 */
export function isScaffoldFile(file: string | null | undefined): boolean {
  if (!file) return false;
  return SCAFFOLD_RE.some((re) => re.test(file));
}

/** A SQL identifier we are willing to interpolate into a generated fragment:
 *  a bare name or one level of `alias.column`. Everything else throws. The
 *  patterns themselves are module-private literals with no quote characters,
 *  so a validated column is the only remaining interpolation and there is no
 *  injection surface: no caller-supplied VALUE ever reaches the SQL text. */
const SQL_COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function likeChain(column: string, patterns: readonly string[], indent: string): string {
  if (!SQL_COLUMN_RE.test(column)) {
    throw new Error(`unsafe SQL column reference: ${JSON.stringify(column)}`);
  }
  // SQL string literals do NOT use backslash escaping (only `''` for a quote),
  // so the ESCAPE literal is the escape character verbatim. Doubling it here
  // yields a two-character literal and SQLite rejects it outright.
  const esc = `'${LIKE_ESCAPE}'`;
  // PARENTHESIZED: this is an OR chain, and `OR` binds looser than `AND`. A
  // caller who writes `WHERE x = 1 AND ${fragment}` would otherwise get a
  // silently wrong predicate with no SQL error. The current call site
  // (`CASE WHEN … THEN 1 ELSE 0 END`) does not need the parens; every future one
  // might.
  const chain = patterns
    .map((p, i) => {
      // A pattern containing a quote would break out of the literal. None do,
      // and none can without editing this file, but assert it rather than
      // trusting a future edit.
      if (p.includes("'")) throw new Error(`unquotable LIKE pattern: ${p}`);
      const lead = i === 0 ? "" : `${indent}   OR `;
      return `${lead}${column} LIKE '${p}' ESCAPE ${esc}`;
    })
    .join("\n");
  return `(${chain})`;
}

/**
 * A parameter-free SQL boolean fragment that is true when `column` holds a test
 * file path, generated from the same list as {@link isTestFile}.
 *
 * `indent` is the whitespace prefixed to each continuation line so the emitted
 * chain lines up inside the caller's query text; it affects formatting only.
 *
 * NO PRODUCTION CALLER TODAY: the only SQL consumer (fts) wants the scaffold
 * variant. It is exported so the agreement test can prove BOTH concepts compile
 * to matching SQL and TS, which is what stops the two mechanisms drifting. Keep
 * it even while unused; deleting it would leave the test-only concept unproven.
 */
export function testFileSqlPredicate(column: string, indent = ""): string {
  return likeChain(column, TEST_LIKE, indent);
}

/**
 * A parameter-free SQL boolean fragment that is true when `column` holds a
 * test, bench, or mock path — the SQL twin of {@link isScaffoldFile}.
 */
export function scaffoldFileSqlPredicate(column: string, indent = ""): string {
  return likeChain(column, SCAFFOLD_LIKE, indent);
}

/** The compiled LIKE pattern lists, exported for the TS/SQL agreement test.
 *  Not intended for production callers — use the predicates above. */
export const _internal = {
  TEST_LIKE,
  SCAFFOLD_LIKE,
  likePattern,
  likeToRegExp,
} as const;
