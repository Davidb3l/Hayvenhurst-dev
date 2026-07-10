# Changelog

All notable user-facing changes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [Semantic Versioning](https://semver.org/). Pre-release (`0.x`): expect breaking changes in every `0.x` until v1.0.

## [0.0.6]

- **The daemon outlives its session.** `hayven daemon start` detaches by default (`--foreground` opts out), handles SIGHUP cleanly, cleans stale pidfiles, and a second repo's `start` joins the running daemon (live registration) instead of dying on a port collision. The Claude Code plugin gains a session-start hook that auto-starts the daemon in Hayvenhurst repos.
- **Project-addressed writes on shared daemons.** Mutating CLI commands address their own project; the daemon refuses writes naming a project it doesn't serve. `hayven sync` resolves the peer-side project before any exchange (`--peer-project` required when the peer serves several) and the live-sync WebSocket pins each connection to its selected project, evicting peers of hot-removed projects.
- **Signed releases fixed.** Earlier releases published no signature assets due to an artifact-name mismatch; tarballs now ship with their `.sigstore.json` bundles.

## [0.0.5]

- **One daemon serves multiple repos.** A running daemon now serves every registered project at once, not just the directory it started in. `hayven init` auto-registers each project; manage the set with `hayven daemon register <path>` / `projects` / `unregister`. The viewer gains a project switcher in the nav, and every API endpoint accepts `?project=<alias>` (defaulting to the primary). Single-repo setups are unchanged — the switcher stays hidden and nothing new is required.

## [0.0.4]

- **Embedding-free index, measured fast.** Re-verified on the current build: cold index 0.65 s (hono) / 0.23 s (gin) vs ~35.6 s for an embedding-based indexer; a branch switch re-parses only the `git diff` (~48 ms); a revisit to a cached branch is a 1 ms read. No model, no GPU, no vector store, nothing leaves the machine. Reproduce: `bench/wedge-demo.sh`.
- **Branch-aware per-branch indexing matured.** Each branch caches its own index; switching back is instant and never re-embeds.
- **Per-test runtime coverage + `hayven affected-tests`** (schema v6). The trace collector records, per test, the entities that test executed; `affected-tests <symbol|--changed files>` returns the tests for a change as a fail-fast ordering aid and a precise "which tests exercise this symbol" query. The collector batches flushes and records coverage completely even at the default sample rate.
- **Fail-fast test ordering** (`affected-tests --order`) and **fleet memory** (`hayven remember`/`recall`, `/api/memory`) — durable, graph-keyed notes shared across agents and sessions.

All runtime dependencies (daemon, native binary, viewer) are permissive (MIT/Apache-2.0/BSD/ISC/CC0/Zlib/Unicode-3.0).

## [0.0.3] and earlier

The foundation: 5-language Tree-sitter indexing, runtime trace collectors, call-graph edge resolution, the Astro viewer, CRDT peer sync, and the first-party Claude Code Skill + plugin. See the release tags for details.
