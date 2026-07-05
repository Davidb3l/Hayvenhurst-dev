#!/usr/bin/env bash
#
# hayven-affected-tests.sh — run only the tests a change can affect, with a
# NEVER-MISS safety net. Drop-in for any CI (GitHub Actions, GitLab, Jenkins).
#
# It computes the changed files from a git diff, asks `hayven affected-tests`
# for the tests that reach those changes, and runs ONLY those — but it falls
# back to the FULL suite whenever it cannot be SURE the selection is complete.
# The economic claim is RATIO × your suite length: on a typical low/medium-
# traffic change the selection is a small fraction of the suite (measured median
# ~93% time-cut on psf/requests' 62.6 s suite — see bench/affected-tests-RESULTS.md),
# while hub utilities correctly pull most of the suite.
#
# SAFETY CONTRACT (why this is safe to gate CI on):
#   - SAFE tier by default (the static-reachability ∪ trace set; recall 1.0 across
#     the measured repos) — never the minimal `observed` tier unless you opt in.
#   - Any uncertainty => run the FULL suite, never a partial one:
#       * selection command errors or the index is stale       -> FULL
#       * NO changed file maps to an indexed entity (roots = 0) -> FULL
#       * a conftest.py / config / dependency file changed      -> FULL
#       * empty selection with fallback=full                    -> FULL
#   - Changed TEST files are ALWAYS run directly (a new/edited test must execute,
#     even if nothing in the graph "reaches" it yet).
#
# Exit code is the test runner's own (or 0 when there is nothing to run).
#
# ── Configuration (env vars) ────────────────────────────────────────────────
#   BASE_REF      git ref to diff against         (default: origin/main)
#   HAYVEN        path to the hayven binary        (default: hayven)
#   HAYVEN_TIER   safe | observed                  (default: safe  = never-miss)
#   FALLBACK      full | none                      (default: full  = run all on doubt)
#   TEST_RUNNER   command to run tests             (default: python -m pytest -q)
#   RUN           1 = run tests, 0 = print only    (default: 1)
#   TEST_GLOB     egrep pattern for "is a test file" so changed tests run directly
#                 (default: pytest-style test_*.py / *_test.py / tests/ dirs)
#   ALWAYS_FULL_GLOB  egrep pattern that forces a FULL run when matched
#                 (default: conftest.py, setup/pyproject/requirements, CI config)
#   COLLECT_CHECK 1 = intersect the pytest selection with `--collect-only` ids
#                 before running (defense-in-depth against non-collectable ids:
#                 ONE bad id makes pytest exit 4 having run ZERO tests — measured
#                 on psf/requests, bench/requests-ci-RESULTS.md). Applied only
#                 when TEST_RUNNER looks like pytest and RUN=1. 0 = skip.
#                 (default: 1)
#
# Usage:
#   BASE_REF=origin/main TEST_RUNNER='python -m pytest -q' ci/hayven-affected-tests.sh
#   RUN=0 ci/hayven-affected-tests.sh        # just print the selection
#
set -uo pipefail

BASE_REF="${BASE_REF:-origin/main}"
HAYVEN="${HAYVEN:-hayven}"
HAYVEN_TIER="${HAYVEN_TIER:-safe}"
FALLBACK="${FALLBACK:-full}"
TEST_RUNNER="${TEST_RUNNER:-python -m pytest -q}"
RUN="${RUN:-1}"
TEST_GLOB="${TEST_GLOB:-(^|/)(test_[^/]*\.py|[^/]*_test\.py)$|(^|/)tests?/}"
ALWAYS_FULL_GLOB="${ALWAYS_FULL_GLOB:-(^|/)conftest\.py$|(^|/)(setup\.py|setup\.cfg|pyproject\.toml|tox\.ini|requirements[^/]*\.txt|pytest\.ini)$|(^|/)\.github/}"
COLLECT_CHECK="${COLLECT_CHECK:-1}"

log() { printf '[hayven-affected] %s\n' "$*" >&2; }

run_set() {
  # $1 = human reason, remaining args = test ids ("" => full suite)
  local reason="$1"; shift
  if [ "$#" -eq 0 ]; then
    log "$reason -> running FULL suite (safety)"
    [ "$RUN" = 1 ] || { echo "(full suite)"; exit 0; }
    # shellcheck disable=SC2086
    exec $TEST_RUNNER
  fi
  log "$reason -> running ${#} selected test(s)"
  printf '%s\n' "$@"
  [ "$RUN" = 1 ] || exit 0
  # shellcheck disable=SC2086
  exec $TEST_RUNNER "$@"
}

# 0. Need a JSON parser that's guaranteed present wherever pytest runs.
if ! command -v python3 >/dev/null 2>&1; then
  log "python3 not found (needed to parse the selection JSON)"
  [ "$FALLBACK" = full ] && run_set "no json parser"
  exit 1
fi

# 1. Changed files vs BASE_REF.
changed="$(git diff --name-only "$BASE_REF...HEAD" 2>/dev/null || git diff --name-only "$BASE_REF" 2>/dev/null || true)"
if [ -z "$changed" ]; then
  log "no changed files vs $BASE_REF — nothing to test"
  exit 0
fi

# 2. Force a FULL run on global-impact changes (conftest/config/deps/CI).
if printf '%s\n' "$changed" | grep -Eq "$ALWAYS_FULL_GLOB"; then
  run_set "a global-impact file changed (conftest/config/deps)"
fi

# 3. Changed test files always run directly. (Portable read — no bash-4 mapfile.)
changed_tests=()
while IFS= read -r line; do [ -n "$line" ] && changed_tests+=("$line"); done \
  < <(printf '%s\n' "$changed" | grep -E "$TEST_GLOB" || true)

# 4. Ask hayven for the affected tests (SAFE tier unless opted out).
csv="$(printf '%s\n' "$changed" | paste -sd, -)"
flags=(--changed "$csv" --json)
[ "$HAYVEN_TIER" = observed ] && flags+=(--trace-only)

json="$("$HAYVEN" affected-tests "${flags[@]}" 2>/dev/null)"
if [ -z "$json" ]; then
  [ "$FALLBACK" = full ] && run_set "selection command produced no output"
  log "selection failed and FALLBACK=none"; exit 1
fi

# 5. Parse roots / note / runnables. roots=0 means NO changed file matched an
#    indexed entity -> we cannot vouch for completeness -> FULL.
read -r roots note < <(printf '%s' "$json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
roots = d.get("roots") or []
note = (d.get("note") or "").replace(" ", "_") or "-"
print(len(roots), note)
' 2>/dev/null || echo "ERR -")

if [ "$roots" = "ERR" ]; then
  [ "$FALLBACK" = full ] && run_set "could not parse selection JSON"
  log "unparseable JSON and FALLBACK=none"; exit 1
fi

# A stale index is a safety problem: the selection was computed against old code.
case "$note" in
  *stale*|*cold*) run_set "index note='$note' (possibly stale)";;
esac

if [ "$roots" = "0" ]; then
  # Nothing in the diff resolved to an indexed symbol. If the only changes were
  # test files we can still just run those; otherwise we don't know what's hit.
  if [ "${#changed_tests[@]}" -gt 0 ] && \
     [ "$(printf '%s\n' "$changed" | grep -Evc "$TEST_GLOB")" = "0" ]; then
    run_set "only changed test files (nothing else indexed)" "${changed_tests[@]}"
  fi
  run_set "no changed file mapped to an indexed entity (roots=0)"
fi

selected=()
while IFS= read -r line; do [ -n "$line" ] && selected+=("$line"); done < <(printf '%s' "$json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for t in d.get("tests", []):
    r = t.get("runnable")
    if r:
        print(r)
' 2>/dev/null)

# 6. Union selected ∪ changed-test-files (dedup, preserve order; bash-3.2 safe).
union=()
for id in "${selected[@]+"${selected[@]}"}" "${changed_tests[@]+"${changed_tests[@]}"}"; do
  [ -z "$id" ] && continue
  case " ${union[*]-} " in *" $id "*) ;; *) union+=("$id");; esac
done

if [ "${#union[@]}" -eq 0 ]; then
  [ "$FALLBACK" = full ] && run_set "empty selection"
  log "empty selection and FALLBACK=none — nothing to run"; exit 0
fi

# 7. DEFENSE-IN-DEPTH (pytest only): intersect the selection with what pytest
#    can ACTUALLY collect before running it. One non-collectable id ("not
#    found") makes pytest exit 4 having run ZERO tests — a red build that
#    executed nothing (measured on psf/requests: 4–11 such ids per change,
#    bench/requests-ci-RESULTS.md "Product gap found"). The selector now nulls
#    those runnables at the source; this guard keeps the recipe safe against
#    any residual id anyway. A selected id survives when it exactly matches a
#    collected id (params stripped) or is a FILE/CLASS prefix of one; if the
#    intersection would drop EVERYTHING while the selection was non-empty, we
#    do NOT run the empty set — we fall back to the FULL suite, loudly.
if [ "$COLLECT_CHECK" = 1 ] && [ "$RUN" = 1 ] && \
   printf '%s' "$TEST_RUNNER" | grep -q 'pytest'; then
  # The collection call needs verbosity EXACTLY -1 (`-q`) to print node ids —
  # a TEST_RUNNER that already carries `-q` would stack to `-qq`, whose output
  # is per-FILE counts (no `::` node ids, unmatchable). Strip quiet flags from
  # the runner tokens and add our own single `-q`.
  collect_cmd=()
  for tok in $TEST_RUNNER; do
    case "$tok" in -q|-qq|--quiet) ;; *) collect_cmd+=("$tok");; esac
  done
  collected="$("${collect_cmd[@]}" --collect-only -q 2>/dev/null)" || collected=""
  if [ -z "$collected" ] || ! printf '%s' "$collected" | grep -q '::'; then
    # No output, or no node ids in it (e.g. an ini `addopts = -q` re-stacking
    # quietness): we cannot verify the selection — never risk an exit-4 run.
    [ "$FALLBACK" = full ] && run_set "pytest --collect-only yielded no node ids (cannot verify the selection)"
    log "collect-only unverifiable and FALLBACK=none"; exit 1
  fi
  verified=()
  while IFS= read -r line; do [ -n "$line" ] && verified+=("$line"); done < <(
    printf '%s' "$collected" | python3 -c '
import sys
collected = set()
for line in sys.stdin.read().splitlines():
    line = line.strip()
    if "::" not in line:
        continue                      # summary/blank lines
    collected.add(line.split("[", 1)[0])  # strip [param] -> base node id
for s in sys.argv[1:]:
    # exact node id, or a file/class PREFIX of a collected id (a bare test-file
    # path or file::TestClass runs everything collected under it — valid).
    if s in collected or any(c.startswith(s + "::") for c in collected):
        print(s)
' "${union[@]}" 2>/dev/null
  )
  dropped=$(( ${#union[@]} - ${#verified[@]} ))
  if [ "${#verified[@]}" -eq 0 ]; then
    # Non-empty selection, nothing collectable: the selection is unusable.
    # NEVER pass it to pytest (exit 4, zero tests run) — full suite instead.
    [ "$FALLBACK" = full ] && run_set "selection had ${#union[@]} id(s) but NONE are pytest-collectable"
    log "uncollectable selection and FALLBACK=none"; exit 1
  fi
  if [ "$dropped" -gt 0 ]; then
    log "collect-only check dropped $dropped non-collectable id(s) (kept ${#verified[@]})"
  fi
  union=("${verified[@]}")
fi

run_set "tier=$HAYVEN_TIER, $(printf '%s\n' "$changed" | grep -c . | tr -d ' ') changed file(s)" "${union[@]}"
