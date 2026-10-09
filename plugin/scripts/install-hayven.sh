#!/bin/sh
# install-hayven.sh - download + install the platform-correct `hayven` (and
# `hayven-native`) binaries from a Hayvenhurst GitHub Release.
#
# WHY this exists: the Claude Code plugin is git-based, so installing the
# plugin only clones the repo's text files (the Agent Skill). It does NOT
# deliver the compiled `hayven` CLI / `hayven-native` binary - those are
# platform-specific and large, and are deliberately NOT committed to git.
# Claude Code has no native "ship a binary with a plugin" mechanism that
# fits that constraint (the plugin `bin/` directory only exposes executables
# already committed to the plugin repo). So this script is the realistic
# bridge: detect the OS/arch, map to the matching release tarball asset
# (mirroring .github/workflows/release.yml's platform matrix), download it,
# verify its sha256 and its Sigstore signature, and install the binaries into
# a known location.
#
# SECURITY: the `<tarball>.sha256` is served from the same origin as the
# tarball, so on its own it only catches a corrupted download, not a tampered
# release: anyone who can replace the tarball can replace its checksum too.
# Authenticity comes from the Sigstore bundle (`<tarball>.sigstore.json`), whose
# Fulcio certificate binds the artifact to THIS repo's release workflow. We pin
# both the signer identity and the OIDC issuer; otherwise an attacker could sign
# a malicious tarball with their own identity and it would still "verify".
#
# A bad signature ALWAYS aborts. A MISSING bundle ALWAYS aborts: the tarball
# came from the same origin and every release since v0.0.6 publishes a bundle,
# so "tarball but no bundle" is a signature-stripping downgrade, not a benign
# 404. (v0.0.5 and older predate signing; install those by hand.)
#
# The one soft case is a box with no verifier installed (`cosign` or
# `sigstore`): we cannot check, so we warn loudly and continue on TLS plus the
# checksum. An attacker cannot induce that state remotely (it depends on what is
# installed locally). Pass --require-signature (or HAYVEN_REQUIRE_SIGNATURE=1)
# to make it fatal too.
#
# NOTE: the trust anchor follows HAYVEN_REPO. Overriding it points both the
# download AND the expected signer at that repo, so verification then only
# proves "that repo signed its own artifact". Do not set it to a repo you do
# not trust.
#
# Idempotent + safe to re-run. POSIX sh, covering macOS, Linux AND Windows:
# under Git Bash / MSYS2 / Cygwin `uname -s` reports MINGW*/MSYS*/CYGWIN*, and
# this script installs the windows-x64 release asset (the binaries inside are
# hayven.exe and hayven-native.exe). windows-x64 is the only Windows asset, so
# a non-x64 Windows box is refused by name rather than 404ing on a download.
# With no POSIX layer at all (PowerShell only), use install-hayven.ps1 instead.
#
# Usage:
#   install-hayven.sh                 # download + install latest release
#   install-hayven.sh --check         # print status only; never downloads
#                                     #   exit 0 if `hayven` is on PATH or
#                                     #   already installed, 3 if missing
#   install-hayven.sh --version vX.Y.Z   # install a specific tag
#   install-hayven.sh --prefix DIR    # install into DIR/bin (default below)
#   install-hayven.sh --require-signature  # abort unless the signature verifies
#
# Environment:
#   HAYVEN_INSTALL_PREFIX   override the install prefix (same as --prefix)
#   HAYVEN_RELEASE_TAG      pin a release tag (same as --version)
#   HAYVEN_REPO             override owner/repo (default Davidb3l/Hayvenhurst-dev)
#   HAYVEN_REQUIRE_SIGNATURE=1   same as --require-signature

set -eu

REPO="${HAYVEN_REPO:-Davidb3l/Hayvenhurst-dev}"
TAG="${HAYVEN_RELEASE_TAG:-}"
# HOME may be unset or empty (launchd/systemd, some CI runners, slim
# containers). Under `set -u` a bare `$HOME` ABORTS the script at expansion
# time - so this hook, which SessionStart runs in every repo, died before
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
# Make a missing verifier fatal. A BAD signature is fatal regardless.
REQUIRE_SIG="${HAYVEN_REQUIRE_SIGNATURE:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --require-signature) REQUIRE_SIG=1 ;;
    --version)
      [ -n "${2:-}" ] || { echo "install-hayven: --version needs a tag (e.g. v0.0.7)" >&2; exit 2; }
      TAG="$2"; shift ;;
    --prefix)
      [ -n "${2:-}" ] || { echo "install-hayven: --prefix needs a directory" >&2; exit 2; }
      PREFIX="$2"; shift ;;
    --help|-h)
      sed -n '2,62p' "$0"
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

# Host-shape facts needed BEFORE the platform -> asset mapping runs: --check
# returns long before detect_platform is called, but it still has to look for
# the right file name and print the right PATH advice. On Windows the release
# tarball holds hayven.exe / hayven-native.exe, so every place that names a
# binary on disk goes through $EXE. (MSYS/Cygwin also resolve a bare `hayven`
# to hayven.exe, but relying on that makes the script read as if a Unix-named
# file were installed, which it is not.)
IS_WINDOWS=0
IS_CYGWIN=0
EXE=""
case "$(uname -s)" in
  CYGWIN*) IS_WINDOWS=1; IS_CYGWIN=1; EXE=".exe" ;;
  MINGW*|MSYS*) IS_WINDOWS=1; EXE=".exe" ;;
esac

# A relative --prefix would install fine and then print PATH advice naming a
# relative directory, which means nothing to a shell started anywhere else.
# Anchor it to the cwd once, here. On Windows "C:..." / "C:\..." name a drive
# and "\\server\share" is a UNC path, so leave those alone.
case "$PREFIX" in
  /*) ;;
  ?:*|\\*) [ "$IS_WINDOWS" = "1" ] || PREFIX="$(pwd)/$PREFIX" ;;
  *) PREFIX="$(pwd)/$PREFIX" ;;
esac
BIN_DIR="$PREFIX/bin"

# ---- platform detection -> release asset name -------------------------------
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
    # Git Bash reports MINGW64_NT-10.0-<build>; MSYS2's msys shell reports
    # MSYS_NT-...; Cygwin reports CYGWIN_NT-.... All three run this script
    # fine and all three want the windows-x64 asset.
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) fail "unsupported OS '$uname_s' (this script covers macOS, Linux, and Windows under Git Bash / MSYS / Cygwin; from PowerShell use install-hayven.ps1)" ;;
  esac
  case "$uname_m" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) fail "unsupported CPU arch '$uname_m'" ;;
  esac
  # The only x64 Linux release is the glibc build; musl is not a release target.
  if [ "$os" = "linux" ] && [ "$arch" = "x64" ]; then
    PLATFORM="linux-x64-glibc"
  elif [ "$os" = "windows" ]; then
    # windows-x64 is the ONLY Windows asset in release.yml's matrix. Windows on
    # ARM runs x64 binaries under emulation, and a native arm64 Git for Windows
    # reports aarch64 - so install the x64 build and say so, exactly as
    # install-hayven.ps1 does. Two installers disagreeing about one machine
    # (one installs, the other refuses) is worse than either answer.
    if [ "$arch" = "arm64" ]; then
      log "install-hayven: note: no windows-arm64 release exists; using the windows-x64 build (runs under Windows' x64 emulation)."
    fi
    PLATFORM="windows-x64"
  else
    PLATFORM="${os}-${arch}"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---- suite awareness --------------------------------------------------------
# Hayvenhurst is the code graph of a four-tool suite: Ametrite holds the task
# board, Sirius Forester runs the foreman loop, Catryna Wikinelli keeps the
# living docs. One short nudge, only when something is missing - full fleet
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
  # - but it is one behavior change away from being load-bearing again, so it
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
  # Fed a FILENAME containing a backslash - which is what $TMP looks like on
  # Windows whenever TMPDIR is inherited as a native path like C:\Users\...\Temp
  # - both shasum and sha256sum escape the output line and prefix it with a
  # literal "\", so awk '{print $1}' yields "\<hex>" and every comparison below
  # fails as a bogus checksum mismatch. Fed on stdin there is no filename to
  # escape, and the digest is identical on every platform.
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

# On Windows a missing PATH entry is the norm, not the exception: ~/.local/bin
# is a Unix convention that nothing on Windows puts on PATH, so a fresh install
# lands a working hayven.exe that PowerShell, cmd, editors and Claude Code
# cannot see. We PRINT the fix; we never mutate the user's PATH from here.
print_path_hint() {
  # On Windows $BIN_DIR may arrive in NATIVE form (CLAUDE_PLUGIN_DATA is a
  # C:\... path on the plugin route; so is $RUNNER_TEMP). $PATH inside Git Bash
  # holds POSIX forms (/c/Users/...), so compare and print the POSIX form, and
  # hand PowerShell the Windows form. Without cygpath, use $BIN_DIR as given.
  bin_posix="$BIN_DIR"
  bin_win="$BIN_DIR"
  if [ "$IS_WINDOWS" = "1" ] && have cygpath; then
    bin_posix="$(cygpath -u "$BIN_DIR" 2>/dev/null || printf '%s' "$BIN_DIR")"
    bin_win="$(cygpath -w "$BIN_DIR" 2>/dev/null || printf '%s' "$BIN_DIR")"
  fi
  case ":$PATH:" in
    *":$bin_posix:"*|*":$BIN_DIR:"*) return 0 ;; # already on PATH
  esac
  log ""
  log "note: $bin_posix is not on your PATH."
  if [ "$IS_WINDOWS" = "1" ]; then
    log ""
    log "  This shell only (Git Bash):"
    log "      export PATH=\"$bin_posix:\$PATH\"   # add to ~/.bashrc to persist it here"
    log ""
    log "  Permanently, for ALL of Windows (PowerShell, cmd, editors, Claude Code):"
    log "  run this ONCE in PowerShell, then close and reopen your shells:"
    log ""
    # Raw registry write, keeping Path's REG_EXPAND_SZ kind: the familiar
    # [Environment]::SetEnvironmentVariable one-liner flattens it to REG_SZ,
    # freezing every %VAR% entry. The dummy-variable delete broadcasts it.
    # The directory goes in a PowerShell single-quoted literal: double any '.
    q_dir="$(printf '%s' "$bin_win" | sed "s/'/''/g")"
    log "      \$d='$q_dir'; "'$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment"); $p=[string]$k.GetValue("Path","",[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $k.SetValue("Path",($p.TrimEnd(";")+";"+$d).TrimStart(";"),[Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close(); [Environment]::SetEnvironmentVariable("HAYVEN_PATH_BROADCAST",$null,"User")'
    log ""
    if [ "$bin_win" = "$BIN_DIR" ] && ! have cygpath; then
      log "  (cygpath was not found, so that is the path as this shell spells it;"
      log "  if it starts with /, substitute its Windows form, e.g. C:\\...)"
    fi
    log "  (install-hayven.ps1 -AddToPath does this for you.)"
    log "  Already-running shells, editors and apps must be RESTARTED to see it."
  else
    log "      export PATH=\"$BIN_DIR:\$PATH\"   # add to ~/.zshrc or ~/.bashrc"
  fi
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

# ---- signature verification --------------------------------------------------
# On a Mac without the Command Line Tools, /usr/bin/python3 is a stub that pops
# the "install developer tools" dialog instead of running anything - the macOS
# twin of the Windows Store alias the .ps1 skips. Only probe it when the tools
# are actually installed; any other python3 on PATH is a real interpreter.
python3_safe_to_probe() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  [ "$(command -v python3)" = "/usr/bin/python3" ] || return 0
  xcode-select -p >/dev/null 2>&1
}

# Verify with whichever Sigstore verifier is on the box. Pin BOTH the signer
# identity (this repo's release.yml, at this tag) and the OIDC issuer: an
# unpinned verify only proves "somebody signed this", not "the release workflow
# signed this".
verify_signature() {
  bundle="$1"
  artifact="$2"
  # Under Cygwin the verifier is almost always a NATIVE Windows program
  # (winget's cosign.exe, a Windows python.exe), and unlike MSYS2/Git Bash,
  # Cygwin does not rewrite POSIX path arguments for native programs - so
  # cosign.exe would be handed "/tmp/hayven-install.X/..." and fail to open it,
  # which reads exactly like a verification failure. Give it the Windows form.
  # (A Cygwin-built verifier accepts C:\... paths too, so this is safe either
  # way.) MSYS2/Git Bash already convert these arguments automatically.
  if [ "$IS_CYGWIN" = "1" ] && have cygpath; then
    bundle="$(cygpath -w "$bundle")"
    artifact="$(cygpath -w "$artifact")"
  fi
  identity="https://github.com/$REPO/.github/workflows/release.yml@refs/tags/$TAG"
  issuer="https://token.actions.githubusercontent.com"

  sig_fail="SIGNATURE VERIFICATION FAILED for $TARBALL
        expected signer: $identity
        expected issuer: $issuer
        Refusing to install: this artifact was not produced by $REPO's release workflow."

  # cosign older than 3.0 cannot read sigstore-python v3's `.sigstore.json`
  # bundle as invoked here (2.4+ needs --new-bundle-format; older cannot at
  # all), so its failure says nothing about the artifact. Treat an old
  # cosign as NO usable cosign (fall through to `sigstore`, then to the
  # no-verifier path) instead of reporting a tampered release. That is no
  # weaker than not having cosign: an attacker cannot choose which cosign is
  # installed locally, and --require-signature still makes the end of that
  # road fatal.
  cosign_ok=0
  if have cosign; then
    cosign_major="$(cosign version 2>/dev/null | sed -n 's/^GitVersion:[[:space:]]*v\{0,1\}\([0-9][0-9]*\)\..*/\1/p' | head -1)"
    if [ -n "$cosign_major" ] && [ "$cosign_major" -lt 3 ]; then
      log "install-hayven: note: found cosign $cosign_major.x; this installer verifies with cosign 3+ (older cosign reads this bundle format only with extra flags). Not using it."
    else
      cosign_ok=1
    fi
  fi

  if [ "$cosign_ok" = "1" ]; then
    log "install-hayven: verifying signature (cosign)"
    # Keep the verifier's own diagnostics: on a real identity mismatch cosign
    # prints "expected X, got Y". Swallowing it makes a toolchain problem look
    # identical to a tampered artifact.
    if ! verify_out="$(cosign verify-blob \
      --bundle "$bundle" \
      --certificate-identity "$identity" \
      --certificate-oidc-issuer "$issuer" \
      "$artifact" 2>&1)"; then
      fail "$sig_fail

        verifier output:
$verify_out"
    fi
    log "install-hayven: signature OK (cosign)"
    return 0
  fi

  sig_cmd=""
  if have sigstore; then
    sig_cmd="sigstore"
  elif have python3 && python3_safe_to_probe && python3 -c 'import sigstore' >/dev/null 2>&1; then
    sig_cmd="python3 -m sigstore"
  fi

  if [ -n "$sig_cmd" ]; then
    log "install-hayven: verifying signature (sigstore)"
    # shellcheck disable=SC2086
    if ! verify_out="$($sig_cmd verify identity \
      --bundle "$bundle" \
      --cert-identity "$identity" \
      --cert-oidc-issuer "$issuer" \
      "$artifact" 2>&1)"; then
      fail "$sig_fail

        verifier output:
$verify_out"
    fi
    log "install-hayven: signature OK (sigstore)"
    return 0
  fi

  if [ "$REQUIRE_SIG" = "1" ]; then
    fail "no signature verifier found, and --require-signature was set.
        Install one:  brew install cosign   (or)   pip install sigstore"
  fi
  log "install-hayven: WARNING: no signature verifier (cosign / sigstore) found."
  log "install-hayven: WARNING: proceeding on TLS + checksum alone, which cannot"
  log "install-hayven: WARNING: detect a tampered release. To verify provenance:"
  log "install-hayven: WARNING:   brew install cosign  (or)  pip install sigstore"
  log "install-hayven: WARNING: then re-run with --require-signature."
}

# ---- install ---------------------------------------------------------------
detect_platform
resolve_latest_tag
# Release tags are always v-prefixed. Accept a bare "0.0.7" from --version /
# HAYVEN_RELEASE_TAG as "v0.0.7" (as install-hayven.ps1 does) instead of
# building a /releases/download/0.0.7/ URL that 404s. A tag resolved from
# /releases/latest already carries its "v", so this leaves it untouched.
case "$TAG" in
  v*) ;;
  *) TAG="v$TAG" ;;
esac
VERSION="${TAG#v}"
TARBALL="hayvenhurst-${VERSION}-${PLATFORM}.tar.gz"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
TARBALL_URL="$BASE_URL/$TARBALL"
CHECKSUM_URL="$TARBALL_URL.sha256"
BUNDLE_URL="$TARBALL_URL.sigstore.json"

log "install-hayven: repo=$REPO tag=$TAG platform=$PLATFORM"
log "install-hayven: asset=$TARBALL"

# Allow a dry run of just the detection/mapping logic without network I/O.
if [ "${HAYVEN_INSTALL_DRY_RUN:-}" = "1" ]; then
  log "DRY RUN: would download: $TARBALL_URL"
  log "DRY RUN: would verify:   $CHECKSUM_URL"
  log "DRY RUN: would verify:   $BUNDLE_URL"
  log "DRY RUN: would install into: $BIN_DIR"
  exit 0
fi

# Windows inherits TMPDIR as a NATIVE path (C:\Users\...\Temp) often enough to
# matter here, and GNU tar reads a leading "C:" as a remote host:path spec -
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
# Cleanup on EXIT only. A trap on INT/TERM that just cleans up RETURNS, and the
# shell then carries on with the next command: Ctrl-C would delete the temp dir
# and the install would keep going against files that are gone (or, run from a
# parent installer, report success). A signal must stop the run, with the
# conventional 128+N status so a caller can tell "interrupted" from "failed".
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "install-hayven: downloading $TARBALL_URL"
fetch "$TARBALL_URL" "$TMP/$TARBALL" || fail "download failed: $TARBALL_URL (does a release exist for $TAG / $PLATFORM?)"

# Verify sha256 against the published per-asset checksum file. The release
# publishes `<tarball>.sha256` in the `shasum -a 256` format: "<hex>  <name>"
# (the Windows runner's sha256sum writes "<hex> *<name>"; field 1 is the same).
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

# Authenticity. The checksum above came from the same origin as the tarball, so
# it proves nothing about provenance on its own.
#
# A missing bundle is ALWAYS fatal, never a skip. The tarball just downloaded
# from this same origin, and every release since v0.0.6 publishes
# <tarball>.sigstore.json (release.yml refuses to publish without it). So
# "tarball present, bundle absent" is not a benign 404 - it is exactly what an
# attacker who can serve a tampered tarball would return in order to strip the
# signature and downgrade us to the checksum, which they also control.
log "install-hayven: fetching signature bundle"
fetch "$BUNDLE_URL" "$TMP/$TARBALL.sigstore.json" 2>/dev/null || fail "no Sigstore bundle at $BUNDLE_URL
        The tarball downloaded but its signature did not. Refusing to install.
        Every Hayvenhurst release since v0.0.6 publishes <tarball>.sigstore.json,
        so a missing bundle means the release is malformed or the download was
        tampered with. (v0.0.5 and older predate signing: install those by hand
        from the release page, checking the .sha256.)"
verify_signature "$TMP/$TARBALL.sigstore.json" "$TMP/$TARBALL"

log "install-hayven: extracting"
tar -xzf "$TMP/$TARBALL" -C "$TMP"
# The tarball expands to a top-level dir: hayvenhurst-<version>-<platform>/
STAGE="$TMP/hayvenhurst-${VERSION}-${PLATFORM}"
[ -d "$STAGE" ] || fail "unexpected tarball layout (no $STAGE)"
[ -f "$STAGE/hayven$EXE" ] || fail "tarball is missing the hayven$EXE binary"

mkdir -p "$BIN_DIR"
# Install both binaries; install hayven-native beside hayven so the daemon's
# subprocess transport finds it. Atomic-ish: write then move into place.
install_one() { # install_one <file name>
  name="$1"
  [ -f "$STAGE/$name" ] || return 0
  tmp_dst="$BIN_DIR/.$name.tmp.$$"
  cp "$STAGE/$name" "$tmp_dst"
  # Harmless (and still the right thing) under MSYS/Cygwin, which map the x bit
  # onto the file's ACL.
  chmod +x "$tmp_dst"
  # A running hayven.exe holds a lock on its file on Windows, so the rename
  # fails there. Say which process to stop rather than leaving a stray temp.
  if ! mv -f "$tmp_dst" "$BIN_DIR/$name"; then
    rm -f "$tmp_dst"
    fail "could not replace $BIN_DIR/$name - is hayven running? Stop it (hayven daemon stop) and re-run."
  fi
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
