# Quickstart

A hands-on tour of Hayvenhurst: install, index a project, query the graph, run the daemon, open the viewer, and exercise the multi-agent conflict-defense flow. Every command and flag below exists in the shipped CLI (`daemon/src/cli/`).

## 0. Prerequisites

- [Bun](https://bun.sh) 1.3 or newer.
- A Rust toolchain ([rustup](https://rustup.rs/)) — needed to build `hayven-native`.

Build from source (no install scripts yet in `0.x`):

```sh
git clone https://github.com/Davidb3l/hayvenhurst
cd hayvenhurst

bun install
( cd native && cargo build --release )        # → native/target/release/hayven-native
bun run build:viewer                          # → viewer/dist/ (so the daemon can serve the UI)
```

Throughout this guide, `hayven` means the CLI entry point. Run it either straight from source:

```sh
bun /absolute/path/to/hayvenhurst/daemon/src/cli.ts <command>
```

or as the compiled single binary after `bun run build:daemon`:

```sh
/absolute/path/to/hayvenhurst/daemon/dist/hayven <command>
```

A convenient shell alias for the rest of this guide:

```sh
alias hayven='bun /absolute/path/to/hayvenhurst/daemon/src/cli.ts'
```

The native binary is discovered automatically when it sits at `native/target/release/hayven-native` inside the repo, or you can point at it explicitly:

```sh
export HAYVEN_NATIVE_BIN="$PWD/native/target/release/hayven-native"
```

Confirm your environment:

```sh
hayven doctor
```

`doctor` reports your Bun version, whether `hayven-native` was found, SQLite FTS5 availability, detected hardware, and (once a project exists) whether a Layer C model is downloaded. It exits non-zero if a required check fails.

## 1. Initialize a project

From the root of the repository you want to index:

```sh
hayven init
```

`init` detects the repo root (walks up for a `.git/`), creates the `.hayven/` directory tree, writes a default `config.json`, initializes the SQLite schema, copies the Skill template into `.claude/skills/` if `skill/hayvenhurst.md` is present, and runs a first full ingest. On a ~50K-line polyglot repo this completes in well under a second (measured ~0.7 s on an Apple M4).

You can target a different directory without `cd`-ing into it:

```sh
hayven init --cwd /path/to/some/project
```

If `.hayven/` already exists, `init` refuses and points you at `hayven reindex` or `rm -rf .hayven/`.

To re-scan after `init` (incremental by default; the running daemon also does this automatically via its file watcher):

```sh
hayven ingest                  # whole-repo re-parse (idempotent: clears + rebuilds)
hayven ingest src/ --full      # re-scan a subtree, forcing a clean rebuild of it
hayven ingest --json           # machine-readable result (files/nodes/edges/warnings)
```

## 2. Query the graph

Full-text search over indexed entities (FTS5 trigram):

```sh
hayven query "session validation"
hayven query "session validation" --limit 5
hayven query "session validation" --json
```

Output is markdown by default — each hit shows the entity name, its id (e.g. `auth/session/validate`), its qualified name, and a short summary. Use `--json` when you want structured data.

Walk the graph around an entity (use an id from `query`):

```sh
hayven neighbors auth/session/validate
hayven neighbors auth/session/validate --depth 2
hayven neighbors auth/session/validate --depth 2 --json
```

`neighbors` traverses both incoming (callers) and outgoing (callees) edges, up to `--depth` hops (1–5, default 1), and prints the edges with their kind and weight. If the id isn't found it suggests `hayven query` to fuzzy-find it.

> Note on `hayven traces <id>`: this reads per-entity runtime trace history — observed + resolved callers/callees with invocation counts — collected via the five trace collectors and the `/api/traces/observations` endpoint (see [`docs/INTEGRATION.md`](INTEGRATION.md)). Trace edges also show up in `hayven neighbors`.

## 3. Start the daemon

The daemon serves the HTTP API and the viewer, holds the CRDT state in memory, runs the native file watcher for incremental re-ingest, and answers claim requests.

```sh
hayven daemon start            # foreground; serves http://127.0.0.1:7777
```

It runs in the foreground (press Ctrl-C to stop). To run it in the background, append `&` in your shell. Other controls:

```sh
hayven daemon status           # running / stale / stopped (exit 0 only when running)
hayven daemon stop             # SIGTERM the recorded pid
```

The host and port come from the project config (defaults `127.0.0.1:7777`). Inspect or change them:

```sh
hayven config                  # print the merged effective config + sources
hayven config daemon_port      # read one value
hayven config daemon_port 8080 # write it into the project's .hayven/config.json
```

Confirm the daemon is up:

```sh
curl -s http://localhost:7777/api/health
# → {"ok":true,"version":"0.0.1","native_version":"present"}
```

## 4. Open the viewer

With the daemon running:

```sh
hayven view                    # opens http://127.0.0.1:7777/ in your browser
```

The viewer is an SVG-only, level-of-detail graph renderer (custom force layout, semantic clustering, viewport culling). It must be built first (`bun run build:viewer`); if it isn't, the daemon's static routes return a "viewer not built" message and the API still works.

## 5. The conflict-defense flow (multiple agents)

The claim board is how two agents avoid stepping on each other. Claims are scoped to **entity IDs**, not files — so two agents can edit different functions in the same file safely. Registration runs three checks (ARCHITECTURE.md §17):

- **Layer A — overlap.** If your scope intersects an active claim's scope, that's a hard conflict → HTTP `409`, CLI exit `1`.
- **Layer C — adjacency.** If your scope is graph-adjacent to an active claim (a call/import edge connects them, or they share a module prefix), the daemon runs a conflict oracle. If it flags a potential conflict → HTTP `202`, CLI exit `3`, and the claim is **not** registered.
- **Layer B — pre-merge verify.** After the file watcher merges a change, the affected files are re-parsed (Tree-sitter ERROR/MISSING detection) and, where a typechecker is configured, type-checked. Failures are recorded as `merge_rejected` (visible via the API) without ever rolling back the converged CRDT.

The default Layer C oracle is the deterministic `heuristic-v1` — zero config, no download. It activates an LLM oracle only after you pull a model (see step 6).

Walk it through with the daemon running:

```sh
# Agent 1 claims a function.
hayven claim auth/session/validate --intent "tighten TTL refresh logic"
# → "# Claim registered" with a claim id; exit 0.

# Agent 2 claims the SAME entity → hard overlap.
hayven claim auth/session/validate --intent "rename the validator"
# → error: scope overlaps active claim ...; exit 1.

# Agent 2 claims an ADJACENT entity (a caller/callee) → oracle preview.
hayven claim auth/session/login --intent "change the validate() return shape"
# → may print "# Potential conflict — claim NOT registered" with a verdict; exit 3.
```

When you get a `202`/exit-3, the right move is to coordinate (read the other claim's intent). If you've decided the work is genuinely independent, register anyway and record the override for audit:

```sh
hayven claim auth/session/login --intent "change the validate() return shape" --force
# → registers (exit 0) and records the overridden verdict(s) on the claim.
```

Other useful flags on `claim`:

```sh
hayven claim <ids...> --intent "..." --agent agent-2 --ttl 1800 --json
```

`--intent` is required. `--agent` labels the claimant (default `cli`), `--ttl` is the claim lifetime in seconds (default 3600), and `--json` returns the raw status + payload.

> Note on `hayven release <claim_id>`: this releases a claim via `DELETE /api/claims/:id` (see [`docs/INTEGRATION.md`](INTEGRATION.md)) with a daemon-identity guard so it only mutates the board for this repo. Every claim also carries a TTL after which it expires, but release explicitly — don't rely on the TTL.

## 6. (Optional) Enable the local LLM oracle

By default Layer C uses the deterministic heuristic and needs no model. To upgrade it to a local LLM oracle, list and pull a model:

```sh
hayven models list             # registry entries + on-disk presence (tier, params, min RAM)
hayven models pull gemma4:e2b  # download + sha256-verify + atomically install into .hayven/models/
```

Weights are an opt-in download (~1–2 GB), never bundled, and the pull is idempotent. Inference runs in-process via `hayven-native infer` (candle, pure Rust); the oracle has a hard timeout and falls back to the heuristic on any error, so the claim path is never blocked on the model.

Check what `doctor` sees once a model is configured/present:

```sh
hayven doctor
# → "Configured tier-3 model ...: PRESENT  OK / Layer C will use the LLM oracle."
#   or "NOT DOWNLOADED ... Until then, Layer C uses the deterministic heuristic-v1 oracle (no LLM)."
```

> The LLM oracle now loads real Gemma weights and returns real calibrated verdicts (BL-18 resolved). But the **shipping default Layer-C oracle is the deterministic, local, no-LLM `contract-diff` oracle** (it degrades to the heuristic without a native binary + Db) — measurement found the single-shot local LLM over-blocks worse than the heuristic as prompted, so the LLM oracle remains experimental, not the default. See `docs/ORACLE_WARMTH_DECISION.md`.

## 7. Sync with a peer

Every daemon is a peer. To reconcile CRDT state with another daemon over HTTP (Merkle anti-entropy — pulls the segments you're missing, pushes the ones the peer is missing):

```sh
hayven sync http://teammate.local:7777
```

It prints how many segments/bytes were pulled and pushed, the round-trip count, and the duration. A representative day of sync was measured at ~5.6 KB on the wire.

## Where to go next

- [`docs/INTEGRATION.md`](INTEGRATION.md) — wiring an AI agent in: the Skill, the HTTP API surface, and the trace collector.
- [`docs/WHY_HAYVENHURST.md`](WHY_HAYVENHURST.md) — the design argument behind all of the above.
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — the locked contracts (entity IDs, NDJSON IPC, CRDT wire format, conflict defense, model strata).
