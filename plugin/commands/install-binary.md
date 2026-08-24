---
description: Download and install the platform-correct `hayven` CLI binary for this OS/arch from the latest Hayvenhurst GitHub release, verifying its checksum. Use when `hayven` is not yet installed.
argument-hint: "[vX.Y.Z]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/install-hayven.sh:*), Bash(powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${CLAUDE_PLUGIN_ROOT}/scripts/install-hayven.ps1:*)
---

# Install the `hayven` binary

The Hayvenhurst plugin ships the Agent Skill, but a git-based plugin install can
**not** deliver the compiled `hayven` CLI (it's platform-specific and large, so it
is not committed to the repo). This command bridges that gap: it downloads the
release tarball matching this machine's OS + CPU arch, verifies its sha256, and
installs `hayven` (+ `hayven-native`) into the plugin's persistent data directory.

Two installers ship side by side — same asset, same layout, same sha256
verification, same exit codes. **Pick by shell, not by OS branding:**

- **A POSIX shell** (macOS, Linux, or Windows under Git Bash / MSYS2 / Cygwin /
  WSL) → run `install-hayven.sh`.
- **Native Windows PowerShell**, with no POSIX shell available → run
  `install-hayven.ps1`. A stock Windows box has no Git Bash; do not send the
  user off to install one, and do not fall back to hand-extracting a tarball.

Determine which you have before running anything: if `sh` / `bash` resolves,
take the POSIX path; otherwise take the PowerShell path.

### POSIX (macOS / Linux / Git Bash)

If the user passed a tag (e.g. `v0.0.5`), forward it explicitly:

```sh
"${CLAUDE_PLUGIN_ROOT}/scripts/install-hayven.sh" --version "$ARGUMENTS"
```

If no tag was passed, install the latest release instead (do NOT pass an empty
`--version`):

```sh
"${CLAUDE_PLUGIN_ROOT}/scripts/install-hayven.sh"
```

### Windows PowerShell

Same contract, PowerShell-native flags (`-Version`, not `--version`). With a tag:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/install-hayven.ps1" -Version "$ARGUMENTS"
```

With no tag, install the latest release (do NOT pass an empty `-Version`):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/install-hayven.ps1"
```

`-ExecutionPolicy Bypass` is scoped to this one process and only allows the
bundled script to run at all; it changes nothing about the sha256 verification
the script performs — a checksum mismatch still aborts and installs nothing.
Other switches map one-to-one: `-Prefix DIR`, `-Check`, `-AddToPath`.

After it finishes (either path):

- If the script printed a PATH note (the install dir isn't on `PATH`), relay that
  to the user verbatim so they can add it to their shell rc.
- Tell the user the next steps the script printed: `hayven init` then
  `hayven daemon start`.
- If the download or checksum verification failed, report the exact error; do not
  retry silently. A common cause is that no GitHub release exists yet for the
  resolved tag/platform.
