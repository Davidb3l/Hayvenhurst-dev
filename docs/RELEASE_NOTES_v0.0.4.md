# Hayvenhurst v0.0.4

*The fastest way to keep an always-fresh, private structural index of your codebase — no model, no embeddings, no setup.*

A pre-release (`0.x`): expect breaking changes in every `0.x` until v1.0.

## What Hayvenhurst is

Hayvenhurst builds and maintains a structural index of a codebase — entities, call/import edges, and runtime trace coverage — backed by SQLite, with **zero embeddings, zero model, and zero external services**. It runs anywhere a Rust binary and SQLite run, indexes in well under a second, and never sends your code anywhere. The advantage is **speed + zero-config + determinism**, not "smarter than grep."

### The measured wedge (committed, reproducible harnesses)

| Property | Hayvenhurst | Embedding-based indexer |
|---|---|---|
| Cold index (hono, 362 files) | **0.65 s** | 35.6 s |
| Cold index (gin, Go) | **0.23 s** | — |
| Branch switch (re-parse only the diff) | **~48 ms** | re-syncs + re-embeds |
| Revisit a seen branch | **1 ms** (cached) | 0.41 s |
| Dependencies | none | model + torch + vector store |

Because the index is embedding-free, building it is a parse + a SQLite write — sub-second cold, instant on a cached branch, private by construction. We win on speed, freshness, and privacy — embeddings still beat us on fuzzy semantic recall.

Reproduce on any repo: `bench/wedge-demo.sh <repo-url>`.

## What's new in 0.0.4

- **Per-test runtime coverage + `hayven affected-tests`.** A trace collector records, per test, the entities that test executed; `affected-tests <symbol|--changed files>` returns the tests for a change — useful as a **fail-fast test ordering** aid and as a precise "**which tests actually exercise this symbol**" query. The collector batches flushes, records coverage on every call (complete even at the default sample rate), and excludes nested helpers from being test contexts.
- **Fail-fast test ordering** (`affected-tests --order`, APFD-optimized) and **fleet memory** (`hayven remember`/`recall`, `/api/memory`) — durable, graph-keyed notes shared across agents and sessions.
- **Branch-aware per-branch indexing matured** — each branch caches its own index; a re-visit is a 1 ms read, never a re-embed.

## Install

Build from source (`bun install`, `cargo build --release`), or install the Claude Code plugin and `hayven init` in any repo. Cross-platform tarballs are produced by the release workflow.

## Reproduce the wedge in under a minute

```sh
export HAYVEN_NATIVE_BIN="$PWD/native/target/release/hayven-native"
git clone --depth 50 https://github.com/honojs/hono /tmp/hv-switch
bun bench/branch-switch-cost.ts /tmp/hv-switch 3
```
