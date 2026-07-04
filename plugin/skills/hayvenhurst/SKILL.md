---
name: hayvenhurst
description: Query a persistent, trace-augmented code graph of this repository through the local Hayvenhurst daemon. Prefer the `hayven` CLI over grep/find/reading large files when you need code structure, dependencies, callers/callees, or runtime behavior; also claim work before editing so parallel agents don't collide.
when_to_use: Use when the user asks "who calls X" / "what does X call" / "what breaks if I change X" / "every caller/importer of X" / "where is X defined" / "what's in module Y", needs code-structure or dependency analysis, code/full-text search, to walk the call graph (neighbors), the transitive blast radius (impact), the complete usage list (refs/importers), or to see runtime trace history — and before reading many files or starting a refactor. **Especially when ORCHESTRATING a fan-out of parallel agents** — about to spawn N sub-agents, split work across workers, or assemble per-agent context: partition with `plan-lanes` and brief them once with `fleet-context` BEFORE spawning, so the shared core isn't re-read in every lane. Also: claim a scope before editing, release it when done.
---

# Hayvenhurst

A Hayvenhurst daemon runs locally and maintains a knowledge graph of this codebase as plain markdown nodes plus a SQLite index. Static structure (from Tree-sitter) and runtime structure (from traces) are both first-class. Multiple agents coordinate through a shared claim board so parallel work does not collide.

You — the agent — interact with it through the `hayven` CLI and a local HTTP API on `:7777`. There is no MCP server, no persistent socket to keep open. Every CLI command is one shell call; output is markdown by default so you can read it inline (add `--json` when you need structured data). A few reads have no CLI wrapper yet — for those, hit the API directly with `curl` (noted below).

## The core loop (do this first)

This is the workflow that pays off. It is a graph walk, not a text grep:

1. **Search broad, with code tokens.** `hayven query "selectOracle"` (or a one-word root like `oracle`). You get back ranked node ids.
2. **Open the top hit's node** to read its body **plus its callers and callees in one shot**:
   ```
   curl -s 'http://localhost:7777/api/nodes/<id>'
   ```
   The response is `{ node, neighbors: { callers, callees }, markdown }`. The `markdown` field is the node's body with `Called by:` / `Calls:` sections inline. (Slashed ids work raw on this path — see "Ids contain slashes".)
3. **Walk the graph** from there: `hayven neighbors <id> --depth 2` to expand callers/callees N hops, or follow a specific caller/callee id back into step 2.

The callers/callees edges are the whole point — they are what `grep` cannot give you. Reach for them whenever the question is "who calls X" or "what does X reach". Don't stop at the search hit; open the node and walk.

## Orchestrating a fan-out? Do this BEFORE you spawn the sub-agents

If you are an orchestrator about to spin up **N parallel agents** (split work across workers, brief sub-agents, assemble per-agent context), STOP — these steps keep the fan-out from paying for the same context N times AND from faithfully implementing a wrong assumption N times. Do them *first*, before you brief anyone:

0. **Validate the premise against the real code FIRST.** Before you write any lane's brief, check that the task's stated assumption is actually true in the current code — `hayven query`/`refs`/`impact`/`context <sym>` to read the real thing. Sub-agents will faithfully implement whatever premise you hand them; a wrong premise becomes N wrong implementations, and you only catch it by reading the *real diff* afterward, not their summaries. (This is a measured failure: a fan-out once "fixed" a warning that every command already emitted — the premise was false, the agents did exactly as told.) If the premise doesn't hold, reframe the task before fanning out.
1. **`hayven plan-lanes <files...>`** — partition the work into lanes that share no file and no symbol, so the agents can't collide.
2. **`hayven fleet-context --lanes lanes.json [--exemplars <ref-sym>]`** — pack every lane once and split the slices into a SHARED block (inject it **once** into each sub-agent) plus each lane's UNIQUE block — instead of N full packs that each re-read the shared core. (`lanes.json` = `[{ "id": "a", "symbols": ["pkg/foo", ...] }, ...]`.) **~49% fewer context tokens on a 3-lane fan-out.** For a *harmonization* task (every lane must match one canonical pattern), pass that reference symbol as `--exemplars` so it's pinned into the shared block labeled "copy this" — otherwise lanes read each other's files to copy the convention.

Do **not** hand-assemble per-agent context by reading files yourself — that re-reads the shared core in every lane, which is the exact waste these commands remove. Per-agent on a token budget? `hayven context <sym> --escalate --budget N` returns the richest slice that fits. Full details under "Fanning out parallel agents" below.

## When to use this Skill

- Before reading more than ~3 files to answer a question — query the graph first.
- Before starting parallel work with another agent — check the claim board, then claim your scope.
- After running tests — `hayven traces` reflects what actually executed.
- When the user asks "what calls X", "what does X depend on", "where is X used".
- When you need a focused summary of a function/class/module instead of its full source.
- **Before re-reading a whole file to understand a symbol** — `hayven context <symbol>` returns just that entity's body + its 1-hop dependencies (a line-exact slice pack, ~80% fewer tokens than the file). See "Precise context without whole files".
- **Before spinning up parallel sub-agents** — partition with `plan-lanes`, then brief them once with `fleet-context` (shared core injected once, not re-read in every lane). See "Fanning out parallel agents".

## When NOT to use it

- Trivial single-file edits in code you wrote in this same session.
- Greenfield files where the graph has no information yet.
- The repo has no `.hayven/` directory — run `hayven init` first or skip the Skill for this turn.

## CLI surface

All commands accept `--json` for machine-readable output. Daemon must be running (`hayven daemon status`); start it with `hayven daemon start` if needed.

| Command | Purpose |
|---|---|
| `hayven init` | Set up `.hayven/` in the current directory and perform first ingestion. |
| `hayven ingest [path]` | Re-scan the codebase. Incremental by default; pass `--full` to rebuild. |
| `hayven query "<term...>" [--path <prefix>]` | Full-text search over **code tokens** (identifiers, split camelCase / snake_case parts), ranked by relevance. Returns top-N node ids as markdown. Scope to a subtree with `--path frontend/` to stop a monorepo query surfacing the wrong domain. Not natural language — see "Query shape". |
| `hayven neighbors <id> [--depth N]` | Walk the graph N hops from a node (static + trace edges, callers and callees). Default depth 1. Encodes slashed ids for you. |
| `hayven refs <id>` | **EXHAUSTIVE** callers ∪ importers of a symbol — the complete, edges-backed list (not a ranked top-N). Use before a refactor to find *every* usage. |
| `hayven importers <module-id>` | **EXHAUSTIVE** list of every node that imports a module. The complete set, from the import edges — not search. |
| `hayven impact <id> [--depth N]` | **Transitive blast radius**: every caller/dependent reachable through the call+import graph ("change this signature → these N things break"). This is the thing grep structurally cannot do at all. |
| `hayven affected-tests <symbol> [--changed a,b] [--trace-only] [--order] [--runner vitest\|bun]` | **Minimal tests to run for a change.** Fuses the static impact graph with **per-test runtime coverage** into two confidence tiers: `observed` (per-test coverage *proved* this test ran the change — precision ~1.0, the minimal fail-fast set) and `reachable` (graph/transitive — the recall safety net). Default returns both (observed first); **`--trace-only`** = just the `observed` set; **`--order`** = fail-fast (APFD) ordering. Use `--changed a,b` for the "I edited these files, what do I run?" entry. **`--runner vitest`** / **`--runner bun`** prints a ready-to-paste `vitest run <spec files…>` / `bun test <spec files…>` command for the affected set (empty set → empty stdout, never a run-everything bare invocation; pick the runner your repo actually uses). Needs one suite run under the collector (`HAYVEN_TRACE=1` — pytest plugin, vitest setup entry, or `bun test --preload @hayvenhurst/trace-bun/bun-test`) to populate coverage; degrades to static + says so. |
| `hayven remember "<note>" [--node <id>] [--kind decision\|deadend\|gotcha\|note]` | **Fleet memory** — record a durable, graph-keyed learning so a later agent (or your future self) inherits it instead of re-deriving. Use `--scope a,b` for a multi-node note, `--ttl <seconds>` for an ephemeral one. Distinct from `claim` (which coordinates edits) — this is shared *knowledge*. |
| `hayven recall [<term>] [--node <id>] [--kind K] [--json]` | **Recall fleet memory.** `--node <id>` returns every note ANCHORED to that code entity — the durable path that survives renames/refactors (the graph anchor re-resolves, the note's wording doesn't have to match). `<term>` is a FUZZY text recall — FTS + identifier-split (`auth handler` finds `authHandler`) + abbreviations (`cfg`↔`config`) + a relaxed any-word fallback, **not** a literal substring. Filter `--kind`, or omit both for everything. `recall --forget <id>` deletes one. Check this BEFORE re-investigating unfamiliar code — a past agent may have left you the answer, keyed to the very symbol you're looking at. |
| `hayven context <symbol\|task...> [--task] [--escalate [--budget N]] [--json] [--no-neighbors] [--max-neighbors N]` | **Precise context pack** — the target entity's body + its 1-hop callee/referenced-type slices (line-exact), instead of the whole file. ~80% fewer tokens than reading the file. Pass a symbol, or a natural-language task with `--task`. Add **`--escalate`** to see the cost ladder — `pack → pack-2hop → whole-file` with a recommended rung — when you're not sure the cheap slice is enough; add **`--budget N`** to make it pick the *richest rung that fits N tokens* (so a context-budgeted agent spends its allowance on the most context it can afford). See "Precise context without whole files". |
| `hayven fleet-context --lanes <file.json\|-> [--shared-min N]` | **Shared briefing for a fan-out.** Given the per-lane symbol sets of N parallel agents (`[{ "id": "a", "symbols": [...] }, ...]`), it packs each lane once and splits the slices into a SHARED block (what ≥`--shared-min` lanes both need — inject it ONCE into every sub-agent) and each lane's UNIQUE block, instead of N full packs that each re-include the shared core. The companion to `plan-lanes`: `plan-lanes` decides *who does what*, `fleet-context` computes *what to hand each*. Measured ~49% fewer context tokens on a 3-lane fan-out. See "Fanning out parallel agents". |
| `hayven plan-lanes <files...> [--symbols] [--depth N] [--max-hub-degree N]` | **Disjoint parallel work lanes** — partition a change-set along the transitive blast-radius graph into lanes that share no file and no symbol, so parallel agents can't collide. Coupled changes (overlapping blast radius) land in one lane and must serialize. Unbounded blast radius **saturates through hub modules** (everything ends up coupled); use **`--depth 1`** (direct dependents only) and/or **`--max-hub-degree N`** (drop nodes depended-on by > N things from the coupling decision) when planning lanes. The grep-can't-do-this decomposition. |
| `hayven traces <id>` | Runtime call history for this node — observed + resolved callers/callees, invocation counts. |
| `hayven claim <ids...> --intent "<reason>"` | Register a work claim. Returns a claim id. Required before editing scope shared with other agents. |
| `hayven release <claim_id>` | Release a claim when your work is done or abandoned. Always release. |
| `hayven sync <peer_url>` | Pull/push CRDT state with a peer over HTTP. |
| `hayven view` | Open the Astro viewer at `localhost:7777` (for the human, not for you). |
| `hayven daemon [start\|stop\|status]` | Daemon lifecycle. |
| `hayven doctor` | Diagnose model/hardware/binary integrity. Run this when commands fail unexpectedly. |
| `hayven config` | View/edit project or global config. |

## Query shape (this is FTS over code, not a chatbot)

`hayven query` is full-text search over **code tokens**, not natural language. It tokenizes identifiers and splits camelCase / snake_case into parts, so `select` matches `selectOracle` and `llm` matches `LlmOracle` / `llm_oracle`. Rules that actually work:

- **Search the identifier, not a sentence.** `hayven query "selectOracle"` works; `hayven query "how does oracle selection work"` returns **No matches** (every word is a literal token; the phrase as a whole indexes nothing).
- **Broad one-word queries are good first moves.** `oracle` returns ~20 hits ranked by relevance — scan them, then narrow to the exact identifier (`selectOracle`) once you know what you want.
- **Scope a monorepo query with `--path`.** In a repo with both a frontend and backend, `hayven query "provider"` will surface backend OAuth providers *and* frontend context providers. Add `--path frontend/` (or any repo-relative prefix) to keep only nodes under that subtree. The prefix is a path prefix, not a glob.
- **Don't loop on a failed query.** If a query returns nothing, drop to a shorter root token (a single camelCase part) once, then fall back to grep.

> **`query` ranks (top-N); `refs`/`importers` enumerate (all).** When you need *the complete set* — "change every importer of X", "find every caller before I rename" — do **not** scroll `query`; use `hayven refs <id>` / `hayven importers <id>`, which return the whole edges-backed list. `query` is the locator; `refs`/`importers` are the enumerators.

## Ids contain slashes

Node ids look like `conflict/oracle/selectOracle` — the slashes are part of the id, not path separators. They work two ways:

- **CLI: pass them as-is.** `hayven neighbors conflict/oracle/selectOracle` and `hayven traces conflict/oracle/selectOracle` encode the id for you. Quote it if your shell would glob.
- **API: raw or url-encoded both work.** `curl 'http://localhost:7777/api/nodes/conflict/oracle/selectOracle'` returns 200, and so does the `%2F`-encoded form. Either is fine — raw is easier to read.

Prefer the CLI when a wrapper exists so you never think about encoding at all.

## Example: a typical lookup (real output)

```
$ hayven query "selectOracle"
# Search: selectOracle
20 matches
## `selectOracle`
- id: `conflict/oracle/selectOracle`
...

$ curl -s 'http://localhost:7777/api/nodes/conflict/oracle/selectOracle'
{ "node": { "id": "conflict/oracle/selectOracle", "file": "daemon/src/conflict/oracle.ts", ... },
  "neighbors": {
    "callers":  [ { "src": "daemon/routes/claims/claimsRoutes", "kind": "static_call" } ],
    "callees":  [ { "dst": "conflict/oracle/HeuristicOracle", "weight": 8 }, ... ] },
  "markdown": "# `selectOracle` ... Calls: HeuristicOracle, LlmOracle, ContractDiffClaimOracle ..." }
```

That one node call answers "who calls `selectOracle`?" (the claims route) and "what does it reach?" (the oracle implementations) without reading a file. Follow up with `hayven neighbors conflict/oracle/selectOracle --depth 2` to expand, or `hayven traces conflict/oracle/selectOracle` for runtime call counts.

## Precise context without whole files (`hayven context`)

When you need to *understand or edit* a symbol — not just locate it — reach for `hayven context <symbol>` **before** reading the whole file. It returns a **context pack**: the target file's module skeleton (imports + module-level declarations), the target entity's full body, and its 1-hop callee/referenced-type dependencies — every piece a real, line-exact source slice. No embeddings, no model, no network; just the existing graph + node ranges. On real files this is **~80% fewer tokens** than reading the file (a tiny method in a 500-line class is ~22 lines instead of 505), and the slice is *sufficient* to make the fix — measured 9/9 success on real cross-file bug tasks.

```
$ hayven context utils/cookie/parse          # markdown, paste-ready into your reasoning
$ hayven context utils/cookie/parse --json    # the structured ContextPack
$ hayven context "parse the session cookie" --task --top 3   # don't know the symbol? task mode (embedding-free FTS)
```

Flags: `--no-neighbors` (header + target only), `--max-neighbors N` (cap callee/ref slices). The pack reports `worthwhile` / `targetFileEstTokens` so you can fall back to the whole file when the pack would not save anything.

**When to pack vs when to read the file:** reach for `hayven context` whenever you're about to read a file *just to study one function and what it touches* — it gives you that function plus the exact callees/types it depends on and nothing else. Read the whole file only when you genuinely need the entire module (e.g. a sweeping rewrite). For a known symbol, pass the id; when you only have a description, use `--task`.

This same pack is available over HTTP at `GET /api/context/<symbol>` (and `GET /api/context?task=<text>&top=N`) — the surface a **builder** (an Agent-SDK app or multi-agent harness that assembles prompts programmatically) calls to feed an agent the 3 functions that matter instead of the 800-line file. Full builder recipe in [`docs/INTEGRATION.md`](../docs/INTEGRATION.md) → "Programmatic context packs".

## Fanning out parallel agents (the orchestrator reflex)

When **you are an orchestrator about to spin up N parallel sub-agents**, these steps keep the fan-out from wasting tokens on overlap — and from shipping the same wrong assumption N times. Do them *before* spawning the lanes, not after:

0. **Validate the premise against the real code first.** Sub-agents faithfully implement whatever you tell them; if the task's stated assumption is false, you get N faithful-but-wrong implementations, caught only by reading the real diff afterward (not the agents' summaries). Before briefing anyone, confirm the assumption with `hayven query`/`refs`/`impact`/`context <sym>`. Measured failure mode: a fan-out "fixed" a warning every command already emitted — false premise, correct execution, wasted work. If it doesn't hold, reframe before fanning out.
1. **Partition the work — `hayven plan-lanes <files...>`.** Splits the change-set along the blast-radius graph into lanes that share no file and no symbol, so the lanes can't collide. This decides *who does what*.
2. **Brief them once — `hayven fleet-context --lanes lanes.json [--exemplars <ref-sym>]`.** Hand it each lane's symbol set; it returns a SHARED block (the core every lane touches) plus each lane's UNIQUE block. Inject the **shared block once** into every sub-agent's prompt (a cacheable common prefix) and give each lane only its unique block — instead of N full packs that each re-include the shared core. Measured ~49% fewer context tokens on a 3-lane fan-out, and it scales with fan-out width. **Harmonization tasks** (every lane must match one canonical pattern) pull lanes into reading each other's files to copy the convention — pin that reference with `--exemplars <sym>` and it's injected once, labeled "copy this; don't peek at a sibling lane."
3. **Size each lane to its budget — `hayven context <sym> --escalate --budget N`.** If a sub-agent has a fixed context allowance, this returns the richest slice rung that fits it (and tells you honestly when even the cheapest is over budget).

The rule: **validate the premise, then `plan-lanes` decides the lanes, `fleet-context` (with `--exemplars` for harmonization) briefs them, `--budget` sizes each.** A grep-driven fan-out re-reads the shared core in every lane and can't check its own premise; a graph-driven one pays for the core once and reads the real code first.

> For a builder running an LLM-API harness rather than orchestrating here, the same savings are available transparently at the request path: `hayven proxy [--provider anthropic|openai|gemini] [--compact-history]` swaps whole-file pastes for graph slices and compacts stale re-read history. See [`docs/CONTEXT_PROXY.md`](../docs/CONTEXT_PROXY.md).

## hayven vs grep — pick the right tool

The one-line rule: **grep for find-and-replace; hayven for who-calls / what-breaks / claiming.** They are complementary, not rivals — use each for what it is structurally good at.

**Reach for hayven** when the question is structural or coordinated:
- "Who calls Z / what does Z call?" → open `/api/nodes/<id>` or `hayven neighbors <id>` — the graph, the thing grep cannot do.
- "If I change Z, what breaks?" → `hayven impact <id>` — transitive blast radius. Grep cannot follow edges transitively at all.
- "I changed these files — which tests do I run?" → `hayven affected-tests --changed a.ts,b.ts` — the minimal test set from the graph ∪ runtime traces, not the whole suite. Trace-tagged tests are ground-truth (observed), so this catches tests that reach the code through a re-export the static graph misses. Run the suite once under the trace collector first to populate the trace signal (otherwise it degrades to static-only and says so).
- "Every caller/importer of X before I refactor?" → `hayven refs <id>` / `hayven importers <id>` — the complete edges-backed set.
- "Where is symbol X defined / what's in module Y?" → `hayven query "X"` (add `--path` to scope a monorepo), then open the node.
- Before parallel edits → **claim the scope** (see Coordination). This is hayven's biggest measured win: a coordinated fleet finishes the same work collision-free and for fewer tokens than an uncoordinated grep-driven one.

**Reach for grep** when the task is exhaustive textual rewriting or hayven has nothing indexed:
- **Find-and-replace across many files** (rename a string, bump `import.meta.env` → `process.env` everywhere). Grep gives the complete, line-precise list every time; that's its job, not hayven's.
- String literals, comments, log messages, config/JSON/env values — not code symbols, so FTS won't find them.
- A brand-new symbol you just wrote that hasn't been re-ingested yet (run `hayven ingest` first, or grep it).

Rule of thumb: **locate and understand with hayven, then mechanically rewrite with grep/sed** — and `claim` the scope first if anyone else is in the tree.

## Coordination etiquette (multi-agent work)

The claim board is the contract between you and any other agent operating in this repo. Three rules, in order:

1. **Claim before editing.** Before you modify any node, call `hayven claim <ids...> --intent "<one short sentence>"`. The intent string is read by other agents — make it specific. Claims are scoped to entities (functions, classes, modules), not files, so two agents can safely edit different functions in the same file.
2. **Respect adjacent claims.** If `hayven claim` reports an adjacent active claim from another agent, do not proceed silently. Read the other claim's intent. If your edits could plausibly break each other's assumptions, wait, coordinate, or narrow your scope. The daemon may surface an adversarial-preview warning — take it seriously.
3. **Release when done.** Run `hayven release <claim_id>` as soon as your edit is committed or abandoned. Stale claims block teammates. Claims also have a TTL, but do not rely on it — release explicitly.

If `hayven claim` fails because the scope is already held, do not retry in a loop. Surface the conflict to the user with the holding agent's intent so they can decide.

## Failure modes

- **Command not found** — the user has not installed Hayvenhurst. Skip and proceed with conventional tools.
- **Daemon not running** — `hayven daemon start` first.
- **No `.hayven/` directory** — `hayven init` in the repo root, or skip the Skill for first-time use.
- **`hayven-native` missing or unsigned** — surface to the user; this is a setup issue, not something to retry.
- **Query returns nothing** — you likely passed a natural-language phrase. Re-query with a single code token (an identifier or one camelCase/snake_case part); if that also misses, the symbol may be new/un-ingested — fall back to grep. Do not loop on the same query.

Output is markdown for a reason: paste it directly into your reasoning when it helps. Do not summarize and then re-fetch.
