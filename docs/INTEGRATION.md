# Integration

How an AI coding agent plugs into Hayvenhurst. There are four integration surfaces, in rough order of how most agents will use them:

1. The **first-party Skill** — the declarative contract that tells an agent when and how to use the graph.
2. The **CLI** — one shell call per operation; markdown by default, `--json` when you need structure.
3. The **HTTP API** — the daemon's routes, for tools that prefer to speak HTTP directly.
4. The **trace collector** — feeding runtime call edges back into the graph.

All four talk to the same daemon (`hayvend`) and the same `.hayven/` state. The markdown in `.hayven/nodes/` is the source of truth; SQLite is a derived index.

## 1. The first-party Skill (`skill/`)

The Skill lives at [`skill/hayvenhurst.md`](../skill/hayvenhurst.md). `hayven init` copies it into the project's `.claude/skills/hayvenhurst.md` (when the template is present), so a Claude Code session in the repo picks it up automatically.

The Skill is deliberately **not** an MCP server and **not** a long-running socket. It's a markdown contract that does three things:

- **Tells the agent when to reach for the graph** — before reading more than ~3 files to answer a structural question, before starting parallel work, when the user asks "what calls X" / "what depends on X" / "where is X used".
- **Documents the CLI surface** the agent should call (`init`, `ingest`, `query`, `neighbors`, `claim`, `sync`, `view`, `daemon`, `doctor`, `config`).
- **Encodes the coordination etiquette** — claim before editing, respect adjacent-claim warnings, release when done.

Why a Skill instead of an MCP server: it keeps the integration stateless (every command is one shell call), avoids a persistent process the agent has to manage, and means the "intelligence" lives in the agent's existing tool loop rather than a separate runtime. This is a deliberate design choice (see [`docs/WHY_HAYVENHURST.md`](WHY_HAYVENHURST.md) and ARCHITECTURE.md §9).

> The full agent-facing CLI surface is shipped, including `hayven traces <id>` (per-entity runtime trace history), `hayven release <claim_id>` (releases a claim via `DELETE /api/claims/:id` with a daemon-identity guard), and the v0.0.4 graph commands `hayven refs` / `hayven importers` / `hayven impact` plus `hayven query --path`. See the CLI section below for the complete table.

## 2. The CLI (`daemon/src/cli/`)

The CLI is the primary agent surface. It is hand-rolled (no argument-parsing library), markdown-by-default, and accepts `--json` on the read commands for structured output. Each subcommand maps to a file under `daemon/src/cli/`.

| Command | Status | Purpose |
|---------|--------|---------|
| `hayven init [--cwd DIR]` | shipped | Create `.hayven/`, init schema, copy Skill, run first ingest. |
| `hayven ingest [path] [--full] [--json]` | shipped | Re-scan the codebase; whole-repo runs clear+rebuild for idempotence. |
| `hayven query <terms...> [--limit N] [--path <prefix>] [--json]` | shipped | FTS5 search; returns matching entities as markdown. `--path` scopes to a repo-relative subtree. |
| `hayven neighbors <id> [--depth N] [--json]` | shipped | Walk callers + callees up to N (1–5) hops. |
| `hayven refs <id> [--json]` | shipped | EXHAUSTIVE callers ∪ importers of a symbol (edges-backed, not ranked top-N). |
| `hayven importers <module-id> [--json]` | shipped | EXHAUSTIVE list of every node that imports the module (edges-backed). |
| `hayven impact <id> [--depth N] [--json]` | shipped | Transitive blast radius — every dependent reachable through call+import edges. |
| `hayven affected-tests <symbol> [--changed a,b] [--trace-only] [--order] [--limit N] [--json]` | shipped | Minimal tests to run for a change — static impact graph ∪ per-test runtime coverage. Two confidence tiers: `observed` (coverage proved the test ran the change; precision ~1.0) and `reachable` (graph/transitive safety net; recall 1.0). `--trace-only`=observed only; `--order`=fail-fast APFD. |
| `hayven remember "<note>" [--node <id>] [--kind K] [--scope a,b] [--ttl S] [--json]` | shipped | Record a fleet-memory note (decision/deadend/gotcha/note) keyed to the graph. |
| `hayven recall [<term>] [--node <id>] [--kind K] [--json]` / `recall --forget <id>` | shipped | Recall fleet memory by node, substring, or kind; `--forget` deletes one. |
| `hayven claim <ids...> --intent "..." [--agent X] [--ttl S] [--force] [--json]` | shipped | Register an entity-scoped work claim (Layers A + C). |
| `hayven sync <peer_url>` | shipped | Merkle anti-entropy pull/push with a peer. |
| `hayven daemon <start\|stop\|status>` | shipped | Daemon lifecycle. |
| `hayven view` | shipped | Open the viewer in a browser. |
| `hayven doctor` | shipped | Diagnose Bun / native binary / FTS5 / hardware / model presence. |
| `hayven config [key] [value]` | shipped | Read/write configuration. |
| `hayven reindex` | shipped | Drop SQLite and rebuild from the markdown source of truth. |
| `hayven models <list\|pull <id>>` | shipped | Local model lifecycle (download + sha256-verify + install). |
| `hayven traces <id>` | shipped | Reads per-entity runtime trace history (observed + resolved callers/callees, invocation counts). |
| `hayven release <claim_id>` | shipped | Releases a claim via CLI (`DELETE /api/claims/:id` with a daemon-identity guard). |

### Claim exit codes

The `claim` command maps the daemon's HTTP status to a process exit code, which is what an agent should branch on:

- `0` — registered (`201`).
- `3` — potential conflict, **not** registered (`202`); coordinate or re-run with `--force`.
- `1` — hard overlap or error (`409`/other).

## 3. The HTTP API (`daemon/src/daemon/routes/`)

The daemon is an Elysia app; routes live in `daemon/src/daemon/routes/`. The default base URL is `http://127.0.0.1:7777` (configurable via `daemon_host` / `daemon_port`). Tools that prefer HTTP over shelling out can use these directly.

> Implementation note: the daemon's request router is hostname-sensitive in tests — use `localhost`/`127.0.0.1`, not arbitrary hostnames.

### Health & stats

| Method & path | Source | Returns |
|---------------|--------|---------|
| `GET /api/health` | `routes/health.ts` | `{ ok, version, native_version }` |
| `GET /api/stats` | `routes/stats.ts` | node/edge counts, trace count, `gset_ops`, `last_trace`, `last_ingest_at`, `merge_rejections`, `port` |

### Graph reads

| Method & path | Source | Returns |
|---------------|--------|---------|
| `GET /api/search?q=...&limit=...` | `routes/search.ts` | `{ query, count, hits }` (FTS5; `q` required, `limit` 1–100, default 20) |
| `GET /api/nodes/:id` | `routes/nodes.ts` | `{ node, neighbors: { callers, callees }, markdown }`; `404` if unknown |
| `GET /api/neighbors/:id?depth=&cluster=&scope=` | `routes/stats.ts` | graph edges around a node; `cluster` ∈ `auto`/`off`/`module`, optional `scope` prefix filter |
| `GET /api/affected-tests?id=&changed=&trace_only=&limit=&depth=` | `routes/affected_tests.ts` | minimal tests to run; `{ symbol\|changed, roots, count, traceEdgeCount, note, tests }`. Each test carries `confidence` (`observed`/`reachable`). `changed` (comma files) takes precedence over `id`. |
| `GET /api/memory?node=&q=&kind=&limit=` · `POST /api/memory` · `DELETE /api/memory/:id` | `routes/memory.ts` | Fleet memory: list/search notes, record one (`{note,kind,nodeId?,scope?,ttl?}`), delete one. Reads exclude expired. |
| `POST /api/traces/observations` (now accepts `test_coverage[]`) | `routes/traces.ts` | additive: per-test coverage rows `{test,entity,weight}` alongside the global `observations` graph (schema v6). |
| `GET /api/merge-rejections?limit=` | `routes/stats.ts` | Layer B `merge_rejected` files (the visible-conflict signal); `{ count, rejections }` |

### Ingest

| Method & path | Source | Behavior |
|---------------|--------|----------|
| `POST /api/ingest` | `routes/ingest.ts` | Trigger an ingest; body `{ full?: boolean }`. Returns `{ ok, result }`, or `409` if one is already running. |

### Claims (the coordination surface)

| Method & path | Source | Behavior |
|---------------|--------|----------|
| `GET /api/claims` | `routes/claims.ts` | `{ claims, total, active, expired }` |
| `POST /api/claims` | `routes/claims.ts` | Register a claim. Status: `201` registered, `409` overlap (hard conflict, names the conflicting claim + overlapping entities), `202` adjacent potential-conflict (not registered unless `force:true`), `400` invalid body. |
| `DELETE /api/claims/:id` | `routes/claims.ts` | Release a claim; `404` if not found. |

`POST /api/claims` body (matches what the `hayven claim` CLI sends):

```json
{
  "id": "claim_ab12cd34",
  "agent": "agent-2",
  "intent": "tighten TTL refresh logic",
  "scope": ["auth/session/validate"],
  "fingerprint": "cli:unfingerprinted",
  "ttlSeconds": 3600,
  "force": false
}
```

On a `202`, the response carries `verdicts` (each `{ conflict, reason, confidence, oracle }`). On a `force` registration over a flagged adjacency, the overridden verdicts are recorded on the claim for audit (`overriddenVerdicts`) — local, non-replicated metadata, not part of the CRDT wire payload.

### Sync (peer reconciliation)

| Method & path | Source | Role |
|---------------|--------|------|
| `GET /api/sync/merkle` | `routes/sync.ts` | per-CRDT-type Merkle roots |
| `POST /api/sync/leaves` | `routes/sync.ts` | leaf hashes for one CRDT type (`{ type }`) |
| `POST /api/sync/batch` | `routes/sync.ts` | stream one segment's bytes by offset (`x-segment-eof` header signals the end) |
| `POST /api/sync/push` | `routes/sync.ts` | apply one base64 op batch into the local CRDT |

`hayven sync <peer>` orchestrates these: it compares roots, pulls divergent/missing segments, and pushes segments the peer lacks — one round-trip per divergent segment plus the initial root + leaves exchange.

### WebSocket

| Path | Source | Status |
|------|--------|--------|
| `/ws/sync` | `routes/ws.ts` | shipped — sends a `hello` frame, then streams local CRDT ops to peers via `CrdtState.onOps()` (fires only on local writes, never re-broadcasts inbound ops); inbound ops are validated/applied through the same path as `POST /api/sync/push`. The `/api/sync/*` HTTP Merkle path is the catch-up/heal complement. |

### Viewer static routes

`routes/viewer.ts` serves the built Astro app (`/`, `/node/*`, static assets) and `GET /__viewer/status`. These run after all `/api/*` routes have had a chance to match.

## 4. The trace collector (`trace/python/`)

`hayven_trace` is a standalone, stdlib-only Python package that captures **call-graph structure only** — never argument or return values (PRD §9.4). It hooks `sys.settrace`, aggregates in-process, and flushes batches to the daemon.

### Programmatic

```python
import hayven_trace

hayven_trace.start(
    daemon_url="http://localhost:7777",
    sample_rate=100,            # 1-in-100 calls observed (~1% overhead)
    flush_interval_seconds=30,
    project_paths=["/path/to/my/project"],   # optional scope limit
)
# ... your code runs ...
hayven_trace.stop()
```

### Pytest

```sh
HAYVEN_TRACE=1 pytest
# or
pytest -p hayven_trace --hayven-trace
```

Environment variables (see [`trace/python/README.md`](../trace/python/README.md)): `HAYVEN_TRACE`, `HAYVEN_TRACE_URL`, `HAYVEN_TRACE_RATE`, `HAYVEN_TRACE_INTERVAL`, `HAYVEN_TRACE_PROJECT`, `HAYVEN_TRACE_INCLUDE_STDLIB`.

### Wire format

The flusher POSTs to `${daemon_url}/api/traces/observations` (`routes/traces.ts`):

```json
{
  "source": "python",
  "sample_rate": 100,
  "observations": [
    { "src": "myapp.auth:login", "dst": "myapp.db:get_user", "ts": 1715789520, "observed": 5, "weight": 500 }
  ]
}
```

The contract the daemon enforces:

- `source` (non-empty string) and `sample_rate` (positive integer) are required.
- Each observation carries both `observed` (raw sample count) and `weight` (scaled estimate). The daemon verifies `weight ≈ observed * sample_rate` (±1 rounding slack) and rejects mismatched payloads with `400` — no hidden math on the wire.
- `observed` and `weight` must each fit in a `uint16` (≤ 65535); split larger batches.
- `src`/`dst` are stable node ids (`<module>:<qualname>`), matching the daemon's code-entity convention.

Each accepted observation becomes a G-Set op appended to the on-disk op log and applied to the in-memory CRDT, with the SQL `observations` table kept as a denormalized read cache. The endpoint returns `{ ok, accepted, source, sample_rate }`.

## Putting it together: an agent's loop

A typical agent integration:

1. On session start in a repo, the Skill fires; if `.hayven/` is missing, run `hayven init`.
2. Make sure the daemon is up (`hayven daemon status`; start it if not).
3. To answer a structural question, `hayven query` then `hayven neighbors` instead of reading files.
4. Before editing shared scope, `hayven claim <ids...> --intent "..."` and branch on the exit code (0 proceed / 3 coordinate / 1 stop).
5. After running the test suite (with `HAYVEN_TRACE=1`), the graph gains runtime edges — future queries reflect what actually executed.
6. When done, release the claim (via `DELETE /api/claims/:id` until the CLI `release` ships) or let its TTL expire.

### Recipe: run only the affected tests after an edit

Instead of running the whole suite each iteration, select the tests that reach what you changed:

```sh
# After editing some files, ask which tests exercise them:
hayven affected-tests --changed src/auth/session.ts,src/auth/token.ts --json
# → { roots, tests: [{ id, evidence: "trace"|"static", depth, runnable, runner }], traceEdgeCount, note }

# Run just those tests (the `runnable` field is the runner handle):
pytest tests/test_session.py::test_refresh tests/test_token.py   # from the pytest runnables
```

The selection fuses two signals: the **static** impact graph (reverse call+import walk) and the **runtime trace** map. A test tagged `trace` was *observed* exercising the code — ground truth that catches paths the static graph misses (e.g. a test that reaches a symbol through a re-export has no static edge to the real definition, so static-only selection would skip it). Cold start: with no traces yet the result is static-only and says so in `note` — run the suite once under the collector (`HAYVEN_TRACE=1`) to populate the trace signal, then re-select. `--trace-only` returns just the observed (highest-confidence) set.

## Programmatic context packs (the builder API)

This is the **context-pack** integration: a **BUILDER** — an Agent-SDK app or a multi-agent harness that controls context programmatically — fetches a graph-precise **context pack** and assembles the prompt itself, instead of letting a free-roaming agent re-read whole files. Feeding graph-precise *slices* instead of whole files cut re-sent context tokens **78–86%** in the measurement, and a model fixed a real bug from a 311-token slice with all tests passing. It is **embedding-free, deterministic, never-stale, line-exact, and zero-infra** (no vector index, no model, no network): the pack is the target's import header + its body + its 1-hop callee/referenced-type dependencies, each a real, line-exact source slice.

### `GET /api/context/<symbol>` — one symbol

Returns the `ContextPack` JSON (`{ symbol, resolved, slices[], lineCount, estTokens, targetFileEstTokens, worthwhile, notes[] }`). Each slice carries `{ role: "header"|"target"|"neighbor", id, kind, file, startLine, endLine, text, via?, weight? }`.

- Entity ids contain `/` (e.g. `utils/cookie/parse`). Pass it **raw** on the path (`/api/context/utils/cookie/parse`) or **url-encoded** (`/api/context/utils%2Fcookie%2Fparse`) — both work.
- Query params: `neighbors` (default `true`; pass `?neighbors=false` to get header + target only), `maxNeighbors` (int — cap callee/ref slices), `maxRefSliceLines` (int — cap how many leading lines of a referenced *type* are inlined).
- **404** (with a helpful JSON body) when the symbol resolves to no node. Read-only — never mutates the index.

```sh
curl -s 'http://localhost:7777/api/context/utils/cookie/parse'
curl -s 'http://localhost:7777/api/context/utils/cookie/parse?neighbors=false&maxNeighbors=5'
```

### `GET /api/context?task=<text>&top=N` — task mode

When you don't already know the exact symbol, pass a natural-language task. It resolves to candidate symbols via the embedding-free FTS path (`resolveTaskToSymbols`) and packs each, returning `{ task, resolved: string[], packs: ContextPack[] }`.

```sh
curl -s 'http://localhost:7777/api/context?task=parse%20the%20session%20cookie&top=3'
```

### Agent-SDK recipe

Fetch the pack, concatenate the slice texts into a prompt, hand it to the model — no file reads, no embeddings, no infra:

```ts
// Builder-side: assemble an agent prompt from a precise context pack.
async function packPrompt(symbol: string): Promise<string> {
  const res = await fetch(`http://localhost:7777/api/context/${symbol}`);
  if (res.status === 404) throw new Error(`no node for ${symbol}`);
  const pack = await res.json(); // ContextPack
  const body = pack.slices
    .map((s: { role: string; file: string; startLine: number; endLine: number; text: string }) =>
      `// ${s.role} ${s.file}:${s.startLine}-${s.endLine}\n${s.text}`,
    )
    .join("\n\n");
  return `Here is the precise context (~${pack.estTokens} tokens):\n\n${body}`;
}

const prompt = await packPrompt("utils/cookie/parse");
// hand `prompt` straight to the model (Agent SDK / chat completion) — this is the
// embedding-free, deterministic, zero-infra way to assemble agent context.
```

### CLI equivalents

The same packs are available daemonless from the CLI (`--json` for the identical structured payload):

```sh
hayven context utils/cookie/parse            # markdown, paste-ready
hayven context utils/cookie/parse --json     # the ContextPack JSON
hayven context "parse the session cookie" --task --top 3   # task mode
```
