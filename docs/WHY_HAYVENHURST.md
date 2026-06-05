# Why Hayvenhurst

This is the argument behind the system: what problem it solves, the bet it makes, and what we deliberately chose to build ourselves rather than pull off a shelf. It is grounded in the design philosophy in the PRD (§2) and the locked commitments in [`ARCHITECTURE.md`](../ARCHITECTURE.md).

## The problem: agents have no durable, shared code intelligence

AI coding agents are getting good at reasoning over code. They are still bad at *remembering* it, and worse at *sharing* what they know.

Watch an agent work and you see the same pattern repeat. To answer "what calls this function," it greps, reads a handful of files, builds a mental model, acts — and then throws that model away. The next session starts from zero. The agent in the next terminal tab, working the same repo, starts from zero too, with no idea what the first one is touching. Each agent re-derives the structure of the codebase from raw text, every time, in isolation. It's expensive in tokens, slow, and lossy — and it scales the wrong way: the more agents you run, the more redundant rediscovery you pay for, and the more likely two of them are to collide on the same code without ever knowing it.

The pieces that *would* fix this exist in scattered form. IDEs build call graphs but lock them inside one editor process. Language servers know who-calls-what but speak a protocol designed for a single interactive client, not a swarm of agents. Hosted code-search products know your repo but live behind someone else's API, behind someone else's network, behind someone else's bill. None of them give you what an agent actually needs: a **durable, queryable, shared** model of the codebase — one that survives across sessions, is the same for every agent, captures both static structure *and* what actually runs at runtime, and is yours.

That's the gap. Not "agents can't understand code." It's "agents can't keep, or share, what they understand."

## The bet

Hayvenhurst's bet is that the right shape for that shared intelligence is a **distributed, CRDT-backed code graph with a local conflict oracle** — and that it should run, comfortably, on hardware almost anyone already has.

Three commitments make that bet concrete.

### 1. The graph is durable, plain, and the source of truth

The knowledge graph is stored as plain markdown files in `.hayven/nodes/` — one node per code entity (function, class, module), human-readable, diffable, greppable. SQLite is a derived index on top of those files; you can delete it and rebuild it with `hayven reindex`. This is the opposite of an opaque database you have to trust. The intelligence is files you can read, version, and own.

The graph is also *trace-augmented*. Static structure comes from Tree-sitter parsing five languages (Python, TypeScript, JavaScript, Rust, Go). Runtime structure comes from a sampling trace collector that hooks `sys.settrace`, captures call-graph edges only (never argument or return values, by design), and feeds sample-scaled weights back in. "What calls this" and "what *actually* called this in the last test run" are both first-class. An agent querying the graph gets the real behavior of the code, not just its shape on paper.

### 2. Distribution is built in, and it's cheap

Every daemon is a peer. There is no central server, no required cloud account, no hosted index. State lives in CRDTs — a Last-Writer-Wins register, a Grow-only Set for trace observations, and an Observed-Remove Set for the claim board — so two replicas that have seen the same operations converge to the same graph, regardless of the order or duplication of delivery. Reconciliation is Merkle anti-entropy over plain HTTP: each side compares Merkle roots, then pulls only the segments that differ.

The data-efficiency discipline here is not decorative. A representative day of synchronization — hundreds of trace observations plus a handful of claims — was measured at roughly **5.6 KB on the wire** (the PRD target is under 30 KB). That number is the whole point of the second philosophy principle: *every byte on the wire must justify itself, dial-up before fiber.* A graph that syncs in a few kilobytes a day is a graph two developers can share over a bad hotel connection, or that a small team can keep coherent without anyone paying for bandwidth they don't have.

### 3. Coordination is solved before conflicts happen, with a local oracle

When multiple agents edit one codebase, the failure mode isn't merge conflicts in the git sense — CRDTs converge unconditionally. The failure mode is *semantic*: two agents make individually-valid edits that break each other's assumptions. Hayvenhurst's answer is a three-layer defense (ARCHITECTURE.md §17), applied at the level of **entities, not files**, so two agents can safely edit different functions in the same file:

- **Layer A** rejects overlapping claims outright (a hard conflict, `409`).
- **Layer B** re-verifies merged files after the fact — Tree-sitter syntax checking plus a typechecker where one is configured — and surfaces failures as visible `merge_rejected` records rather than silently materializing broken state.
- **Layer C** is the interesting one: when a new claim is *adjacent* to an active one (connected by a call/import edge, or sharing a module), an oracle is asked a single question — could these two intended pieces of work break each other's assumptions?

The measured result: a two-agent workload that produces a **~22% naive conflict rate** drops to **2.4% / 1.7%** across seeds — under the 3% target — while truly-independent work is never blocked.

The oracle is the bet's sharpest edge. Its default implementation is a deterministic heuristic (`heuristic-v1`) that ships with zero configuration and no download. But a heuristic structurally cannot read *intent* — it can't tell "I'm changing this function's return type" (which breaks callers) from "I'm fixing a typo in its docstring" (which doesn't). So Hayvenhurst can swap in a **local LLM oracle**: a small quantized Gemma model running entirely on your machine via candle (pure Rust, no external server, no API key), reading the two claims' intents and answering YES/NO with a reason. It has a hard timeout and falls back to the heuristic on any error, so the claim path is never blocked on the model. Weights are an opt-in download (~1–2 GB), never bundled — a fresh install ships working conflict defense with **zero download**, and the LLM is an upgrade, not a dependency.

This is what "local-first, cloud-optional" means in practice: the conflict oracle, the most "AI" part of the system, runs locally and for free.

> Honesty note: the LLM oracle is validated end-to-end on real Gemma weights (BL-18 resolved — it loads and returns real calibrated verdicts). The from-GGUF tokenizer is byte-exact for standard SentencePiece Gemma 2/3, with a documented fidelity caveat for the Gemma-4 E-series. But the **shipping default oracle is the deterministic, local, no-LLM `contract-diff`** (degrading to the heuristic without a native binary) — measurement showed the single-shot local LLM over-blocks worse than the heuristic as prompted, so the LLM path stays experimental. See `docs/ORACLE_WARMTH_DECISION.md`.

### It runs on a $599 Mac mini

The whole system is sized to run on a base-model Mac mini, and the success criteria are measured, not aspirational: a first index of a 50K-line repo in well under a second (~0.7 s measured), a daemon that idles at **~43 MB** of RSS (under the 50 MB target, via a compiled single binary), and a file watcher that costs **≤0.0081%** of one core watching 30,000 files. These aren't vanity metrics — they're the difference between "you need a workstation and a cloud account" and "you need hardware you might already own." That's the first philosophy principle, *egalitarian by hardware tier*, made literal.

> Some headline numbers (cross-platform binary sizes, the throttled-link install half of the story) still need a real tagged release and the spec Mac mini to confirm; see `CHANGELOG.md`.

## What's deliberately original (and what's deliberately boring)

The fourth philosophy principle — *original where it matters, boring where it doesn't* — is a discipline about where to spend invention. Storage is SQLite, raw, with typed query helpers; nobody needs a novel database. But the parts that *are* the product, we built ourselves, on purpose. The list of dependencies we said no to (ARCHITECTURE.md §9) is itself a design statement:

| We declined | We built / used instead | Why |
|-------------|-------------------------|-----|
| A long-running MCP server | A first-party Skill + a stateless CLI | Every operation is one shell call; no process to manage, no socket to keep alive. |
| Vector embeddings (in v1) | FTS5 trigram search + LLM-driven query expansion | No embedding model to download or serve; search works offline on any hardware. |
| A bundled cloud LLM dependency | A local Gemma oracle via candle (pure Rust) | The "AI" runs on your machine, for free, behind a swappable interface. |
| Cytoscape / Sigma / D3 layout | A hand-rolled Barnes-Hut force simulation | The viewer stays SVG-only with level-of-detail; no heavyweight graph library. |
| Canvas + WebGPU renderers | SVG-only with viewport culling and LOD | Renders on modest hardware; degrades gracefully instead of failing. |
| A CSS framework (Tailwind, etc.) | Hand-rolled scoped CSS | Smaller payload; the viewer's JS budget stays under 100 KB. |
| An icon library | Inline SVG | Nothing to ship that we don't use. |
| TanStack Query | An ~80-line hand-rolled `useQuery` | We needed dedup + polling, not a framework. |
| An ORM | Raw `bun:sqlite` with typed helpers | The schema is small and we want to see every query. |
| An argument-parsing library (yargs/commander) | Hand-rolled `Bun.argv` parsing | The CLI surface is small and zero-dep. |
| A CRDT/serialization library | A custom Rust wire serializer (string-table dedup + brotli) | The wire format *is* the data-efficiency story; it earns ~1.6% of a JSON baseline. |

Every "no" in that table is in service of one of the five principles — usually data-efficiency, hardware-egalitarianism, or local-first independence. The custom CRDT serializer exists because the byte budget is the product. The local oracle exists because depending on a cloud API would break local-first. The Skill-instead-of-MCP-server choice exists because a stateless integration is one fewer thing standing between an agent and the graph. The boring choices (SQLite, Tree-sitter, candle's permissive Rust stack) exist so the inventive budget goes where it matters. And the dependency posture is permissive throughout — MIT/Apache-2.0/BSD/ISC and friends across the daemon, native binary, and viewer — so the whole thing stays genuinely open and redistributable.

## The shape of the bet, in one sentence

Give every agent — local or cloud, this session or the next, yours or a teammate's — the same durable, trace-augmented, cheaply-syncing model of the code, plus a local oracle that keeps them from breaking each other's work, on hardware nobody is locked out of. That's Hayvenhurst.

---

*Start here:* [`docs/QUICKSTART.md`](QUICKSTART.md) to try it, [`docs/INTEGRATION.md`](INTEGRATION.md) to wire an agent in, [`ARCHITECTURE.md`](../ARCHITECTURE.md) for the locked contracts.
