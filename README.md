# Hayvenhurst

![version](https://img.shields.io/badge/version-0.0.4-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![index](https://img.shields.io/badge/index-embedding--free-orange) ![setup](https://img.shields.io/badge/setup-zero--config-brightgreen) ![languages](https://img.shields.io/badge/languages-Python%20·%20TS%20·%20JS%20·%20Rust%20·%20Go-lightgrey)

**The fastest way to keep an always-fresh, private structural index of a codebase — no model, no embeddings, no setup.**

Hayvenhurst indexes your code into a structural graph (entities + call/import edges + runtime trace coverage) with a Tree-sitter parser and SQLite. There is **no embedding model, no GPU, no vector database, and nothing leaves your machine** — which makes the index *sub-second cold, instant on a cached branch, and trivially private*. It's the [Bun](https://bun.sh) approach (win on speed + zero-config), applied to code indexing.

## Why it's different (measured, reproducible)

Every number below comes from a committed harness ([`bench/`](bench/)), re-verified cross-language on the current build.

| | **Hayvenhurst** | Embedding-based indexer (`cocoindex-code`) |
|---|---|---|
| Cold index (gin, Go) | **0.23 s** | — |
| Cold index (hono, 362 files) | **0.65 s** | 35.6 s (embeds 3,543 chunks) |
| Cold index (fastapi, 1,120 files) | **1.6 s** | 260 s (embeds the repo) |
| Branch switch (re-parse only the `git diff`) | **~50–150 ms** | re-syncs + re-embeds every switch |
| Revisit a previously-seen branch | **1 ms** (cached) | 0.41 s |
| Retrieval coverage on novel symptom queries | **3 / 3** | 0 / 3 |
| Dependencies to run | **none** (Rust binary + SQLite) | model + torch + a vector store |

Because the index is **embedding-free**, building it is a parse plus a SQLite write — no model-inference tax on every index or branch diff. The asymmetry is architectural, not a tuning gap: an embedding-based indexer *must* re-embed (so the cost grows with the repo — note the gap widening from gin → hono → fastapi), while a parse-and-write index stays sub-second and caches per branch.

### Reproduce the wedge in 60 seconds

```sh
export HAYVEN_NATIVE_BIN="$PWD/native/target/release/hayven-native"
git clone --depth 50 https://github.com/honojs/hono /tmp/hv-switch
bun bench/branch-switch-cost.ts /tmp/hv-switch 3      # cold-index + branch-switch timings on a real repo
```

…which prints, on a real machine (hono, 362 files):

```text
──────── summary ────────
cold full ingest (base):       673 ms
full ingest WITHOUT seeding:   616 ms   (a whole-tree re-index per switch)
seed + diff (cheap switch):     47 ms   (92% cheaper than a full re-index)
revisit read (cached index):     0 ms   (100% cheaper — no ingest at all)
```

## Who it's for

Hayvenhurst is infrastructure for **builders of AI-coding and code-intelligence tools** — agents, IDEs, PR bots, CI — that need fast, private, always-fresh structural code context as a component, without paying an embedding tax on every repo / branch / worktree. (For an interactive developer typing one-off searches, `grep` is fine — that is not the wedge. We win on speed, freshness, and privacy, not on retrieval *quality*: embeddings still beat us on fuzzy semantic recall.)

It runs on a $599 Mac mini, costs nothing if you already have the hardware, and plugs into Claude Code through a first-party Skill.

## Status

**Pre-release (`0.x`).** Expect breaking changes in every `0.x` release until v1.0. The indexer, file watcher, per-branch caching, runtime trace collectors, HTTP API, viewer, and CRDT peer-sync all ship. What remains for v1.0 is the cross-platform binary release and broader real-world validation. See [`CHANGELOG.md`](CHANGELOG.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md) for specifics.

## What it does

- **Indexes your code into a graph — fast, embedding-free.** Tree-sitter parses five languages (Python, TypeScript, JavaScript, Rust, Go) into entities (functions, classes, modules) and edges (calls, imports) and writes a SQLite index. Sub-second cold, no model, no GPU, no vector store.
- **Stays fresh automatically.** A native file watcher re-parses only what changed, so the index never goes stale — and a per-branch cache makes switching branches a millisecond read instead of a full re-index (and never a re-embed).
- **Augments structure with runtime traces.** Five-language collectors capture call-graph structure only (never argument or return values) and feed observed edges + per-test coverage back into the graph.
- **Exposes structured access for the tools you build on it.** A CLI and HTTP API answer "what calls X", "what does X depend on", "which tests exercise X", and return graph-precise context slices — so an agent/IDE/bot consumes structure instead of re-reading whole files.
- **Coordinates and syncs without a server.** An entity-scoped claim board lets parallel agents edit safely; every daemon is a peer, reconciling state via Merkle anti-entropy over plain HTTP (~5.6 KB for a representative day).
- **Visualizes the graph.** An Astro viewer (SVG-only, level-of-detail force layout) served at `localhost:7777`.

## Architecture at a glance

```
            ┌─────────────────────────────────────────────┐
            │                hayvend (Bun)                 │
   agents   │  CLI  ·  HTTP API  ·  CRDT state  ·  oracle  │
  ───────►  │  SQLite index (FTS5)   .hayven/ markdown SoT │ ◄── peers
   query    │  conflict defense (A/B/C)   model strata     │     (sync)
  /claim    └───────┬──────────────────┬───────────────┬───┘
                    │                  │               │
            hayven-native (Rust)   Astro viewer   hayven-trace (Python)
            parse · watch ·        localhost:7777  sys.settrace →
            serialize · infer                      /api/traces/observations
```

| Component | Stack | Role |
|-----------|-------|------|
| `daemon/` | Bun + TypeScript (`hayvend`) | CLI, HTTP API, CRDT runtime, SQLite index, conflict defense, model lifecycle |
| `native/` | Rust (`hayven-native`) | `parse`, `watch`, `serialize`, `infer` — companion binary over an NDJSON subprocess protocol |
| `viewer/` | Astro 5 + Preact | SVG-only graph viewer with level-of-detail; served at `localhost:7777` |
| `trace/python/` | Python (`hayven_trace`) | runtime call-graph collector (stdlib-only) |
| `skill/` | Markdown | first-party Claude Skill |

The markdown in `.hayven/nodes/` is the source of truth; the SQLite database is a derived index you can drop and rebuild with `hayven reindex`. Design commitments and their rationale are recorded in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Install / build

Install scripts and prebuilt tarballs land closer to v1.0. Until then, build from source. You will need:

- [Bun](https://bun.sh) 1.3 or newer
- A Rust toolchain (install via [rustup](https://rustup.rs/))

```sh
git clone https://github.com/Davidb3l/hayvenhurst
cd hayvenhurst

bun install                                   # workspace deps
( cd native && cargo build --release )        # → native/target/release/hayven-native
bun run build:viewer                          # → viewer/dist/ (so the daemon can serve the UI)
```

Run `hayven` straight from source with Bun:

```sh
bun daemon/src/cli.ts doctor                  # check Bun, native binary, FTS5, model strata
```

If you build the compiled daemon binary, the same CLI is available as a single executable:

```sh
bun run build:daemon                          # → daemon/dist/hayven
daemon/dist/hayven doctor
```

In the quickstart below, `hayven` stands for whichever you use (`bun daemon/src/cli.ts` or the compiled `dist/hayven`).

## 60-second quickstart

```sh
# 1. In your project, build the index (creates .hayven/ + first ingest)
hayven init

# 2. Search the graph
hayven query "session validation"

# 3. Walk the graph around an entity (use an id from the query output)
hayven neighbors auth/session/validate --depth 2

# 4. Start the daemon — serves the API + viewer on localhost:7777
hayven daemon start &

# 5. Open the viewer, or hit the API
hayven view
curl -s http://localhost:7777/api/health
```

Full walkthrough — including the multi-agent conflict-defense flow — is in [`docs/QUICKSTART.md`](docs/QUICKSTART.md).

## Documentation

- [`docs/QUICKSTART.md`](docs/QUICKSTART.md) — hands-on getting started: init, query, daemon, viewer, the conflict-defense flow.
- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — how an AI coding agent integrates: the Skill, the CLI, the HTTP API, and the trace collector.
- [`docs/WHY_HAYVENHURST.md`](docs/WHY_HAYVENHURST.md) — the design argument: why a CRDT-backed distributed graph with a local conflict oracle, and what we deliberately built ourselves.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — locked design commitments and contracts.
- [`docs/DESIGN_LESSONS.md`](docs/DESIGN_LESSONS.md) — patterns distilled from real bugs found in this repo.

## Philosophy

Five principles, in priority order. When they conflict, earlier wins.

1. **Egalitarian by hardware tier** — useful on a Raspberry Pi and on a 4090. Nobody is locked out.
2. **Data-efficiency first** — every byte on the wire must justify itself. Dial-up before fiber.
3. **Local-first, cloud-optional** — your machine is the primary execution environment.
4. **Original where it matters, boring where it doesn't** — custom CRDT serializer, off-the-shelf SQLite.
5. **Distributable, not centralized** — every daemon is potentially a peer.

The longer argument — and the list of dependencies we deliberately said no to — is in [`docs/WHY_HAYVENHURST.md`](docs/WHY_HAYVENHURST.md).

## License

MIT — see [LICENSE](LICENSE). All runtime dependencies across the daemon, native binary, and viewer are permissive (MIT/Apache-2.0/BSD/ISC/CC0/Zlib/Unicode-3.0); see `CHANGELOG.md` for the one transitive build-time advisory being tracked.

## Security

Please report vulnerabilities to `dev@hayvenhurst.dev`. See [SECURITY.md](SECURITY.md) for the disclosure process and the signing key.

## Contributing

Hayvenhurst uses [DCO](https://developercertificate.org/). Every commit must be signed off with `git commit -s`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full process.

---

*Named after Michael Jackson's family home in Encino, California. In honor of his contribution to the world — bringing light to overlooked places, fighting bad-faith systems, lifting up those without resources. This project is a small drop in that ocean.*
