# CI recipe — run only the affected tests, safely

`hayven affected-tests` turns a code change into the set of tests that can be
affected by it. In CI that means: on a typical pull request, run a small fraction
of the suite instead of all of it — **CI-minutes saved = cut-ratio × suite length**
— while a never-miss safety net runs the full suite whenever the selection can't be
trusted.

This is the wedge that grep and embeddings cannot do: it fuses the **static impact
graph** with **runtime trace coverage**, so it catches tests that reach the change
only through dynamic dispatch (which static analysis misses) — measured, not asserted.

## What you get (measured)

On `psf/requests` (a real **62.6 s** suite, v2.32.3, 606 tests), selecting the
affected set per change gave a **median 92.9% wall-clock cut** (low/medium-traffic
changes ~98.7%/~58 s saved; hub utilities ~16%, because a hub's true test set *is*
most of the suite — correctly, not a miss). The durable claim is the **ratio**: on a
30-min suite the same selection saves **~28 min on a low-traffic change**.

The **SAFE tier** (the default here) is the never-miss gate: across three deep-history
Python repos (click / werkzeug / rich, ~73–88 reverted real bugs) it missed **0**
regressions. The **OBSERVED tier** (`tier: observed`) is the minimal fast-fail set —
use it for fail-fast ordering with the full suite as a periodic backstop, not as the
sole gate.

## The two pieces

1. **`ci/hayven-affected-tests.sh`** — a portable (bash-3.2+) selector with the safety
   net. Computes changed files, calls `hayven affected-tests --changed … --json`,
   extracts the runnable test ids, and runs only those — or the full suite on any doubt:
   - the selection command errors, or the index reports stale/cold → **FULL**
   - no changed file maps to an indexed entity (`roots = 0`) → **FULL**
   - a `conftest.py` / `setup.*` / `pyproject.toml` / `requirements*.txt` / `.github/`
     file changed → **FULL** (global blast radius)
   - changed **test files** are always run directly (a new/edited test must execute)
   - empty selection with `FALLBACK=full` → **FULL**
   - **pytest selections are verified against `--collect-only` before running**
     (`COLLECT_CHECK=1`, the default): any selected id pytest cannot collect is
     dropped with a loud note, and if that would drop *everything* (or collection
     itself is unverifiable) the script runs the **FULL** suite instead. WHY: one
     non-collectable id makes pytest exit 4 having run **zero** tests — a red
     build that executed nothing (measured on psf/requests). Set `COLLECT_CHECK=0` to skip the extra collection pass.

2. **`.github/actions/affected-tests/`** — a composite Action wrapping the script for
   GitHub Actions. Inputs: `base-ref`, `hayven`, `tier`, `fallback`, `test-runner`, `run`.

## Runnable hygiene — what is (and is not) a run target

The affected set legitimately contains nodes that are *tests by evidence* but not
*run targets* — the impact walk reaches helper callables in test files and shared
test infrastructure. Those stay in the result with **`runnable: null`** (the JSON
keeps the node; the markdown shows `(no runnable)`), so no information is deleted
— they just never land on a runner's command line. Concretely, a **pytest**
runnable mirrors pytest's *default* collection, nothing wider:

- `test`-prefixed functions, and `test`-prefixed methods on **`Test*`-named**
  classes, in test **modules** (`test_*.py` / `*_test.py`);
- a bare test-module path, or `file::TestClass`, as whole-file/whole-class targets.

Everything else is evidence-only: helper-class callables
(`tests/test_requests.py::RedirectSession::send`), non-test methods on real test
classes (`TestRequests::build_response`), anything in non-test modules
(`tests/conftest.py`, `tests/testserver/server.py`), and nested/local functions.
Each of those was measured aborting a real pytest run ("not found", exit 4, zero
tests executed) before this hygiene existed.

The same rule holds for **vitest/bun** emission: `--runner vitest|bun` command
lines only ever contain real spec *files* — a test detected by NAME alone inside a
non-spec file (`testFoo` in `src/helpers.ts`) is evidence, not a filter arg.

Honest residual: a repo with a custom `python_files`/`python_classes`/
`python_functions` ini (or `unittest.TestCase` subclasses not named `Test*`) is
collectable to pytest but invisible to the name-based hygiene, so those runnables
are nulled and the selection UNDER-reports (the `--collect-only` check can only
drop ids, never restore nulled ones). On such a repo, don't gate CI on the
selection alone — keep the full suite as a periodic backstop (the same advice as
for the `observed` tier) until the hygiene learns to read the ini.

## Prerequisite: populate trace coverage (the one real setup step)

The trace-augmented recall depends on per-test runtime coverage existing in the index.
This is populated by running the suite **once** with the Python collector installed
(the `pip install -e` step is load-bearing — `-p hayven_trace` alone only imports the
package and never starts the tracer):

```sh
pip install -e /path/to/hayvenhurst/trace/python   # registers the pytest11 entrypoint
HAYVEN_TRACE=1 python -m pytest -q                  # one full run populates coverage
hayven init                                         # (or `hayven ingest`) builds the index
```

In CI, do this on the **base branch** (or nightly) and **cache the `.hayven/` index**;
pull requests then query the cached index. Because Hayven is embedding-free and
incremental, the PR side only re-parses the diff — no re-embed, no model.

## GitHub Actions — example PR workflow

Copy this into `.github/workflows/affected-tests.yml` in the **consuming** repo (it
references this repo's composite action; pin to a tag/sha in practice):

```yaml
name: affected-tests
on:
  pull_request:

jobs:
  affected:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0                # the diff needs history

      - name: Install Python + deps
        uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -e . -r requirements-dev.txt

      # Bring in the hayven binary + the index. In practice: download the release
      # binary and restore the .hayven cache keyed on the base SHA.
      - name: Restore hayven index
        uses: actions/cache@v4
        with:
          path: .hayven
          key: hayven-index-${{ github.event.pull_request.base.sha }}
          restore-keys: hayven-index-

      - name: Run affected tests
        uses: Davidb3l/Hayvenhurst-dev/.github/actions/affected-tests@main
        with:
          base-ref: origin/${{ github.event.pull_request.base.ref }}
          hayven: hayven                  # or ./bin/hayven if downloaded locally
          tier: safe                      # never-miss gate
          test-runner: python -m pytest -q
```

If the index cache misses (cold PR), `roots=0`/stale → the script runs the full suite,
so a missing cache degrades to a normal full run, never a silent partial one.

## Plain shell (any CI)

```sh
export BASE_REF=origin/main
export HAYVEN=./bin/hayven
export TEST_RUNNER='python -m pytest -q'
ci/hayven-affected-tests.sh            # selects + runs; full suite on any doubt

RUN=0 ci/hayven-affected-tests.sh      # print the selection only (dry run)
HAYVEN_TIER=observed ci/hayven-affected-tests.sh   # minimal fail-fast set
```

## Vitest / TypeScript recipe (`--runner vitest`)

For a vitest repo you don't need to assemble the command from JSON — `--runner
vitest` emits a **ready-to-paste invocation** for the affected set:

```sh
$ hayven affected-tests --changed src/utils/url.ts --runner vitest
vitest run src/utils/url.test.ts src/middleware/logger.test.ts

# run it directly:
$(hayven affected-tests --changed src/utils/url.ts --runner vitest) || npx vitest run
```

stdout is exactly the command line (notes go to stderr, so it is pipeable);
`--json --runner vitest` instead adds additive `runner`/`runnerArgs`/
`runnerCommand`/`runnerSkippedCount` fields to the unchanged JSON payload.

What it emits, and why:

- **File granularity.** Vitest's positional CLI filters are substring matches
  against test-file *paths* (there is no per-test node-id form; `-t` filters by
  test *name*, which file-level runnables don't carry). Selecting individual
  spec files IS vitest's granularity, so the command lists each affected spec's
  **full repo-relative path** — full paths are unique, which defuses the
  substring gotcha (a bare `router.test.ts` filter would match every
  same-basename router spec in the repo). Residual substring over-match errs
  toward running *more*, never missing.
- **Empty set → empty stdout.** A bare `vitest run` (no filters) runs the WHOLE
  suite, silently inverting the selection — so when the affected set has no
  vitest-runnable tests, nothing is printed and a stderr note says why. Guard
  the empty case in scripts (as in the `|| npx vitest run` fallback above, or
  check the output is non-empty before `eval`).
- **Mixed-runner sets are surfaced, not dropped.** Affected tests on other
  runners (pytest/go/cargo) are excluded from the vitest command with a stderr
  count — run those with their own runner.
- **Quoting is shell-safe.** Paths with spaces or dynamic-route brackets
  (`[id].test.ts`) come single-quoted, so the pasted line survives a real shell.

To populate per-test coverage (the `observed` tier) for a vitest repo, run the
suite once under the collector's vitest entry:

```ts
// vitest.config.ts
export default defineConfig({
  test: { setupFiles: ["@hayvenhurst/trace-bun/vitest"] },
});
```

```sh
HAYVEN_TRACE=1 vitest run    # default parallel forks are fine (fork-safe lifecycle)
```

(An earlier caveat here — "no `observed` tier for vitest; use
`--no-file-parallelism`" — is resolved: the collector's vitest entry emits
per-test-file coverage and its per-file profiler lifecycle + OpenSSL prewarm fix
the parallel-forks wedge. See `trace/bun/README.md`.)

## bun:test recipe (`--runner bun`)

Bun's NATIVE runner gets the same handoff. `--runner bun` emits a
ready-to-paste `bun test <spec files…>` line under the identical contract as
`--runner vitest` (file granularity — bun:test's positional filters are path
substrings too; empty set → empty stdout, never a run-everything bare
`bun test`; mixed-runner tests surfaced on stderr; shell-safe quoting):

```sh
$ hayven affected-tests --changed src/utils/url.ts --runner bun
bun test src/utils/url.test.ts src/middleware/logger.test.ts
```

Graph-side, a `*.test.ts` spec is classified `vitest` (a bun:test spec is
statically indistinguishable from a vitest one), so the flag simply declares
which runner actually executes that file-selected set — pick the one your repo
uses.

To populate per-test coverage for a bun:test repo, run the suite once under the
collector's preload entry (no-op unless `HAYVEN_TRACE=1`):

```sh
HAYVEN_TRACE=1 bun test --preload /path/to/hayvenhurst/trace/bun/bun-test.ts
```

or persistently via `bunfig.toml`:

```toml
[test]
preload = ["@hayvenhurst/trace-bun/bun-test"]
```

Running from a monorepo **subdirectory** (e.g. `apps/api`)? Set
`HAYVEN_TRACE_MODULE_ROOT=/path/to/repo/root` so coverage attribution stays
repo-root-relative (the daemon's index ids are repo-root-relative).

## Safety contract, restated

- **Default tier is SAFE** (static-reachability ∪ trace; recall 1.0 on the measured
  repos). Switch to `observed` only with the full suite as a backstop.
- **Any uncertainty runs the full suite**, never a partial one. The failure mode is
  "we ran too much," never "we missed a test."
- **Run on a real slow suite for real savings.** On a sub-second suite the wall-clock
  delta is noise (and the selection overhead can dominate); the value is on suites
  where the ratio buys real minutes.
