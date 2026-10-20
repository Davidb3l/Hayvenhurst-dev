#!/usr/bin/env bash
#
# release-notes.sh — print the CHANGELOG.md section for one release.
#
#   ci/release-notes.sh <tag-or-version> [changelog-path]   (default CHANGELOG.md)
#
# `v0.0.10` and `0.0.10` both select the `## [0.0.10]` section: every line after
# that heading up to (not including) the next `## [` heading, with leading and
# trailing blank lines trimmed. The release workflow writes this to a file and
# uses it as the GitHub Release body, so a release can never again ship with
# another version's notes.
#
# Exits 1 with an ::error:: line when the heading is missing or the section has
# no content (an `## [Unreleased]` heading is NOT a release heading: tagging
# before the changelog was cut must fail the release, not publish empty notes).

set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <tag-or-version> [changelog-path]" >&2
  exit 2
fi

version="${1#v}"
changelog="${2:-CHANGELOG.md}"

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
  echo "::error::release-notes: '$1' is not a version or a v-prefixed tag" >&2
  exit 1
fi
if [ ! -f "$changelog" ]; then
  echo "::error::release-notes: $changelog not found" >&2
  exit 1
fi

# CRLF checkouts (Windows autocrlf) must work too, so strip CRs. The version is
# compared literally (index(), not a regex) because it contains dots.
notes="$(tr -d '\r' < "$changelog" | awk -v want="## [$version]" '
  /^## \[/ {
    if (on) exit
    # Heading is "## [X.Y.Z]" optionally followed by " - date" etc.
    head = substr($0, 1, length(want))
    rest = substr($0, length(want) + 1)
    if (head == want && (rest == "" || rest ~ /^[ \t]/)) { on = 1; next }
  }
  on { print }
')"

# Trim leading/trailing blank lines.
notes="$(printf '%s\n' "$notes" | awk 'NF { started = 1 } started { buf[++n] = $0 } END { while (n && buf[n] ~ /^[ \t]*$/) n--; for (i = 1; i <= n; i++) print buf[i] }')"

if [ -z "$notes" ]; then
  echo "::error::release-notes: no non-empty '## [$version]' section in $changelog (cut the changelog before tagging)" >&2
  exit 1
fi

printf '%s\n' "$notes"
