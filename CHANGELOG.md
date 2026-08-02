# Changelog

All notable user-facing changes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [Semantic Versioning](https://semver.org/). Pre-release (`0.x`): expect breaking changes in every `0.x` until v1.0.

## [Unreleased]

- **Fixed: a daemon could index your entire home directory.** `~/.hayven` is the global config dir, so a `[ -d .hayven ]` check answered "yes, a project" when the working directory was your home dir. A daemon started there registered the whole tree and indexed it — 98% CPU for six hours, 195 GB read, a 593 MB index and a 576 MB log, with no error at any point. `$HOME` is now refused at three layers (the registry, every daemonless command, and `init`), compared canonically so a symlinked home cannot slip past. `hayven init` additionally refuses a tree above `--max-files` (default 50,000) naming the count and the override, because home was never the special case — the unbounded walk was.
- **Fixed: an interrupted ingest reported the index as healthy.** Clearing the graph and repopulating it were not atomic, so a crash between them left zero nodes while the freshness stamp still described the previous good run. Every query answered "No matches" and looked authoritative. The wipe now marks the index in-progress in the same transaction, and only a completing ingest clears it. The marker is owned by the ingest that raised it, so a concurrent run cannot retract another's, and `hayven reindex` no longer destroys the table holding the detectors. `hayven doctor` reports index integrity.
- **Fixed: the runaway loop had no rate bound.** The incident ran 11,600 ingest cycles with 10 failures — successful work at an absurd rate, which a consecutive-failure breaker cannot see. Automatic re-ingest is now bounded by rate as well as failures, with real watcher backpressure, a quiet-period debounce, overflow coalescing, a bounded pending-event buffer, a global ingest concurrency limit, and a timeout on the verify gate's child processes. A tripped breaker says so once and is visible at `GET /api/ingest/health`.
- **Fixed: `hayven reindex` destroyed fleet memory.** It dropped `fleet_memory`, `observations` and `claims` — none of which a re-parse can rebuild — while its own docs implied only derived data was lost. It now preserves them, inside a transaction with a tripwire that rolls back if a preserved row count moves.
- **Security: the daemon and proxy refused to admit they were exposed.** Both accepted a non-loopback `--host` with no warning, and the daemon has no authentication. Both now refuse unless `--allow-remote-access` is also given, print the actual bind address, and the daemon rejects cross-origin mutations.
- **Security: the context packer could read any file on disk.** A client-supplied path was read verbatim, so an MCP host — or a prompt injection inside an indexed source file — could pull `~/.aws/credentials` or an SSH key into a model prompt. Reads are now confined to the repository, mirror the indexer's own admission rules (so non-source files like `dump.sql` are refused outright), deny credential shapes, and are bounded in size and file type. Every client-supplied bound is validated: one unvalidated line number could previously wedge the MCP server for years of CPU time.
- **Fixed: `hayven daemon unregister <name>` could remove a different project.** A bare name was resolved against the current directory and then matched on location, so running it from a parent folder could unregister a coincidentally-located project. An argument is now an alias or a path, never silently both.
- **Fixed: `hayven daemon stop` and `status` lied outside the primary repo.** Only the primary project got a pidfile, so both reported "not running" while the daemon was actively serving that repo. Pidfiles are now per-project and carry identity, so a recycled pid cannot be signalled by mistake.
- **Fixed: the CLI could hang for five minutes.** Daemon-facing requests had no timeout, so a busy daemon looked identical to a dead one and `daemon start` parked for 300 s while printing a 10-second budget. This is what stacked up five daemon processes during the incident. All of them are now bounded, including the response body read.
- **Fixed: logs and indexes grew without limit.** Daemon logs rotate and deduplicate repeated lines; node markdown is no longer rewritten unchanged on every run and orphans are reclaimed; expired fleet-memory notes are pruned; CRDT retention limits are measured and reported by `hayven crdt retention`.
- **Fixed: the watcher and the indexer disagreed about what belongs in the graph.** Two separate scope filters meant a file could be indexed by a full ingest and dropped by the watcher, so the graph changed depending on which path ran last. There is now one shared filter used by both.
- Known defects that are shipping deliberately, with their costs and the work each would take, are recorded in [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md). Patterns distilled from these bugs are in [docs/DESIGN_LESSONS.md](docs/DESIGN_LESSONS.md).

- **`hayven doctor --json` speaks the suite discovery handshake.** It emits exactly one envelope on stdout (`tool`, `version`, `schemaVersion`, `ok`, `capabilities`, `checks`, `report`) so companion tools can discover Hayvenhurst instead of classifying it absent. Health is carried by `ok`: under `--json` doctor exits 0 whenever it produced an envelope, so an installed-but-degraded daemon reads as unhealthy rather than missing. Human output and its exit codes are unchanged.

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
