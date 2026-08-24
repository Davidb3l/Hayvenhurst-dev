#!/bin/sh
# install-hayven.sh — download + install the platform-correct `hayven` (and
# `hayven-native`) binaries from a Hayvenhurst GitHub Release.
#
# WHY this exists: the Claude Code plugin is git-based, so installing the
# plugin only clones the repo's text files (the Agent Skill). It does NOT
# deliver the compiled `hayven` CLI / `hayven-native` binary — those are
# platform-specific and large, and are deliberately NOT committed to git.
# Claude Code has no native "ship a binary with a plugin" mechanism that
# fits that constraint (the plugin `bin/` directory only exposes executables
# already committed to the plugin repo). So this script is the realistic
# bridge: detect the OS/arch, map to the matching release tarball asset
# (mirroring .github/workflows/release.yml's platform matrix), download it,
# verify its sha256 against the published `<tarball>.sha256`, and install the
# binaries into a known location.
#
# Idempotent + safe to re-run. POSIX sh: macOS, Linux, and Windows under Git
# Bash / MSYS2 / Cygwin (windows-x64 only; the binaries carry a `.exe` suffix
# there). The windows-x64 tarball has shipped with every release all along —
# only the `uname -s` detection below refused it. For a native Windows shell use
# install-hayven.ps1 beside this script: same asset, same checksum verification,
# no POSIX layer required.
#
# Usage:
#   install-hayven.sh                 # download + install latest release
#   install-hayven.sh --check         # print status only; never downloads
#                                     #   exit 0 if `hayven` is on PATH or
#                                     #   already installed, 3 if missing
#   install-hayven.sh --version vX.Y.Z   # install a specific tag
#   install-hayven.sh --prefix DIR    # install into DIR/bin (default below)
#
# Environment:
#   HAYVEN_INSTALL_PREFIX   override the install prefix (same as --prefix)
#   HAYVEN_RELEASE_TAG      pin a release tag (same as --version)
#   HAYVEN_REPO             override owner/repo (default Davidb3l/Hayvenhurst-dev)

set -eu

REPO="${HAYVEN_REPO:-Davidb3l/Hayvenhurst-dev}"
TAG="${HAYVEN_RELEASE_TAG:-}"
# HOME may be unset or empty (launchd/systemd, some CI runners, slim
# containers). Under `set -u` a bare `$HOME` ABORTS the script at expansion
# time — so this hook, which SessionStart runs in every repo, died before
# printing anything instead of reporting install status. Resolve it ONCE and
# tolerate absence; only the install path genuinely needs a real home, and it
# says so below rather than silently installing into `/.local/bin`.
HOME_DIR="${HOME:-}"
# Default install prefix: ${CLAUDE_PLUGIN_DATA} when invoked by the plugin
# (persists across plugin updates), else ~/.local. We install binaries into
# <prefix>/bin.
DEFAULT_PREFIX="${HAYVEN_INSTALL_PREFIX:-${CLAUDE_PLUGIN_DATA:-${HOME_DIR:+$HOME_DIR/.local}}}"
PREFIX="$DEFAULT_PREFIX"
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --version)
      [ -n "${2:-}" ] || { echo "install-hayven: --version needs a tag (e.g. v0.0.5)" >&2; exit 2; }
      TAG="$2"; shift ;;
    --prefix)
      [ -n "${2:-}" ] || { echo "install-hayven: --prefix needs a directory" >&2; exit 2; }
      PREFIX="$2"; shift ;;
    --help|-h)
      sed -n '2,35p' "$0"
      exit 0
      ;;
    *) echo "install-hayven: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '%s\n' "$*" >&2; }
fail() { log "install-hayven: error: $*"; exit 1; }

# With no HOME and no explicit prefix there is no defensible install location.
# Say so instead of letting BIN_DIR resolve to `/bin` and writing there.
if [ -z "$PREFIX" ]; then
  [ "$MODE" = "check" ] || fail "cannot determine an install prefix (HOME is unset/empty). Pass --prefix <dir> or set HAYVEN_INSTALL_PREFIX."
  # --check has nothing to inspect, but `have hayven` still answers the real
  # question. A path that cannot exist keeps the `-x` tests false without
  # printing a plausible-looking but wrong location at the user.
  PREFIX="/nonexistent-hayven-prefix"
fi
BIN_DIR="$PREFIX/bin"

# ---- platform detection → release asset name -------------------------------
# Mirrors the matrix in .github/workflows/release.yml:
#   linux-x64-glibc  linux-arm64  macos-x64  macos-arm64  windows-x64
# Tarball asset name: hayvenhurst-<version>-<platform>.tar.gz
#   (version = tag with the leading "v" stripped)
detect_platform() {
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"
  case "$uname_s" in
    Linux)  os="linux" ;;
    Darwin) os="macos" ;;
    # Git Bash reports MINGW64_NT-10.0-26200, MSYS2 reports MSYS_NT-*, Cygwin
    # CYGWIN_NT-*. All three are Windows hosts running the same PE binaries, so
    # they all map to the windows-x64 asset that every release already ships.
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) fail "unsupported OS '$uname_s' (this script covers macOS, Linux, and Windows under Git Bash / MSYS2 / Cygwin)" ;;
  esac
  case "$uname_m" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) fail "unsupported CPU arch '$uname_m'" ;;
  esac
  # windows-x64 is the ONLY Windows target in the release matrix — there is no
  # windows-arm64 tarball to fall back to, so say that instead of 404ing later.
  if [ "$os" = "windows" ] && [ "$arch" != "x64" ]; then
    fail "unsupported Windows CPU arch '$uname_m' (the release matrix publishes windows-x64 only).
        On Windows-on-ARM, run this from an x64 shell — the x64 build runs under emulation."
  fi
  # The only x64 Linux release is the glibc build; musl is not a release target.
  if [ "$os" = "linux" ] && [ "$arch" = "x64" ]; then
    PLATFORM="linux-x64-glibc"
  else
    PLATFORM="${os}-${arch}"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---- host shape (needed BEFORE detect_platform) -----------------------------
# --check inspects $BIN_DIR and prints the PATH hint without ever calling
# detect_platform, and on Windows the installed binaries are `hayven.exe` /
# `hayven-native.exe`. So resolve the two host facts every mode needs — the
# executable suffix and "is this Windows" — up front, from `uname -s` alone.
# EXE is appended to every binary name below; on macOS/Linux it is empty and
# every path collapses back to exactly what it was.
IS_WINDOWS=0
EXE=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1; EXE=".exe" ;;
esac

# ---- suite awareness --------------------------------------------------------
# Hayvenhurst is the code graph of a four-tool suite: Ametrite holds the task
# board, Sirius Forester runs the foreman loop, Catryna Wikinelli keeps the
# living docs. One short nudge, only when something is missing — full fleet
# control needs all four.
#
# suite_repo: true when the cwd already uses any suite tool. The SessionStart
# --check runs in EVERY repo; the nudge stays quiet outside suite repos so it
# never nags unrelated projects.
suite_repo() {
  # HOME IS NEVER A SUITE REPO. `$HOME/.hayven` is the GLOBAL config dir
  # (registry, writer id, logs), so a bare `[ -d .hayven ]` answers "yes, a
  # project" whenever a session starts in the home dir. That exact conflation,
  # in this same SessionStart hook family, is what let a daemon index the user's
  # entire home tree for six hours. Here it currently only gates a stderr nudge
  # — but it is one behavior change away from being load-bearing again, so it
  # gets the same guard as `ensure-daemon.sh`.
  #
  # Guard on HOME being set AND non-empty first: under `set -u` an unset HOME
  # aborts at expansion time, and `cd ""` SUCCEEDS and stays put, so an empty
  # HOME would make `$(cd "$HOME" && pwd -P)` return the CURRENT dir and the
  # equality hold everywhere. Empty/unset HOME shows up under launchd/systemd,
  # some CI runners, and slim containers; there we cannot identify home, so skip
  # the home check rather than disabling the function everywhere.
  if [ -n "$HOME_DIR" ] && [ -d "$HOME_DIR" ]; then
    [ "$(pwd -P)" != "$(cd "$HOME_DIR" && pwd -P)" ] || return 1
  fi
  # .docs/ alone is too generic a name; require Catryna's index file.
  [ -d .sirius ] || [ -d .ametrite ] || [ -d .hayven ] || [ -f .docs/_index.json ]
}

suite_hint() {
  s_missing=""
  have amt    || s_missing="$s_missing Ametrite"
  have sirius || s_missing="$s_missing Sirius"
  # Prefix match: catryna installs as `catryna@<marketplace>` and there are two
  # legitimate marketplaces (its own `catryna-wikinelli`, and the Sothis bundle
  # `sirius-forester`). Pinning one key nags bundle users forever.
  grep -qs '"catryna@' "${HOME_DIR:-/nonexistent}/.claude/plugins/installed_plugins.json" \
    || s_missing="$s_missing Catryna"
  if [ -z "$s_missing" ]; then return 0; fi
  log ""
  log "fleet suite: missing:$s_missing. Hayvenhurst is the suite's code graph; for full fleet control install the whole suite:"
  case "$s_missing" in *Sirius*)   log "  Sirius Forester (fleet foreman): /plugin marketplace add Davidb3l/Sirius-Forester, /plugin install sirius@sirius-forester, then /sirius:install-binary" ;; esac
  case "$s_missing" in *Catryna*)  log "  Catryna Wikinelli (code wiki): /plugin marketplace add Davidb3l/Catryna-Wikinelli, then /plugin install catryna@catryna-wikinelli (Sothis bundle users: /plugin install catryna@sirius-forester)" ;; esac
  case "$s_missing" in *Ametrite*) log "  Ametrite (task board): ask Claude to \"ametrite this repo\" (the skill bootstraps the amt CLI)" ;; esac
}

# A downloader that works on a stock macOS or Linux box.
fetch() { # fetch <url> <dest>
  url="$1"; dest="$2"
  if have curl; then
    curl -fsSL "$url" -o "$dest"
  elif have wget; then
    wget -qO "$dest" "$url"
  else
    fail "need curl or wget to download releases"
  fi
}

fetch_stdout() { # fetch_stdout <url>
  url="$1"
  if have curl; then
    curl -fsSL "$url"
  elif have wget; then
    wget -qO- "$url"
  else
    fail "need curl or wget to download releases"
  fi
}

sha256_of() { # sha256_of <file> -> hex on stdout
  f="$1"
  # Hash STDIN, not a named file. When the path contains a backslash — which it
  # does on Windows whenever TMPDIR is inherited as a native path like
  # C:\Users\...\Temp — both shasum and sha256sum escape the output line and
  # prefix it with a literal "\", so `awk '{print $1}'` returned "\9c23..." and
  # every comparison below failed as a bogus checksum mismatch. Fed on stdin the
  # digest is over the same bytes and the printed name is just "-".
  if have shasum; then
    shasum -a 256 < "$f" | awk '{print $1}'
  elif have sha256sum; then
    sha256sum < "$f" | awk '{print $1}'
  else
    fail "need shasum or sha256sum to verify the download"
  fi
}

# Resolve "latest" to a concrete tag via the GitHub redirect (no API token,
# no jq). /releases/latest 302-redirects to /releases/tag/<TAG>. On curl-less
# boxes, fall back to the public API (wget works there; light rate limit is
# fine for an installer).
resolve_latest_tag() {
  if [ -n "$TAG" ]; then return 0; fi
  loc=""
  if have curl; then
    loc="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
  fi
  case "$loc" in
    */releases/tag/*) TAG="${loc##*/releases/tag/}" ;;
    *) TAG="" ;;
  esac
  if [ -z "$TAG" ] && have wget; then
    TAG="$(fetch_stdout "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)"
  fi
  [ -n "$TAG" ] || fail "could not resolve the latest release tag for $REPO (pass --version vX.Y.Z)"
}

print_path_hint() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) : ;; # already on PATH
    *)
      log ""
      log "note: $BIN_DIR is not on your PATH. Add it, e.g.:"
      log "      export PATH=\"$BIN_DIR:\$PATH\"   # add to ~/.zshrc or ~/.bashrc"
      # On Windows the export above only fixes THIS Git Bash session; anything
      # launched by Windows itself (cmd, PowerShell, the Claude Code desktop
      # app) reads the registry User Path instead. Print the one-liner that
      # persists it — and never run it for them: silently rewriting a user's
      # PATH is not an installer's call to make.
      if [ "$IS_WINDOWS" = "1" ]; then
        win_bin_dir="$BIN_DIR"
        if have cygpath; then
          win_bin_dir="$(cygpath -w "$BIN_DIR" 2>/dev/null || printf '%s' "$BIN_DIR")"
        fi
        log ""
        log "      That export only affects this Git Bash session. To persist it for Windows,"
        log "      run this in PowerShell (it appends to the per-user Path, no admin needed):"
        log "        [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$win_bin_dir', 'User')"
        log "      Then restart your shell (and any editor or terminal that inherited the old"
        log "      PATH) before \`hayven\` resolves. This installer never edits your PATH for you."
      fi
      ;;
  esac
}

# ---- --check: status only, never downloads ---------------------------------
if [ "$MODE" = "check" ]; then
  if have hayven; then
    log "hayven: already on PATH ($(command -v hayven))"
    if suite_repo; then suite_hint; fi
    exit 0
  fi
  if [ -x "$BIN_DIR/hayven$EXE" ]; then
    log "hayven: installed at $BIN_DIR/hayven$EXE (not on PATH)"
    print_path_hint
    if suite_repo; then suite_hint; fi
    exit 0
  fi
  log "hayven: not installed. Run /hayvenhurst:install-binary (or plugin/scripts/install-hayven.sh) to install it."
  if suite_repo; then suite_hint; fi
  exit 3
fi

# ---- install ---------------------------------------------------------------
detect_platform
resolve_latest_tag
VERSION="${TAG#v}"
TARBALL="hayvenhurst-${VERSION}-${PLATFORM}.tar.gz"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
TARBALL_URL="$BASE_URL/$TARBALL"
CHECKSUM_URL="$TARBALL_URL.sha256"

log "install-hayven: repo=$REPO tag=$TAG platform=$PLATFORM"
log "install-hayven: asset=$TARBALL"

# Allow a dry run of just the detection/mapping logic without network I/O.
if [ "${HAYVEN_INSTALL_DRY_RUN:-}" = "1" ]; then
  log "DRY RUN: would download: $TARBALL_URL"
  log "DRY RUN: would verify:   $CHECKSUM_URL"
  log "DRY RUN: would install into: $BIN_DIR"
  exit 0
fi

# Windows inherits TMPDIR as a NATIVE path (C:\Users\...\Temp) often enough to
# matter here, and GNU tar reads a leading "C:" as a remote host:path spec —
# `tar -xzf C:\...\x.tar.gz` dies with "Cannot connect to C: resolve failed"
# rather than extracting anything. Fall back to the POSIX /tmp that MSYS always
# provides when TMPDIR looks native.
TMP_BASE="${TMPDIR:-/tmp}"
if [ "$IS_WINDOWS" = "1" ]; then
  case "$TMP_BASE" in
    *\\*|?:*) TMP_BASE="/tmp" ;;
  esac
fi
TMP="$(mktemp -d "$TMP_BASE/hayven-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

log "install-hayven: downloading $TARBALL_URL"
fetch "$TARBALL_URL" "$TMP/$TARBALL" || fail "download failed: $TARBALL_URL (does a release exist for $TAG / $PLATFORM?)"

# Verify sha256 against the published per-asset checksum file. The release
# publishes `<tarball>.sha256` in the `shasum -a 256` format: "<hex>  <name>".
log "install-hayven: verifying sha256"
checksum_line="$(fetch_stdout "$CHECKSUM_URL" 2>/dev/null || true)"
[ -n "$checksum_line" ] || fail "could not fetch checksum: $CHECKSUM_URL"
expected="$(printf '%s\n' "$checksum_line" | awk '{print $1}')"
actual="$(sha256_of "$TMP/$TARBALL")"
[ -n "$expected" ] || fail "published checksum was empty"
if [ "$expected" != "$actual" ]; then
  fail "checksum mismatch for $TARBALL
        expected: $expected
        actual:   $actual"
fi
log "install-hayven: checksum OK ($actual)"

log "install-hayven: extracting"
tar -xzf "$TMP/$TARBALL" -C "$TMP"
# The tarball expands to a top-level dir: hayvenhurst-<version>-<platform>/
STAGE="$TMP/hayvenhurst-${VERSION}-${PLATFORM}"
[ -d "$STAGE" ] || fail "unexpected tarball layout (no $STAGE)"
# On windows-x64 the release matrix builds `hayven.exe` / `hayven-native.exe`;
# $EXE is empty everywhere else, so this is the same test it always was.
[ -f "$STAGE/hayven$EXE" ] || fail "tarball is missing the hayven$EXE binary"

mkdir -p "$BIN_DIR"
# Install both binaries; install hayven-native beside hayven so the daemon's
# subprocess transport finds it. Atomic-ish: write then move into place.
install_one() { # install_one <name>
  name="$1"
  [ -f "$STAGE/$name" ] || return 0
  tmp_dst="$BIN_DIR/.$name.tmp.$$"
  cp "$STAGE/$name" "$tmp_dst"
  chmod +x "$tmp_dst"
  # Windows locks a RUNNING .exe, so the replace can fail on an upgrade while
  # the daemon is up. Say which door to close instead of leaving a bare
  # "Device or resource busy" and a stray .tmp file behind.
  mv -f "$tmp_dst" "$BIN_DIR/$name" || {
    rm -f "$tmp_dst"
    if [ "$IS_WINDOWS" = "1" ]; then
      fail "could not replace $BIN_DIR/$name — Windows locks an executable while it runs.
        Stop it (\`hayven daemon stop\`), close anything else using it, then re-run."
    fi
    fail "could not install $BIN_DIR/$name"
  }
  log "install-hayven: installed $BIN_DIR/$name"
}
install_one "hayven$EXE"
install_one "hayven-native$EXE"

# Bundle viewer/dist + skill/ beside the binary too, so a plugin install gets
# the same layout a tarball install does (resolveViewerDist / resolveSkillSource
# look next to the executable). Best-effort: skip silently if absent.
if [ -d "$STAGE/viewer/dist" ]; then
  rm -rf "$BIN_DIR/viewer"
  mkdir -p "$BIN_DIR/viewer"
  cp -R "$STAGE/viewer/dist" "$BIN_DIR/viewer/dist"
fi
if [ -d "$STAGE/skill" ]; then
  rm -rf "$BIN_DIR/skill"
  mkdir -p "$BIN_DIR/skill"
  cp -R "$STAGE/skill/." "$BIN_DIR/skill/"
fi

log ""
log "install-hayven: done. hayven $VERSION installed for $PLATFORM."
print_path_hint
log ""
log "Next steps:"
log "  hayven init          # set up .hayven/ and do the first ingestion"
log "  hayven daemon start  # serves the code graph on :7777"
suite_hint
