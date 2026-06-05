#!/usr/bin/env bash
# wedge-demo — the 60-second "is it actually faster?" demo for a prospect/user.
#
# Clones a real repo (default: honojs/hono), then times Hayvenhurst's cold index,
# its cheap branch switch (re-parse only the git diff), and its instant cached
# revisit — using the SAME embedding-free parser + SQLite the product ships. No
# model, no GPU, no vector store, nothing leaves the machine. Prints a side-by-side
# contrast against the published embedding-based baseline (cocoindex-code `ccc`).
#
# Usage:
#   bench/wedge-demo.sh                       # hono
#   bench/wedge-demo.sh https://github.com/gin-gonic/gin
#   bench/wedge-demo.sh /path/to/your/repo    # a local checkout works too
#
# Requires: a built native binary. From the repo root:
#   ( cd native && cargo build --release )
#   bun install
set -euo pipefail

REPO_ARG="${1:-https://github.com/honojs/hono}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root
BIN="${HAYVEN_NATIVE_BIN:-$HERE/native/target/release/hayven-native}"

if [[ ! -x "$BIN" ]]; then
  echo "✗ native binary not found at: $BIN"
  echo "  build it first:  ( cd native && cargo build --release )"
  echo "  or set HAYVEN_NATIVE_BIN to your built binary."
  exit 1
fi
export HAYVEN_NATIVE_BIN="$BIN"

# Resolve the target repo: a local dir is used as-is; a URL is shallow-cloned.
if [[ -d "$REPO_ARG/.git" ]]; then
  TARGET="$REPO_ARG"
  echo "▶ using local repo: $TARGET"
else
  TARGET="$(mktemp -d)/repo"
  echo "▶ cloning $REPO_ARG (shallow) …"
  git clone --depth 50 -q "$REPO_ARG" "$TARGET"
fi

echo
echo "════════════════════════════════════════════════════════════════════"
echo " Hayvenhurst — embedding-free index (no model, no GPU, no vector DB)"
echo "════════════════════════════════════════════════════════════════════"
bun "$HERE/bench/branch-switch-cost.ts" "$TARGET" 3

cat <<'EOF'

────────────────────────────────────────────────────────────────────
 For contrast — an embedding-based indexer (cocoindex-code `ccc`) on the
 same repo class (an embedding-based indexer needs a model + a vector store):
   cold index:                 35.6 s   (embeds the repo)
   revisit a seen branch:      0.41 s   (re-syncs + re-embeds the diff again)
 Hayvenhurst pays neither tax: the index is a parse + a SQLite write, so a
 cold index is sub-second, a cached branch revisit is ~1 ms, and your code
 never leaves the machine — and the index is exact + deterministic.
────────────────────────────────────────────────────────────────────
EOF
