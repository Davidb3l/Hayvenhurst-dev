#!/usr/bin/env bash
#
# bench/rss.sh — measure daemon idle RSS for PRD §16(9) (<50 MB target) and the
# install footprint for §16(1) (~60 MB binaries).
#
# Measures the COMPILED `hayven` binary's daemon at idle and, for comparison,
# the dev `bun src/cli.ts daemon start` path. Spins up a throwaway temp project,
# runs `hayven init`, starts the daemon in the background, lets it settle, and
# samples RSS via `ps -o rss=` a handful of times to find the steady state.
#
# Usage:
#   bench/rss.sh [/path/to/hayven-compiled]
#
# Env:
#   HAYVEN_COMPILED   path to the compiled binary (default: /tmp/hayven-compiled)
#   HAYVEN_NATIVE_BIN path to hayven-native (default: native/target/release/hayven-native)
#   SETTLE_SECS       idle settle time before sampling (default: 8)
#   SAMPLES           number of RSS samples (default: 6)
#   SAMPLE_GAP_SECS   gap between samples (default: 1)
#
# Notes:
#   - RSS is reported in MB (ps gives KB). We report the steady-state (median of
#     the last few samples) plus min/max so spikes are visible.
#   - The reported RSS is the daemon PROCESS only. The native file watcher runs
#     as a separate child process and is reported separately.
#   - RSS is fairly robust to overall machine load; record other heavy procs if
#     you care about reproducibility (the script prints load average).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HAYVEN_COMPILED="${1:-${HAYVEN_COMPILED:-/tmp/hayven-compiled}}"
HAYVEN_NATIVE_BIN="${HAYVEN_NATIVE_BIN:-$REPO_ROOT/native/target/release/hayven-native}"
SETTLE_SECS="${SETTLE_SECS:-8}"
SAMPLES="${SAMPLES:-6}"
SAMPLE_GAP_SECS="${SAMPLE_GAP_SECS:-1}"

export HAYVEN_NATIVE_BIN

if [[ ! -x "$HAYVEN_NATIVE_BIN" ]]; then
  echo "error: native binary not found/executable at $HAYVEN_NATIVE_BIN" >&2
  exit 1
fi

echo "=== bench/rss.sh ==="
echo "compiled binary : $HAYVEN_COMPILED"
echo "native binary   : $HAYVEN_NATIVE_BIN"
echo "load average    : $(uptime | sed 's/.*load average/load average/')"
echo

# --- install footprint (§16(1)) ---
footprint() {
  echo "--- install footprint (§16(1), ~60 MB binaries target) ---"
  local sz_native sz_compiled
  sz_native=$(stat -f%z "$HAYVEN_NATIVE_BIN" 2>/dev/null || stat -c%s "$HAYVEN_NATIVE_BIN")
  printf "  hayven-native : %8.2f MB\n" "$(echo "$sz_native/1048576" | bc -l)"
  if [[ -x "$HAYVEN_COMPILED" ]]; then
    sz_compiled=$(stat -f%z "$HAYVEN_COMPILED" 2>/dev/null || stat -c%s "$HAYVEN_COMPILED")
    printf "  hayven        : %8.2f MB\n" "$(echo "$sz_compiled/1048576" | bc -l)"
    printf "  combined      : %8.2f MB\n" "$(echo "($sz_native+$sz_compiled)/1048576" | bc -l)"
  else
    echo "  hayven        : (compiled binary not found at $HAYVEN_COMPILED; skipping)"
  fi
  echo "  model weights : NOT counted — separate pull (PRD §16(1) excludes them)"
  echo
}

# Sample RSS (KB->MB) of a pid SAMPLES times, print each and the steady state.
sample_rss() {
  local pid="$1" label="$2"
  local vals=()
  for ((i = 0; i < SAMPLES; i++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "  [$label] pid $pid died during sampling" >&2
      return 1
    fi
    local kb
    kb=$(ps -o rss= -p "$pid" | tr -d ' ')
    vals+=("$kb")
    printf "  [%s] sample %d: %6.1f MB\n" "$label" "$((i + 1))" "$(echo "$kb/1024" | bc -l)"
    sleep "$SAMPLE_GAP_SECS"
  done
  # steady state = median of the last half of samples
  local half=$((SAMPLES / 2))
  ((half < 1)) && half=1
  local tail_vals=("${vals[@]: -$half}")
  IFS=$'\n' sorted=($(sort -n <<<"${tail_vals[*]}")); unset IFS
  local mid=$((${#sorted[@]} / 2))
  local steady=${sorted[$mid]}
  printf "  [%s] STEADY-STATE RSS: %6.1f MB\n" "$label" "$(echo "$steady/1024" | bc -l)"
}

# Run one daemon measurement.
#   $1 = label, $2.. = command to start the daemon (run in $TMPDIR_PROJ)
measure_daemon() {
  local label="$1"; shift
  local tmp
  tmp="$(mktemp -d "/tmp/hayven-bench-$label.XXXXXX")"
  echo "--- $label daemon idle RSS (§16(9), <50 MB target) ---"
  echo "  temp project: $tmp"

  # minimal project so init has something to detect/ingest
  ( cd "$tmp" && git init -q . && printf 'fn main() {}\n' > main.rs )

  # init (quietly)
  ( cd "$tmp" && "$@" init >/dev/null 2>&1 ) || {
    echo "  init failed" >&2; rm -rf "$tmp"; return 1; }

  # start daemon in background
  ( cd "$tmp" && exec "$@" daemon start ) >"$tmp/daemon.log" 2>&1 &
  local launcher=$!

  # wait for pidfile
  local pidfile="$tmp/.hayven/daemon.pid" pid="" tries=0
  while [[ ! -f "$pidfile" && $tries -lt 100 ]]; do sleep 0.1; tries=$((tries+1)); done
  if [[ -f "$pidfile" ]]; then pid="$(tr -d ' \n' < "$pidfile")"; fi
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    echo "  daemon did not come up; log tail:" >&2; tail -5 "$tmp/daemon.log" >&2
    kill "$launcher" 2>/dev/null || true; rm -rf "$tmp"; return 1
  fi

  echo "  daemon pid: $pid (settling ${SETTLE_SECS}s at idle)"
  sleep "$SETTLE_SECS"
  sample_rss "$pid" "$label" || true

  # native watcher children (separate processes, reported for completeness)
  local kids
  kids=$(pgrep -P "$pid" 2>/dev/null || true)
  if [[ -n "$kids" ]]; then
    for k in $kids; do
      local kkb; kkb=$(ps -o rss= -p "$k" 2>/dev/null | tr -d ' ' || echo 0)
      local kcmd; kcmd=$(ps -o comm= -p "$k" 2>/dev/null || echo "?")
      printf "  [%s] child pid %s (%s): %5.1f MB (separate process)\n" \
        "$label" "$k" "$(basename "$kcmd")" "$(echo "$kkb/1024" | bc -l)"
    done
  fi

  # stop + clean
  ( cd "$tmp" && "$@" daemon stop >/dev/null 2>&1 ) || kill "$pid" 2>/dev/null || true
  sleep 0.5; kill "$launcher" 2>/dev/null || true
  rm -rf "$tmp"
  echo
}

footprint
measure_daemon "compiled" "$HAYVEN_COMPILED"
measure_daemon "bun-dev"  "bun" "$REPO_ROOT/daemon/src/cli.ts"

echo "Target §16(9): <50 MB idle RSS.  Target §16(1): ~60 MB combined binaries."
