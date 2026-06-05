---
name: hayvenhurst
description: Query a persistent, trace-augmented code graph of this repository through the local Hayvenhurst daemon. Prefer the `hayven` CLI over grep/find/reading large files when you need code structure, dependencies, callers/callees, or runtime behavior; also claim work before editing so parallel agents don't collide.
when_to_use: Use when the user asks "who calls X" / "what does X call" / "what breaks if I change X" / "every caller/importer of X" / "where is X defined" / "what's in module Y", needs code-structure or dependency analysis, code/full-text search, to walk the call graph (neighbors), the transitive blast radius (impact), the complete usage list (refs/importers), or to see runtime trace history — and before reading many files or starting a refactor. Also for parallel/multi-agent work: claim a scope before editing, release it when done.
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

## When to use this Skill

- Before reading more than ~3 files to answer a question — query the graph first.
- Before starting parallel work with another agent — check the claim board, then claim your scope.
- After running tests — `hayven traces` reflects what actually executed.
- When the user asks "what calls X", "what does X depend on", "where is X used".
- When you need a focused summary of a function/class/module instead of its full source.
- **Before re-reading a whole file to understand a symbol** — `hayven context <symbol>` returns just that entity's body + its 1-hop dependencies (a line-exact slice pack, ~80% fewer tokens than the file). See "Precise context without whole files".

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
| `hayven affected-tests <symbol> [--changed a,b] [--trace-only] [--order]` | **Minimal tests to run for a change.** Fuses the static impact graph with **per-test runtime coverage** into two confidence tiers: `observed` (per-test coverage *proved* this test ran the change — precision ~1.0, the minimal fail-fast set) and `reachable` (graph/transitive — the recall safety net). Default returns both (observed first); **`--trace-only`** = just the `observed` set; **`--order`** = fail-fast (APFD) ordering. Use `--changed a,b` for the "I edited these files, what do I run?" entry. Needs one suite run under the collector (`HAYVEN_TRACE=1`) to populate coverage; degrades to static + says so. |
| `hayven remember "<note>" [--node <id>] [--kind decision\|deadend\|gotcha\|note]` | **Fleet memory** — record a durable, graph-keyed learning so a later agent (or your future self) inherits it instead of re-deriving. Use `--scope a,b` for a multi-node note, `--ttl <seconds>` for an ephemeral one. Distinct from `claim` (which coordinates edits) — this is shared *knowledge*. |
| `hayven recall [<term>] [--node <id>] [--kind K] [--json]` | **Recall fleet memory** — notes about a node (`--node`), matching a substring (`<term>`), or all (filter `--kind`). `recall --forget <id>` deletes one. Check this BEFORE re-investigating unfamiliar code: someone may have left you the answer. |
| `hayven context <symbol\|task...> [--task] [--json] [--no-neighbors] [--max-neighbors N]` | **Precise context pack** — the target entity's body + its 1-hop callee/referenced-type slices (line-exact), instead of the whole file. ~80% fewer tokens than reading the file. Pass a symbol, or a natural-language task with `--task`. See "Precise context without whole files". |
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
