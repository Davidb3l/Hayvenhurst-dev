# Hayvenhurst plugin for Claude Code

Gives Claude Code the **"reach for `hayven` over grep"** reflex in one install — no
`hayven init` required in every repo.

This plugin ships the first-party **Hayvenhurst Agent Skill** and a command/hook to
install the **`hayven` CLI binary** for your platform. Once installed, Claude
Code auto-discovers the skill and reaches for the Hayvenhurst code graph (callers/callees,
dependencies, full-text code search, runtime traces) through the local Hayvenhurst daemon
on `:7777` whenever a question is structural — "who calls X", "what does X call", "where
is X defined", "what's in module Y" — instead of grepping or reading large files. It also
coordinates parallel/multi-agent work through the shared claim board.

The skill bundled here is **byte-identical** to the canonical
[`skill/hayvenhurst.md`](https://github.com/Davidb3l/Hayvenhurst-dev/blob/main/skill/hayvenhurst.md)
source; a drift-guard test (`daemon/tests/plugin_skill_drift.test.ts`) keeps the two copies
from diverging.

## Install

### From the Claude Code slash-command UI

```
/plugin marketplace add Davidb3l/Hayvenhurst-dev
/plugin install hayvenhurst@hayvenhurst
```

### From the CLI

```sh
claude plugin marketplace add Davidb3l/Hayvenhurst-dev
claude plugin install hayvenhurst@hayvenhurst
```

`hayvenhurst@hayvenhurst` is `<plugin-name>@<marketplace-name>` — both are
`hayvenhurst` here.

## Two-step install: plugin, then binary

Installing the plugin is **step 1 of 2**. A Claude Code plugin is distributed over
git, so installing it only clones this repo's text files — the Agent Skill, this
command, and the hook. It does **not** deliver the compiled `hayven` CLI /
`hayven-native` binary. Those are platform-specific and large, so they are
deliberately **not committed to the repo**; they ship as per-platform tarballs
attached to each [GitHub release](https://github.com/Davidb3l/Hayvenhurst-dev/releases).

> **Honest note on the limitation.** Claude Code's plugin `bin/` directory only
> exposes executables that are *already committed to the plugin repo*. Since we
> can't commit binaries, there is no native "ship the binary with the plugin"
> mechanism that fits. The realistic bridge is a plugin-provided command plus an
> install script that downloads + checksum-verifies the right release asset. That
> is exactly what this plugin does — no faked capability.

### Step 2 — install the binary

After the plugin is installed, run the slash command:

```
/hayvenhurst:install-binary
```

This runs [`scripts/install-hayven.sh`](scripts/install-hayven.sh), which:

1. detects your OS + CPU arch (`uname`),
2. maps it to the matching release asset (mirrors the platform matrix in
   `.github/workflows/release.yml`):

   | OS / arch                | release asset                              |
   | ------------------------ | ------------------------------------------ |
   | Linux x86-64 (glibc)     | `hayvenhurst-<version>-linux-x64-glibc.tar.gz` |
   | Linux arm64              | `hayvenhurst-<version>-linux-arm64.tar.gz`     |
   | macOS Intel (x86-64)     | `hayvenhurst-<version>-macos-x64.tar.gz`       |
   | macOS Apple Silicon      | `hayvenhurst-<version>-macos-arm64.tar.gz`     |

3. downloads it from `https://github.com/Davidb3l/Hayvenhurst-dev/releases/download/<tag>/…`,
4. **verifies its sha256** against the published `<asset>.tar.gz.sha256`,
5. installs `hayven` (+ `hayven-native`, plus the bundled `viewer/dist` and `skill/`)
   into the plugin's persistent data dir (`${CLAUDE_PLUGIN_DATA}/bin`, which survives
   plugin updates), and prints a `PATH` hint and next steps.

It is **idempotent and safe to re-run** (e.g. to upgrade). To pin a release:
`/hayvenhurst:install-binary v0.0.3`.

You can also run the script directly outside Claude Code:

```sh
sh scripts/install-hayven.sh                 # latest release → ~/.local/bin
sh scripts/install-hayven.sh --version v0.0.3 # pin a tag
sh scripts/install-hayven.sh --prefix ~/.local # choose the install prefix
sh scripts/install-hayven.sh --check          # status only, never downloads
```

A `SessionStart` **hook** runs `install-hayven.sh --check` on every session. It
**never downloads** — it only prints a one-line hint if `hayven` is missing, so
the install stays an explicit, user-consented action.

#### Windows

The installer script is POSIX `sh` and covers **macOS + Linux**. A
`windows-x64` tarball is published with every release, but Windows install is
manual for now: download `hayvenhurst-<version>-windows-x64.tar.gz` (and its
`.sha256`) from the [release page](https://github.com/Davidb3l/Hayvenhurst-dev/releases),
verify the checksum, extract, and put `hayven.exe` / `hayven-native.exe` on your
`PATH`.

## Prerequisite: index a repo

Once the binary is installed, index a repo so the skill has a graph to query:

```sh
hayven init          # set up .hayven/ and do the first ingestion
hayven daemon start  # serves :7777
```

If `hayven` is not installed, the skill degrades gracefully: Claude falls back to
conventional tools (grep/find) for that turn. See the
[Hayvenhurst README](https://github.com/Davidb3l/Hayvenhurst-dev#readme) for more.

## What's in the plugin

```
plugin/
  .claude-plugin/
    plugin.json                 # plugin manifest (name: hayvenhurst)
  skills/
    hayvenhurst/
      SKILL.md                  # auto-discovered as skill `hayvenhurst`
  commands/
    install-binary.md           # /hayvenhurst:install-binary slash command
  hooks/
    hooks.json                  # SessionStart hook → install-hayven.sh --check
  scripts/
    install-hayven.sh           # platform-detect + download + checksum + install
  README.md                     # this file
```

Skills are auto-discovered at `skills/<name>/SKILL.md`, slash commands at
`commands/<name>.md`, and hooks at `hooks/hooks.json` — all default locations, so
there is nothing to wire up in `plugin.json`. A plugin skill auto-invokes identically
to a `.claude/skills/<name>/SKILL.md` project skill. The command and hook reference the
install script through `${CLAUDE_PLUGIN_ROOT}`, the install-path-independent root the
plugin runtime exports.

## License

MIT © Hayvenhurst contributors.
