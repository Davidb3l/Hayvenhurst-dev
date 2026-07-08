---
description: Download and install the platform-correct `hayven` CLI binary for this OS/arch from the latest Hayvenhurst GitHub release, verifying its checksum. Use when `hayven` is not yet installed.
argument-hint: "[vX.Y.Z]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/install-hayven.sh:*)
---

# Install the `hayven` binary

The Hayvenhurst plugin ships the Agent Skill, but a git-based plugin install can
**not** deliver the compiled `hayven` CLI (it's platform-specific and large, so it
is not committed to the repo). This command bridges that gap: it downloads the
release tarball matching this machine's OS + CPU arch, verifies its sha256, and
installs `hayven` (+ `hayven-native`) into the plugin's persistent data directory.

Run the bundled install script. If the user passed a tag (e.g. `v0.0.5`),
forward it explicitly:

```sh
"${CLAUDE_PLUGIN_ROOT}/scripts/install-hayven.sh" --version "$ARGUMENTS"
```

If no tag was passed, install the latest release instead (do NOT pass an empty
`--version`):

```sh
"${CLAUDE_PLUGIN_ROOT}/scripts/install-hayven.sh"
```

After it finishes:

- If the script printed a PATH note (the install dir isn't on `PATH`), relay that
  to the user verbatim so they can add it to their shell rc.
- Tell the user the next steps the script printed: `hayven init` then
  `hayven daemon start`.
- If the download or checksum verification failed, report the exact error; do not
  retry silently. A common cause is that no GitHub release exists yet for the
  resolved tag/platform.
