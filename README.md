<div align="center">

# Hayvenhurst

### Know which tests a change can break, before you run a single one.

Open-source code intelligence for AI coding agents. Hayvenhurst keeps a **live structural graph** of your codebase (every function, class, call, and import, plus what actually runs at runtime) and puts it to work answering the questions grep can't.

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![status](https://img.shields.io/badge/status-pre--release%20(0.x)-orange)
![languages](https://img.shields.io/badge/languages-Python%20·%20TS%20·%20JS%20·%20Rust%20·%20Go-blue)
![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![engine](https://img.shields.io/badge/engine-Rust%20+%20SQLite-lightgrey)

[Site](https://hayvenhurst.dev) · [Quickstart](docs/QUICKSTART.md) · [Why Hayvenhurst](docs/WHY_HAYVENHURST.md) · [Integration](docs/INTEGRATION.md) · [Architecture](ARCHITECTURE.md)

</div>

---

## What grep can't answer

Grep finds text. It can't tell you **which tests a change can actually break**, **what the minimal slice of code an agent needs to understand a symbol is**, or **whether two agents editing the same repo are about to collide**. Those are structural questions, and answering them means holding a graph of the code, not a bag of lines.

Hayvenhurst holds that graph. One Rust binary parses your code into entities and call/import edges, augments it with runtime trace coverage, and stores it in SQLite, with plain markdown in `.hayven/` as the source of truth. No embedding model, no GPU, no vector database, and nothing leaves your machine. That last part is a supporting property, not the pitch. The pitch is the four things the graph lets you do.

---

## 1 · Run only the tests a change can break

`hayven affected-tests <symbol>` fuses the static call graph with **runtime traces** (what your code actually did when it ran) to select just the tests a change can reach. Static analysis alone misses tests reached through dynamic dispatch entirely; the trace-augmented map catches them.

```sh
hayven affected-tests session/validate
# SAFE tier → 14 of 412 tests could break
```

> **Measured:** SAFE tier = **0 missed regressions across ~95 replayed real bugs on 4 repos**; trace recall **1.00** vs static ≈ 0. Python (pytest) and TypeScript (vitest, bun test). Add `--order` for fail-fast (earliest-fault-detection) test ordering.

## 2 · Hand agents precise slices, not whole files

`hayven context <symbol>` returns the minimal graph slice an agent needs (the entity, its real dependencies, line-exact) instead of pasting whole files into the context window. A drop-in proxy applies the same trick to any Anthropic / OpenAI / Gemini traffic, automatically.

```sh
hayven context session/validate
```

> **Measured:** **78.8% fewer input tokens** over a 24-turn agent loop, live-measured, with zero task failures.

## 3 · Run parallel agents without collisions

An **entity-scoped claim board** lets a fleet of agents edit one repo safely. Claims are scoped to entity IDs, not files, so two agents can work different functions in the same file, and work that would break another agent's assumptions is flagged *before* it lands.

```sh
hayven claim session/validate --intent "tighten TTL refresh logic"
```

> **Measured:** realized conflict rate **2.4%** vs ~22% naive, and truly-independent work is never blocked.

## 4 · Always fresh, nothing to babysit

A native file watcher re-parses only what changed, so the index never goes stale. Each branch caches its own index, so switching back is instant and never re-embeds. Peers reconcile without a central server via CRDTs and Merkle anti-entropy. Your code never leaves the box.

> **Measured:** watcher idle CPU **≤ 0.0081%** on 30K files · daemon RSS **~43 MB** · a representative day of peer sync **~5.6 KB** on the wire. Runs on a **$599 Mac mini**, or a Raspberry Pi.

---

## Speed, measured (not marketed)

Every number below traces to a committed harness in [`bench/`](bench/). Reproduce them yourself.

| | Hayvenhurst |
|---|---|
| Cold index: hono (362 files, 2,185 entities, 7,250 edges) | **0.65 s** |
| Cold index: gin (Go) | **0.23 s** |
| Cold index: django (2,967 files) | **10.6 s** |
| Cold index: kibana (93,923 files) | **5.4 min · 3.8 GB RAM** (linear) |
| Query latency at 334k entities | **0.27 s** |
| Branch switch (re-parse only the `git diff`) | **~48 ms** |
| Revisit a previously-seen branch (cached) | **1 ms** |

Because the index is embedding-free, building it is a parse plus a SQLite write, with no model-inference tax on every index or branch diff. That's an architectural asymmetry, not a tuning gap.

---

## Quickstart

Pre-release (`0.x`): you build from source. There is no binary release on this repo yet.

**Prerequisites:** [Bun](https://bun.sh) 1.3+ and a Rust toolchain ([rustup](https://rustup.rs/)).

```sh
git clone https://github.com/Davidb3l/Hayvenhurst-dev
cd Hayvenhurst-dev

bun install
( cd native && cargo build --release )        # → native/target/release/hayven-native
bun run build:viewer                           # → viewer/dist/ (so the daemon can serve the UI)
```

Run the CLI straight from source (`hayven` below stands for `bun daemon/src/cli.ts`, or the compiled `daemon/dist/hayven` after `bun run build:daemon`):

```sh
hayven doctor                                  # check Bun, native binary, FTS5, hardware
```

Then, in the project you want to index:

```sh
hayven init                                    # build the index (.hayven/ + first ingest)
hayven query "session validation"              # full-text search over the graph
hayven affected-tests session/validate         # tests a change to this symbol can break
hayven context session/validate                # minimal precise slice for an agent

hayven daemon start                            # serve the HTTP API + graph viewer on :7777
hayven view                                    # open the viewer in your browser
```

Full walkthrough, including the multi-agent conflict-defense flow, in [`docs/QUICKSTART.md`](docs/QUICKSTART.md).

### Install into Claude Code

In Claude Code, add the marketplace and install the plugin. It ships the first-party Skill so the agent reaches for `hayven` instead of grepping:

```text
/plugin marketplace add Davidb3l/Hayvenhurst-dev
/plugin install hayvenhurst@hayvenhurst
```

---

## Architecture

The graph's source of truth is human-readable markdown in `.hayven/`; SQLite is a rebuildable index on top. One Rust binary does the parsing, watching, and inference; a Bun daemon serves the API, holds CRDT state, and runs the conflict defense.

```
            ┌─────────────────────────────────────────────┐
            │                hayvend (Bun)                 │
   agents   │  CLI · HTTP API · CRDT state · claim board   │
  ───────►  │  SQLite index (FTS5) · .hayven/ markdown SoT │ ◄── peers
   query    └───────┬──────────────────┬───────────────┬───┘     (sync)
                    │                  │               │
            hayven-native (Rust)   graph viewer    trace collectors
            parse · watch · infer  localhost:7777   runtime call edges
```

| Component | Stack | Role |
|-----------|-------|------|
| `daemon/` | Bun + TypeScript (`hayvend`) | CLI, HTTP API, CRDT runtime, SQLite index, conflict defense |
| `native/` | Rust (`hayven-native`) | `parse`, `watch`, `serialize`, `infer`, over an NDJSON subprocess protocol |
| `viewer/` | Astro 5 + Preact | SVG-only, level-of-detail graph viewer at `localhost:7777` |
| `trace/` | Python + JS/TS | runtime call-graph collectors (structure only, never argument or return values) |
| `skill/`, `plugin/` | Markdown | first-party Claude Code Skill + plugin |

Design commitments and their rationale are recorded in [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Languages:** Python · TypeScript · JavaScript · Rust · Go, plus pnpm / yarn monorepos.

---

## Philosophy

Five principles, in priority order. When they conflict, the earlier one wins.

1. **Egalitarian by hardware tier**: useful on a Raspberry Pi and on a 4090. Nobody is locked out.
2. **Data-efficiency first**: every byte on the wire must justify itself. Dial-up before fiber.
3. **Local-first, cloud-optional**: your machine is the primary execution environment.
4. **Original where it matters, boring where it doesn't**: custom CRDT serializer, off-the-shelf SQLite.
5. **Distributable, not centralized**: every daemon is potentially a peer.

The longer argument, and the list of dependencies we deliberately said no to, is in [`docs/WHY_HAYVENHURST.md`](docs/WHY_HAYVENHURST.md).

---

## Status

**Pre-release (`0.x`).** Expect breaking changes in every `0.x` release until v1.0. The indexer, file watcher, per-branch caching, runtime trace collectors, `affected-tests`, `context`, the claim board, HTTP API, viewer, and CRDT peer sync all ship. What remains for v1.0 is broader real-world validation and a cross-platform binary release. See [`CHANGELOG.md`](CHANGELOG.md).

## Documentation

- [`docs/QUICKSTART.md`](docs/QUICKSTART.md): a hands-on walkthrough of init, query, affected-tests, the daemon, the viewer, and the conflict-defense flow.
- [`docs/WHY_HAYVENHURST.md`](docs/WHY_HAYVENHURST.md): the design argument for a CRDT-backed distributed graph with a local conflict oracle.
- [`docs/INTEGRATION.md`](docs/INTEGRATION.md): wiring an AI agent in, covering the Skill, the CLI, the HTTP API, and the trace collector.
- [`ARCHITECTURE.md`](ARCHITECTURE.md): the locked design commitments and contracts.

## License & contact

MIT. See [LICENSE](LICENSE). All runtime dependencies across the daemon, native binary, and viewer are permissive (MIT/Apache-2.0/BSD/ISC/CC0/Zlib/Unicode-3.0).

- **Site:** [hayvenhurst.dev](https://hayvenhurst.dev)
- **Security & contact:** [`dev@hayvenhurst.dev`](mailto:dev@hayvenhurst.dev). See [SECURITY.md](SECURITY.md).
- **Contributing:** signed-off commits (`git commit -s`, [DCO](https://developercertificate.org/)). See [CONTRIBUTING.md](CONTRIBUTING.md).

---

<div align="center">
<em>Named after Michael Jackson's family home in Encino, California, in honor of bringing light to overlooked places. This project is a small drop in that ocean.</em>
</div>
