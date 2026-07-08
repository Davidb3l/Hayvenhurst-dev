<div align="center">

# Hayvenhurst

**A persistent, trace-augmented code graph for your repository — one local daemon, queried through the `hayven` CLI.**

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![status](https://img.shields.io/badge/status-pre--release%20(0.x)-orange)
![languages](https://img.shields.io/badge/languages-Python%20·%20TS%20·%20JS%20·%20Rust%20·%20Go-blue)

[Site](https://hayvenhurst.dev) · [Quickstart](docs/QUICKSTART.md) · [Why Hayvenhurst](docs/WHY_HAYVENHURST.md) · [Integration](docs/INTEGRATION.md) · [Architecture](ARCHITECTURE.md)

</div>

## Why

The questions you (or your coding agent) ask all day are structural: *who calls this? what breaks if I change it? which tests can this change actually reach?* grep can't answer them — it finds text, not edges — so the workflow degenerates into grep-and-read-everything: paging dozens of files into a context window to answer a one-line question. And when several agents edit the same repo in parallel, nothing warns them they're about to collide until the merge.

Hayvenhurst keeps a **live graph** of your code instead: every function, class, call, and import, augmented with **runtime traces** of what actually executed. One Rust binary parses (Python, TypeScript, JavaScript, Rust, Go) and watches for changes; a Bun daemon serves the graph over a CLI and HTTP API, and runs an **entity-scoped claim board** so parallel agents flag conflicts *before* editing. Everything is local — SQLite plus markdown in `.hayven/`, no embeddings, no GPU, no cloud, nothing leaves your machine.

## Install

Prebuilt binaries for **macOS (arm64, x64), Linux (x64-glibc, arm64), and Windows (x64)** ship with every [GitHub release](https://github.com/Davidb3l/Hayvenhurst-dev/releases). The install script detects your platform, downloads the matching tarball, **verifies its sha256** against the published `.sha256` file, and installs `hayven` + `hayven-native` into `~/.local/bin` (macOS/Linux):

```sh
curl -fsSL https://raw.githubusercontent.com/Davidb3l/Hayvenhurst-dev/main/plugin/scripts/install-hayven.sh | sh
```

Prefer to verify by hand? Grab the tarball and its `.sha256` from the [releases page](https://github.com/Davidb3l/Hayvenhurst-dev/releases), run `shasum -a 256 -c <tarball>.sha256`, and put the extracted `hayven` on your `PATH` (this is also the Windows path). Or build from source with [Bun](https://bun.sh) 1.3+ and a [Rust toolchain](https://rustup.rs/) — see [`docs/QUICKSTART.md`](docs/QUICKSTART.md).

## Quickstart

```sh
hayven doctor                  # check Bun runtime, native binary, SQLite FTS5, hardware

cd /path/to/your/repo
hayven init                    # create .hayven/, index the repo (sub-second on ~50K-line repos)
hayven daemon start            # serve the HTTP API + graph viewer on :7777 (detached; `hayven daemon stop` to stop)
```

That's it — the daemon's file watcher keeps the index fresh as you edit, and each git branch caches its own index so switching is near-instant.

## Usage tour

**Find things** — full-text search over the graph, then walk it:

```sh
$ hayven query "claim board" --limit 3
# Search: claim board
## `runClaim`         — id: `cli/claim/runClaim`
## `claim`            — id: `cli/claim`
## `claimsRoutes`     — id: `daemon/routes/claims/claimsRoutes`

$ hayven neighbors daemon/routes/claims/claimsRoutes --depth 2   # callers + callees, N hops
$ hayven refs cli/claim/runClaim                                 # exhaustive callers ∪ importers
```

**Measure blast radius** — what transitively depends on a symbol:

```sh
$ hayven impact daemon/routes/claims/claimsRoutes --depth 2
# Impact (transitive blast radius) of `daemon/routes/claims/claimsRoutes`
30 dependent(s) within 2 hop(s) — 1 direct, 1 direct call site(s).
- [depth 1] `daemon/server/buildApp`
- [depth 2] `daemon/server/buildMultiProjectApp`
- [depth 2] `daemon/tests/claims.test/makeApp`
...
```

**Select tests** — the tests a change can actually break, fusing the static graph with runtime traces (run your suite once with `HAYVEN_TRACE=1` and a [trace collector](trace/) to add trace edges; `--order` gives fail-fast ordering):

```sh
$ hayven affected-tests daemon/routes/claims/claimsRoutes
# Affected tests for `daemon/routes/claims/claimsRoutes`
55 test(s) to run — 0 trace, 55 static
- [static] `daemon/tests/claims.test/makeApp`  (depth 2, run: daemon/tests/claims.test.ts)
...
```

**Feed agents precisely** — a minimal line-exact slice (entity + real dependencies) instead of whole files:

```sh
hayven context daemon/routes/claims/claimsRoutes
```

**Coordinate parallel agents** — claims are scoped to entity IDs, not files, so two agents can safely edit different functions in the same file:

```sh
hayven claim auth/session/validate --intent "tighten TTL refresh"   # registered (exit 0)
hayven claim auth/session/validate --intent "rename validator"      # overlap → rejected (exit 1)
hayven claim auth/session/login    --intent "change return shape"   # graph-adjacent → conflict verdict (exit 3)
hayven release <claim_id>                                           # done — free the scope
```

Also shipped: `hayven traces <id>` (runtime call history), `remember`/`recall` (durable graph-keyed notes shared across agents), `view` (SVG graph viewer at `localhost:7777`), `plan-lanes` (partition a change-set into conflict-disjoint lanes), `mcp` and `proxy` (agent integration surfaces), and `sync <peer_url>` (serverless CRDT peer sync). `hayven help` lists everything; most commands take `--json` for machine-readable output.

## Using it from Claude Code

The first-party plugin ships an Agent Skill so Claude Code reaches for `hayven` instead of grepping, plus a command that installs the binary (same checksum-verified script as above):

```text
/plugin marketplace add Davidb3l/Hayvenhurst-dev
/plugin install hayvenhurst@hayvenhurst
/hayvenhurst:install-binary
```

Other agents can use the [MCP server, HTTP API, or CLI directly](docs/INTEGRATION.md).

## Performance

The index is embedding-free — building it is a parse plus a SQLite write — so it's fast enough to never think about: cold index of hono (362 files) in **0.65 s**, a branch switch re-parses only the `git diff` (**~48 ms**), revisiting a cached branch is a **1 ms** read, and the idle watcher rounds to zero CPU. Reproduce these on your machine with the committed harness in [`bench/`](bench/) (`bench/wedge-demo.sh`).

## Documentation

- [`docs/QUICKSTART.md`](docs/QUICKSTART.md) — hands-on walkthrough: init, query, affected-tests, daemon, viewer, and the multi-agent conflict-defense flow.
- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — wiring an AI agent in: the Skill, MCP, the HTTP API, and the trace collectors.
- [`docs/CI_AFFECTED_TESTS.md`](docs/CI_AFFECTED_TESTS.md) — running only affected tests in CI ([`ci/hayven-affected-tests.sh`](ci/hayven-affected-tests.sh)).
- [`docs/WHY_HAYVENHURST.md`](docs/WHY_HAYVENHURST.md) — the design argument.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the locked design commitments and contracts.

## Status, license, contact

**Pre-release (`0.x`)** — expect breaking changes in every `0.x` release until v1.0; see [`CHANGELOG.md`](CHANGELOG.md). **MIT** licensed ([LICENSE](LICENSE)); all runtime dependencies are permissive. Security reports and contact: [`dev@hayvenhurst.dev`](mailto:dev@hayvenhurst.dev) ([SECURITY.md](SECURITY.md)). Contributions welcome with signed-off commits ([CONTRIBUTING.md](CONTRIBUTING.md)).

---

<div align="center">
<em>Named after Michael Jackson's family home in Encino, California, in honor of bringing light to overlooked places. This project is a small drop in that ocean.</em>
</div>
