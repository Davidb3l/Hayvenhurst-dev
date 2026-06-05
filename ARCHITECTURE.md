# Architecture

> Companion to [`HAYVENHURST_PRD.md`](../HAYVENHURST_PRD.md). The PRD is the v1.0 destination spec. This document captures the *design commitments* we make along the way — the contracts that future weeks must respect or explicitly break.

## How to read this document

- Each section is a discrete commitment with a status tag.
- **[LOCKED in X.Y.Z]** means changing this requires a `CHANGELOG.md` entry and a deliberate version bump.
- **[OPEN]** means we have not decided yet; the open-questions section at the bottom tracks these.
- New decisions land here as their own subsection, with the version they shipped in.

This is not a tutorial. It assumes you have read the PRD.

---

## 1. Entity ID scheme   [LOCKED in 0.0.1]

The format for every entity stored in `.hayven/` and indexed in SQLite:

```
Module node:    <scope>/<module_name>
Other entities: <scope>/<module_name>/<qualified_name>
```

`<scope>` is the directory under the project's first `src/` segment. If the file is not under `src/`, the scope is the file's directory path relative to the repo root, or the empty string for top-level files.

`<module_name>` is the file stem (filename without extension), with these per-language exceptions:

| Filename pattern              | Module name comes from |
|-------------------------------|------------------------|
| `mod.rs`                      | parent directory       |
| `lib.rs`                      | parent directory       |
| `main.rs`                     | parent directory       |
| `__init__.py`                 | parent directory       |
| Everything else               | file stem              |

`<qualified_name>` is what the parser produces. For nested entities (methods on classes/structs/traits) we use the **language's natural separator**: `.` for Python and JS/TS, `.` for the public-facing form in Rust (e.g., `MyStruct.method`).

### Examples

| File                        | kind     | qualified_name      | Entity ID                                |
|-----------------------------|----------|---------------------|------------------------------------------|
| `src/auth/login.ts`         | module   | `login`             | `auth/login`                             |
| `src/auth/login.ts`         | function | `loginHandler`      | `auth/login/loginHandler`                |
| `src/auth/login.ts`         | method   | `Session.refresh`   | `auth/login/Session.refresh`             |
| `src/parse/hash.rs`         | module   | `hash`              | `parse/hash`                             |
| `src/parse/hash.rs`         | function | `do_something`      | `parse/hash/do_something`                |
| `src/parse/extract.rs`      | function | `do_something`      | `parse/extract/do_something`             |
| `src/util/__init__.py`      | module   | `util`              | `util`                                   |
| `src/util/__init__.py`      | function | `helper`            | `util/helper`                            |
| `index.ts`                  | module   | `index`             | `index`                                  |

### Why the module segment

Without it, `src/parse/hash.rs::do_something` and `src/parse/extract.rs::do_something` both collapse to `parse/do_something` — a primary-key collision in SQLite and an overwrite on disk. Including the module segment for non-module entities makes every ID unique by construction, at the cost of slightly more verbose paths.

### Reserved prefix

`?:<name>` is reserved for unresolved edge destinations (see §7 Edge resolution). No real entity ID may start with `?:`.

### Implementation

`daemon/src/graph/idScheme.ts` is the single source of truth. Callers pass `{ moduleName }` for non-module entities; for the module node itself, omit the option (or pass the same string as `qualifiedName`).

---

## 2. Module-node contract   [LOCKED in 0.0.1]

For every parsed file the native binary emits exactly one synthetic node of kind `"module"` as the **first** record for that file. The daemon relies on this ordering to populate its `file → moduleName` map before processing any function/class/method records.

| Field           | Value                                                              |
|-----------------|--------------------------------------------------------------------|
| `kind`          | `"module"`                                                         |
| `name`          | module name per §1                                                 |
| `qualified_name`| same as `name`                                                     |
| `range`         | `[1, total_line_count]` (1-indexed, inclusive)                     |
| `ast_hash`      | blake3 of the entire file's bytes (no prefix; daemon adds `blake3:`)|

If the daemon receives a non-module record for a file whose module record hasn't arrived yet, that's a protocol violation — the ingest logs a warning and falls back to the file stem as the moduleName. The native binary is expected to guarantee ordering.

---

## 3. NDJSON IPC protocol (daemon ↔ `hayven-native`)   [LOCKED in 0.0.1]

UTF-8 newline-delimited JSON on the native binary's stdout. One JSON object per line. Newline-terminated. The daemon reads line by line and dispatches by `type`.

### Invocation

```sh
hayven-native parse --root <abs-path> --langs <comma-separated> [--jobs <N>] [--max-file-size <bytes>]
```

### Record types

```
{"type":"start","files_total":N,"version":"<semver>"}
{"type":"node","file":"<repo-rel>","name":"...","kind":"module|function|method|class|...",
   "qualified_name":"...","language":"...","range":[start,end],"ast_hash":"<hex>"}
{"type":"edge","src_file":"<repo-rel>","src_name":"<module or function name>",
   "dst_name":"<bare or qualified>","kind":"import|static_call|..."}
{"type":"progress","files_done":N}
{"type":"warn","file":"<repo-rel>","message":"..."}
{"type":"done","files_done":N,"nodes":N,"edges":N,"elapsed_ms":N}
{"type":"fatal","message":"..."}     ← only on unrecoverable error; exit 1 follows
```

### Atomicity guarantees

- Each line is a complete, parseable JSON object. The native binary serializes each record fully on a rayon worker thread, then sends the byte buffer through an mpsc channel to a single writer task. Cross-thread interleaving is impossible.
- For a given file: the module record always arrives before any other record from that file. Other ordering is not guaranteed.
- `start` always first, `done` always last (unless `fatal` interrupts).

### Exit codes

| Code | Meaning                                                                       |
|------|-------------------------------------------------------------------------------|
| 0    | Success                                                                       |
| 1    | Fatal error (a `fatal` record will precede it on stdout)                      |
| 64   | Subcommand exists but is not implemented (e.g., `watch`, `serialize` today)   |

The daemon treats 64 distinctly from 1 — "not built yet" surfaces a different message than "tried and failed."

### Binary discovery

The daemon looks for `hayven-native` in this order (`daemon/src/native/locate.ts`):

1. `$HAYVEN_NATIVE_BIN` env var
2. Sibling of the `hayven` binary
3. `<repo>/native/target/release/hayven-native`
4. `<repo>/native/target/debug/hayven-native`
5. `hayven-native` on `$PATH`

---

## 4. `.hayven/` storage model   [LOCKED in 0.0.1]

```
.hayven/
├── config.json              # daemon + per-project settings
├── index.sqlite             # bun:sqlite index (derived; can be rebuilt)
├── index.sqlite-wal         # SQLite WAL
├── index.sqlite-shm         # SQLite shared memory
├── nodes/                   # ← SOURCE OF TRUTH for entity bodies
│   └── <scope>/<module>.md  # module node
│   └── <scope>/<module>/<qn>.md  # entity nodes
├── traces/                  # daily rollups of trace observations
│   └── YYYY-MM-DD/observations.ndjson
├── claims/                  # active work claims (one .md per claim)
├── crdt/                    # raw CRDT op logs, brotli-compressed (Week 5+)
├── peers/                   # known peer Merkle roots
├── crashes/                 # local-only crash logs
├── logs/                    # daemon logs
└── daemon.pid               # PID of running daemon (per-project)
```

### Source-of-truth rule   [Clarified in 0.0.3]

There are **two** canonical on-disk stores, not one:

1. **`nodes/*.md`** — entity bodies (the human-readable markdown summaries).
2. **`.hayven/crdt/<type>/*.log`** — the raw CRDT op logs (HLC-stamped LWW content writes, OR-Set add/remove tags + tombstones, G-Set observations; §12–§14). **This is the merge-critical convergence state** — the LWW content hashes, OR-Set tags, and HLC stamps that make replicas converge.

**`index.sqlite` is the ONLY disposable derived layer.** It is a query index built from the two stores above; `rm index.sqlite && hayven reindex` is **safe** and must reproduce an identical query surface (modulo timestamps). By contrast, `rm -rf crdt/` **loses convergence history and is NOT safe** — it discards the op log that is the source of truth on restart and the substrate the sync layer (§15) gossips. (The earlier "markdown is truth, SQLite is derived cache" framing was correct about SQLite being disposable but understated `crdt/`; it is canonical, not a cache.)

The rationale is unchanged for the bodies: markdown is human-readable, diff-friendly, easy to ship over dial-up, easy to merge by hand if necessary. SQLite is the indexing layer, not the data store.

**Hand-edit reconciliation gap — `nodes/*.md` is projection-only for body content.** A human (or tool) editing `nodes/<id>.md` *directly on disk* **mints no LWW op and bumps no HLC.** So that edit: (a) does not propagate via sync, and (b) can be **silently overwritten** by a concurrent `recordLww` op carrying a higher HLC — i.e. exactly under the partition/concurrency conditions the CRDT exists for. Body content is therefore **projection-only**: treat `nodes/*.md` as a rendered view of the LWW register, not an input. **Edits to body content must go through the op path** — `recordLww` (`daemon/src/crdt/state.ts`), `PUT /api/nodes/:id/body`, or `hayven node body` — which mints the LWW op, bumps the HLC, appends to the log, and re-renders the markdown. (Direct `nodes/*.md` edits are still fine for throwaway local inspection, but they are not durable against sync.)

### Per-project daemon

The daemon's PID file lives at `.hayven/daemon.pid`, not in the user's home directory. Each project gets its own daemon process. This is deliberate: it isolates state, avoids cross-project resource contention, and makes `hayven daemon stop` unambiguous.

---

## 5. Trace observation contract   [LOCKED in 0.0.1]

### Wire format

`POST /api/traces/observations`:

```json
{
  "source": "python",
  "sample_rate": 100,
  "observations": [
    {"src":"auth/login_handler","dst":"auth/validate_session","ts":1715789520,
     "observed":5,"weight":500}
  ]
}
```

- `observed` — raw sample count (ground truth).
- `weight` — scaled estimate (`observed * sample_rate`).
- `sample_rate` — at the envelope, not per-record.

### Invariant

The daemon enforces `|weight − observed * sample_rate| ≤ 1` (±1 tolerance for any future integer-rounding edge). Mismatched payloads are rejected with HTTP 400 and a descriptive error message. No silent acceptance.

### Why both on the wire

Pre-scaled alone loses ground truth (we can't reason about sample confidence later). Raw alone forces the daemon to know each source's sample rate to render anything. Sending both costs ~8 bytes per record after compression and removes a class of bug forever.

### Storage today (v0.1.0)

Trace observations live in a **G-Set CRDT** (see §12). The legacy `observations` SQL table from v0.0.1 is dropped on the first start of a CRDT-aware daemon — see §13.4 for the migration rule (drop, don't preserve). A small denormalized SQL view of the G-Set is still maintained for cheap range queries by the viewer, but the G-Set on disk is the source of truth.

### Aggregation under partition   [LOCKED in 0.1.0 — Q3 resolved]

When two replicas observe the same `(src, dst)` during the same time window while disconnected, both observations enter the G-Set verbatim after merge. **We do not coalesce or "newer wins" within a time bucket.** The G-Set's "append-only, never deleted" contract (PRD §6.2) is preserved end-to-end. Rate calculations performed by the viewer may over-count under heavy partition; that is the honest answer and is preferable to silently losing observations. If over-counting becomes a real problem we will surface it in the viewer rather than fold it into the CRDT layer.

---

## 6. Clustering query contract (`/api/neighbors/:id`)   [LOCKED in 0.0.1]

```
GET /api/neighbors/:id?depth=N&cluster=auto|off|module&scope=<prefix>
  → {
      center: string,
      cluster_level: "function" | "module",
      nodes: [{ id, name, kind, count? }],     // count present at module level
      edges: [{ src, dst, weight, kind? }],    // kind: "cluster" for module-to-module
      total_raw_nodes: number
    }
```

### Cluster modes

- `cluster=auto` (default) — module-level above 500 raw nodes, otherwise function-level.
- `cluster=off` — always function-level. May produce >2k-node responses; the viewer handles this with a graceful-degradation message rather than a partial render.
- `cluster=module` — always module-level.

### Scope filter

`scope=<prefix>` restricts the response to entities whose ID starts with `<prefix>/` (or equals `<prefix>`). Edges where either endpoint is out of scope are dropped. The viewer uses this when expanding a clicked module to its members.

### Edge kinds

- Function-level edges carry no `kind` in the response (the underlying SQLite row's kind is not surfaced — callers don't need it for layout).
- Module-level (aggregated) edges carry `kind: "cluster"` so the viewer can style them distinctly.

### Thresholds

- **Auto-cluster threshold:** 500 raw nodes (per PRD §12.3).
- **Graceful degradation threshold (viewer-side):** 2000 visible nodes. Above this the viewer shows the "this isn't useful" action panel instead of attempting to render.

Both numbers are locked. Changing them requires a CHANGELOG entry because the daemon and the viewer must agree.

---

## 7. Edge resolution   [LOCKED in 0.0.1]

Two-pass resolution in `daemon/src/graph/ingest.ts::resolveEdges`:

**Pass 1.** Build three indexes from the parsed nodes:

| Index         | Key                                | Value type                  |
|---------------|------------------------------------|-----------------------------|
| `byFileName`  | `${file}::${name}`                 | entity ID                   |
| `byQualified` | `qualified_name`                   | entity ID, or `"ambiguous"` |
| `byName`      | bare `name`                        | entity ID, or `"ambiguous"` |

**Pass 2.** For each raw edge, try resolution in this order:

1. Same-file lookup: `byFileName[${src_file}::${dst_name}]`
2. Global qualified-name lookup (skip if `"ambiguous"`)
3. Global bare-name lookup (skip if `"ambiguous"`)

Unresolved edges get `dst = "?:<dst_name>"` — preserves the call site without inventing a destination. These are filterable later (e.g., for "find all external dependencies" queries).

### What this catches and what it doesn't

Catches:
- Local references (same file).
- Globally-unique qualified names.
- Globally-unique bare names.

Does not catch:
- Method dispatch where the receiver's type isn't statically obvious.
- Dynamic dispatch (e.g., `getattr(obj, name)()` in Python).
- Cross-language calls (FFI, IPC).

These are intentional v1 limitations. Trace-augmented edges (Week 3 onward) close most of the gap because they record what *actually happened* at runtime.

### Trace-name → entity resolution   [Added in 0.0.3]

Runtime collectors (`trace/{python,rust,go}/`) record call edges as **runtime names** (`myapp.auth:loginHandler`, `myapp::auth::Session::refresh`, `pkg.(*Store).GetUser`), which differ from the daemon's §1 entity ids. Those raw names stay **verbatim** in the G-Set op log and the `observations` read cache — they are the collector's ground truth and are never rewritten (§4). Resolution to entity ids is a **derived** read-time concern: `daemon/src/graph/traceResolve.ts` (`TraceNameResolver`) + `Db.resolvedTraceEdges()` normalize the runtime name (split on `::`/`.`/`:`/`/`; strip Go `(*T)` receivers and Rust `<…>` generics) and match the trailing `Type.method` qualified-name, then the bare `name`, against the live node index — **unambiguous-only**, mirroring `resolveEdges` above. An unmatched or ambiguous name stays **unresolved** (a wrong resolution would invent a false call edge — worse than an orphan). Surfaced via `hayven traces <id>`, and **merged into the §6 neighbors/clustering graph** (`daemon/src/daemon/routes/stats.ts`): the neighbor BFS traverses resolved trace edges alongside static `outgoing`/`incoming`, so runtime-observed calls the static parser missed surface as `kind:"trace_call"` edges (their nodes pulled into the neighborhood). Static edges win any shared pair; module-collapse + scope-filter need no special-casing; a graph with no trace observations is byte-identical to the static-only output.

---

## 8. Component boundaries   [LOCKED in 0.0.1]

| Concern                        | Owns it           | Notes                                                                                          |
|--------------------------------|-------------------|------------------------------------------------------------------------------------------------|
| HTTP API + CLI                 | `daemon/` (Bun/TS)| The user-facing surface.                                                                       |
| SQLite index                   | `daemon/`         | Raw `bun:sqlite`, no ORM. FTS5 trigram for fuzzy search.                                       |
| Markdown node writer/reader    | `daemon/`         | Source of truth lives on disk.                                                                 |
| Edge resolution                | `daemon/`         | Native emits raw `dst_name` strings; daemon resolves to IDs.                                   |
| Code parsing (Tree-sitter)     | `native/` (Rust)  | FFI to Tree-sitter's C library, parallelized with rayon.                                       |
| File watching                  | `native/`         | OS-native APIs (inotify/FSEvents/RDCW). Week 6 work; stubbed today.                            |
| CRDT wire serialization        | `native/`         | Hand-tuned binary format, brotli compression. Week 5 work; stubbed today.                       |
| CRDT logical layer             | `daemon/`         | Op application, merge, conflict detection. Week 5 work.                                        |
| Viewer (rendering, UI)         | `viewer/` (Astro) | Pure read-only. All mutations go through the daemon CLI/API.                                   |
| Python trace collection        | `trace/python/`   | Standalone package; users install separately.                                                  |

Rule: any change that crosses these boundaries must update this table.

---

## 9. Bun-philosophy decisions   [LOCKED in 0.0.1]

Decisions we've already made in the spirit of PRD §2.4 ("Original where it matters, boring where it doesn't"):

| Decision                                                | Replaced with                                                |
|---------------------------------------------------------|--------------------------------------------------------------|
| TanStack Query                                          | ~80-line hand-rolled `useQuery` (dedup + SWR + polling)      |
| CSS framework (Tailwind, etc.)                          | Hand-rolled scoped CSS in Astro                              |
| Icon library                                            | Inline SVG                                                   |
| Cytoscape / Sigma / D3 layout                           | Hand-rolled Barnes-Hut force sim                             |
| Canvas + WebGPU fallbacks                               | SVG-only with level-of-detail; graceful degradation message  |
| ORM                                                     | Raw `bun:sqlite` with typed query helpers                    |
| Argument-parsing library (yargs/commander)              | Hand-rolled `Bun.argv` parsing                               |
| Vector embeddings (v1)                                  | FTS5 trigram + model-free expansion floor (identifier tokenization + abbrev table, `daemon/src/db/queryExpansion.ts`) + LLM-driven query expansion when a model is pulled |
| Long-running MCP server                                 | First-party Skill + CLI                                      |
| `gray-matter` (frontmatter parse)                       | ~40-line hand-rolled line parser (`daemon/src/graph/nodeReader.ts::parseFrontmatter`) — the writer emits a closed simple subset |

### Where we have *not* applied the philosophy yet

- **Elysia.** A framework, sanctioned by PRD §4.2. Hand-rolled `Bun.serve` routing would be more in the spirit. Not worth re-litigating before v1.0.
- **CLI subcommand files** — *addressed in 0.0.3, but not by merging.* Investigation (mapped via `hayven query`/`neighbors` on `cli/`) found the per-command files are genuinely cohesive (100–400 lines each); merging them would reduce cohesion, not heaviness. The real "heavier than necessary" was the **dispatcher boilerplate** — every command needed an import + a `switch` case + a separately-maintained `HELP` block that could silently drift. `cli.ts` now drives both dispatch and help from a single `COMMANDS` table (help is *generated* from it, so it can't drift); the cohesive per-command files stay. Adding a subcommand is one table entry, not a three-place edit.

---

## 10. Open architectural questions

These will be decided as their week approaches.

> **See also `docs/REVIEW_BACKLOG.md`** — the deferred MEDIUM/LOW/NIT findings
> from the Week 6 review hardening pass (BL-1…BL-12), to be cleared before
> Week 7. Several touch locked sections here (BL-5 → §14.4, BL-6 → §15.1,
> BL-7 → §13.3) and will need a changelog row when fixed.

### Q1. HLC tie-breaking (Week 5)   [RESOLVED in 0.1.0 → §11]
Writer ID is a **16-byte random per-daemon ID**, generated once on first daemon start and persisted in `.hayven/config.json` under `writer_id` as a 32-char lowercase hex string. Comparison is **unsigned big-endian byte order on the raw 16-byte value** (equivalent to lexicographic order on the hex string). A replica that has never seen another writer needs no special handling — comparison is over IDs, not over relationships.

### Q2. SQL → CRDT migration for traces and claims (Week 5)   [RESOLVED in 0.1.0 → §13.4]
**Drop existing v0.0.1 SQL data on first start of the CRDT-aware daemon.** Pre-MVP, no production users; the cost of writing a faithful synthetic-clock backfill exceeds the value. The first-start migration deletes rows from `observations` and `claims`, logs a single `crdt_migration:dropped_legacy_sql_state` warning, and persists a schema-version bump.

### Q3. Observation aggregation under partition (Week 5)   [RESOLVED in 0.1.0 → §5]
**Keep both observations, sum honestly.** Strict G-Set semantics per PRD §6.2 — every observation persists forever once added by any replica. Rates may over-count under partition; if that turns out to matter in real use, the fix lives in the viewer's rate computation, not in the CRDT layer.

### Q4. Edge ID stability across re-ingest (Week 4 polish)   [RESOLVED in 0.0.2 → §7 / BL-10]
If a function moves files (a refactor), its entity ID changes and edges *to* it from **unchanged** files (not re-parsed on an incremental ingest) keep a stale `?:<name>` unresolved edge. **Resolved via the second approach** (always re-resolve unresolved edges — cheap, no heuristic): `reresolveAllEdges(db)` in `daemon/src/graph/ingest.ts` runs after every incremental batch (wired into `onBatch`), rebuilds the global qualified/bare-name indexes over the WHOLE node set, and re-resolves `?:`-prefixed edges with the same §7 unambiguous-only rule (ambiguous/missing stay unresolved). Shipped as BL-10 in the Week 8 sweep (see CHANGELOG); the heuristic "ID-migration" alternative was not needed.

### Q5. Native binary version-skew handling (Week 6)   [RESOLVED in 0.2.0 → §16.4]
**Daemon and `hayven-native` exchange semver strings via a `version` NDJSON record at the start of every subprocess invocation, and the daemon refuses to proceed if the major versions differ.** Brought forward from Week 8 because the Week 6 watcher introduces a fresh long-lived daemon ↔ native protocol — locking the handshake in now means the watcher's stream format never has to retro-handle a skewed peer.

### Q6. Daemon memory regression vs PRD §16 target
v0.0.1 measures 68 MB RSS idle; PRD target is <50 MB. Three possible fixes:
- `bun build --compile` (Week 8) — strips runtime overhead.
- Lazy-load viewer dist instead of memory-mapping at startup.
- Tighten SQLite cache.

Until measured, not clear which path is required.

### Q7. Tier-3 LLM integration for §7 conflict defense (Week 7)   [RESOLVED in 0.3.0 → §17]
**Decision: defer the model strata, but not Layer C's architecture.** Week 7 ships Layers A+B (which the PRD's own projection puts at 1.5–3%, already meeting the §16(4) <3% success criterion) plus Layer C's full *integration seam* — a pluggable `ClaimConflictOracle` invoked at claim-registration time. The default oracle is **deterministic and dependency-free** (entity-adjacency + name/scope overlap heuristic, see §17.3); the Tier-3 LLM (PRD §7.3) becomes a drop-in `Oracle` implementation once the model strata (PRD §8) exists, with no rewiring of the claim path.

Why not the alternatives:
- *Inline `llama.cpp` via Rust FFI now* — this is the eventual v1.0 destination (fully local, single distributable per §8), but it's the whole model-strata epic (5-tier hardware detection, model download/management, llama.cpp binding) and would dominate the conflict-defense week. Sequenced as its own effort alongside the Week 8 FFI/distribution work.
- *Spawn a local model server (Ollama / `llama.cpp` server)* — rejected for v1: it adds an external long-running dependency that cuts against the §9 "no long-running servers / fully local single install" stance, and makes Layer C fragile on the user having a server up. May serve as a Week 7.x bridge oracle if wanted, behind the same interface.

The seam is the load-bearing commitment; the model behind it is swappable. See §17.3 for the `ClaimConflictOracle` contract.

### Q8. Oracle warmth vs §9 / BL-13 — the reference-hardware contradiction   [RESOLVED 2026-05-31 — Blocker A → STRUCTURAL: heuristic ships, LlmOracle experimental]
On the $599 M4 reference box, the default cascade composes to disable the §18.4 `LlmOracle` silently: release tarballs build candle **CPU-only** (§18.6); the oracle **cold-spawns `hayven-native infer` per call** with no resident/warm mode (§18.4); against a **2000 ms** timeout; on timeout it **silently falls back to `HeuristicOracle`**. This puts §9 ("no long-running servers", Q7) in apparent contradiction with BL-13 (the intent-reading LLM as the fix for the heuristic's ~50–60% over-blocking): cold-spawn-per-call honours §9 but reopens BL-13. The §16(4) <3% number (2.4%/1.7%) was produced by the **heuristic**, so the *safety* deliverable is unaffected.

**Measured on M4 (2026-05-30 — `docs/ORACLE_WARMTH_DECISION.md` §9), the premise itself failed:**
- **Latency:** cold first-token p50 = 12.8 s (CPU) / 2.9 s (Metal) for `gemma3:1b`, 20.8 s / 8.2 s for `gemma3:4b` — **every config misses the 2 s timeout**, even Metal. So the oracle silently degrades to the heuristic today. (Generation is ~50 ms; the cost is model *load* — a resident model would answer in ~50–150 ms.)
- **Quality:** at a 60 s timeout (so latency can't mask it), neither Gemma beats the heuristic's 45.3% adjacent-benign over-blocking — `gemma3:1b` over-blocks **78%** (33% of calls unparseable), `gemma3:4b` over-blocks **100%** (constant "YES"). **Bigger is worse → the lever is the §7.3 prompt, not model size.**

So there are now **two blockers**, and the dominant one is new: **(A) the oracle as prompted does not discriminate** (BL-13's "the LLM is the fix" is empirically unsupported on local Gemma weights — the false-confidence pattern: BL-18 validated it returns *a* verdict, never a *good* one), and **(B) latency** (cold-per-call can't fire in 2 s → a resident model is required). The resident-vs-§9 decision is **deferred behind an oracle-discrimination fix (Blocker A)**, spec'd to not re-commit BL-18's error one level up: **(A.1)** rebuild `bench/oracle-conservatism.ts` onto **real diff/body pairs first** — re-gating a real-diff prompt on the current *synthetic-intent* bench would tune against the old confound; **(A.2)** re-prompt off the YES-bias + feed that real context; **(A.3)** gate on a **held-out split, beating 45% by more than the CI** (not "some variant cleared the full bench" — that selects for noise); **(A.4) kill-criterion** — if N iterations with real-diff context don't clear the held-out gate, the limitation is **structural** (single-shot YES/NO on a 1–4b local model is too coarse) and the heuristic ships as primary, `LlmOracle` stays experimental, §16(4) <3% (heuristic's) is the shipping number. Only if A *succeeds* does Blocker B (resident-vs-§9) reopen; latency is otherwise settled (resident-only). Until then the `LlmOracle` is **experimental, not the shipping BL-13 fix**. See `docs/ORACLE_WARMTH_DECISION.md` §9.3.

**RESOLVED 2026-05-31 — Blocker A executed (decision doc §10): STRUCTURAL.** A.1–A.4 ran on **real indexed-entity bodies** (1155 entities, held-out split, `gemma3:1b`): **no re-engineered prompt beat the heuristic's held-out gate** (v0 62.5% / v1 50.0% / v2 45.8%-but-**100% fallback** vs the heuristic's 45.8%), and the 1B model's fallback rate *rose* 77%→92%→100% as the prompt was tightened. A.4 kill-criterion triggered: single-shot YES/NO at this weight class can't do it (gemma3:4b is constant-"YES", 100%). **Decision: the `HeuristicOracle` ships as primary; the `LlmOracle` stays experimental (not the BL-13 fix); `buildPrompt` is unchanged.** Blocker B (resident-vs-§9) stays moot — A didn't succeed, so §9 is unthreatened. Confirmed: neither Gemma-4 (capability the oracle doesn't exercise; 4B already worse) nor a runtime swap (Ollama: same model + prompt, just warm) changes this.

---

## 11. Hybrid Logical Clock and writer ID   [LOCKED in 0.1.0]

The CRDT layer's notion of "happens-before" is a Hybrid Logical Clock (HLC) ordered against the writer ID. This section is the single source of truth for the HLC format, persistence, and comparison semantics.

### 11.1 Writer ID

- **Format.** 16 bytes (128 bits) of cryptographically random data, generated once per daemon install via `crypto.getRandomValues`. Persisted in `.hayven/config.json` under the key `writer_id` as a 32-character lowercase hex string. **Never regenerated** once written; deleting the field is treated as a fresh install. The writer ID is per-daemon (per-`.hayven/`), not per-user, because the CRDT layer's identity unit is the replica, not the human.
- **Disaster recovery must NOT copy the writer ID.** [Clarified in 0.2.0 — a review caught a spec contradiction with §14.1's "just rsync the directory."] Two replicas sharing a writer ID can mint identical `[hlc, writer]` keys for different content, which breaks the §11.3 total order and silently diverges. So the writer ID is **node identity, never data**: copying `.hayven/` to seed a new machine must exclude or clear `config.json::writer_id` (the new daemon generates its own on first start). Rsync the `crdt/` and `nodes/` data; let identity be local. The §12.1 contentHash tiebreak is a safety net for an accidental collision, not a license to copy the ID.
- **Why 16 bytes random and not a UUIDv7.** UUIDv7's time prefix is redundant with the HLC time; UUIDv4's hyphens add wire bytes. 16 raw bytes is the smallest form that gives us collision-free identification across a realistic peer population without coordination.
- **Comparison.** Unsigned big-endian byte order. The 32-char hex string compares lexicographically to the same result, so log lines and code can use either form interchangeably.
- **Privacy.** The writer ID is a per-install random value; it does not encode the user's identity. It is included in every CRDT op and therefore travels to every peer on sync. Treat it as opaque public information; do not derive it from anything secret.

### 11.2 HLC timestamp

A single HLC tick is a 12-byte tuple:

```
[ wall_ms : uint64 big-endian ][ counter : uint16 big-endian ][ reserved : uint16 = 0 ]
```

- **`wall_ms`** — Unix epoch milliseconds, taken from `Date.now()` clamped against the last observed HLC time. Monotonic per replica: the daemon refuses to emit a tick whose `wall_ms` is below `max(last_local_hlc.wall_ms, last_received_hlc.wall_ms)` and falls back to bumping the counter instead.
- **`counter`** — 16-bit logical counter, increments when two ticks share the same `wall_ms`. Resets to 0 the first time `wall_ms` advances. On counter overflow the generator **advances the logical `wall_ms` by 1 ms** rather than failing. [Changed in 0.2.0 — was "fatal protocol error"; a review found that adopting a remote HLC at `counter=0xffff` via the §11.4 skew rule could wedge a replica that had emitted zero ticks that millisecond. Bumping logical time keeps the clock monotonic and a single hostile/extreme remote value can't deadlock local progress. True 65 535-ticks-in-a-ms saturation, which we still never expect, simply nudges logical time forward.]
- **`reserved`** — two zero bytes, reserved for future use (e.g., epoch tag if we ever migrate the wall-clock origin). Decoders must reject non-zero reserved bytes so a future change is unambiguous.

### 11.3 Comparison

Two HLC values are compared component-wise: `wall_ms`, then `counter`. If both are equal, the tie is broken by writer ID (per §11.1). A 28-byte composite key `[12B HLC][16B writer_id]` therefore gives a total order over all CRDT ops in the system; this is the key the wire serializer uses for sort and the Merkle tree uses for ordering (see §13 and Week 6 §sync).

### 11.4 Clock-skew bound

We do not attempt NTP-grade clock sync. The HLC's monotonicity rule absorbs forward skew across the whole network: the first time a peer sees a remote HLC ahead of its own wall clock, it advances its local `wall_ms` to match. Backward skew (a peer's clock jumps back) is absorbed locally because the daemon stores `last_emitted_hlc` and refuses to issue ticks that go backwards. Pathological multi-hour skew degrades convergence speed but not correctness; correctness depends only on the total order of §11.3.

---

## 12. CRDT logical layer   [LOCKED in 0.1.0]

All three CRDT types live in `daemon/src/crdt/`. They are pure TypeScript with **no I/O dependencies** — persistence and wire encoding sit outside the module so the algorithms can be exercised in unit and property-based tests without touching disk or the FFI bridge.

### 12.1 LWW-Register   (`daemon/src/crdt/lww.ts`)

Used for: **code-entity node bodies** (the markdown summaries under `.hayven/nodes/`).

```ts
interface LwwState<T> {
  value: T;
  hlc: HlcTimestamp;   // 12 bytes
  writer: WriterId;    // 16 bytes
  contentHash: Uint8Array;  // blake3-256, 32 bytes
}

apply(state, op):  state'      // returns a new state, never mutates
merge(a, b):       LwwState    // commutative, associative, idempotent
```

`merge` picks the op whose composite key `[hlc, writer]` is greater per §11.3. A *true* key tie (same HLC **and** same writer, different content — reachable only if two replicas share a writer ID, which §11.1 forbids but a careless directory copy could cause) is broken deterministically by `contentHash` byte order, so `merge`/`apply` stay commutative even on degenerate input. `contentHash` also lets a receiver verify the body matches what the writer signed before applying — a tampered body fails the hash check and is rejected at the application layer, not silently merged. *[Hardened in 0.2.0 — the tiebreak was added after a review found `merge` was non-commutative on a true tie.]*

### 12.2 G-Set   (`daemon/src/crdt/gset.ts`)

Used for: **trace observations**.

```ts
interface GSetOp {
  kind: "observe";
  src: string;
  dst: string;
  tsBucket: number;   // unix seconds, truncated to bucket boundary
  observed: number;   // uint16 on the wire
  weight: number;     // uint16 on the wire
  hlc: HlcTimestamp;
  writer: WriterId;
}
```

The element identity is the tuple `(src, dst, tsBucket, observed, weight, hlc, writer)` — see Q3 in §10. Two replicas that observe the same `(src, dst, tsBucket)` independently end up with two distinct elements after merge; the application layer sums weights honestly when it materializes the view.

Merging is set union by the 28-byte op key `[hlc, writer]` — collisions are mathematically impossible under the §11 monotonicity rule because no two ops from the same writer can share an HLC, and no two ops from different writers can share a writer ID.

### 12.3 OR-Set   (`daemon/src/crdt/orset.ts`)

Used for: **the claims board**.

```ts
interface OrAddOp     { kind: "add";    claimId: string; agent: string; payload: ClaimPayload;  tag: Tag; hlc; writer; }
interface OrRemoveOp  { kind: "remove"; claimId: string;                                       observedTags: Tag[]; hlc; writer; }
```

A `Tag` is the 28-byte composite key `[hlc, writer]` of the `add` op. A `remove` op carries the set of `add` tags it has *observed*: it only un-shadows those specific add tags. An add that arrives after a remove (so the remove never saw it) is **still active** post-merge. This is the standard OR-Set guarantee and what PRD §6.3 calls out as "resolves the I-claimed-it-you-didn't-see race in favor of the earlier logical timestamp."

The materialized "active claims" view is the set of all add tags not present in any remove op's `observedTags`.

**Claims CONVERGE; they do not provide mutual exclusion.   [Clarified in 0.0.3]** The OR-Set is designed so every replica eventually agrees on the *set* of claims — not so that a claim grants exclusive access. Under **partition** — the exact case the CRDT exists for — two agents can each `add` a claim on the same entity, and **both survive the merge** (both adds are active until explicitly removed). There is no "first claim wins" at the CRDT layer; there cannot be, without a coordinator. So **"I claimed it, so I'm safe" is wrong under precisely the partition conditions that matter.** The actual safety net is the three-layer conflict defense (§17): Layer A's scope-overlap 409 and Layer C's oracle reason over the *converged* claim set at registration time. The claim board is the input to that defense, not a lock.

### 12.4 Convergence guarantees

For each CRDT type the property test in `daemon/tests/crdt_convergence.test.ts` asserts:

1. **Commutativity** — `merge(a, b)` produces the same materialized view as `merge(b, a)`.
2. **Associativity** — `merge(merge(a, b), c)` equals `merge(a, merge(b, c))`.
3. **Idempotence** — `merge(a, a)` equals `a`.
4. **Partition-recovery** — for any sequence of ops split across N replicas with arbitrary delivery order, after gossip completes every replica converges to the same state.

Property 4 is the actual deliverable per the Week 5 PRD entry; properties 1–3 are sanity checks that catch regressions in the algorithm before the partition simulator does.

---

## 13. CRDT wire format   [LOCKED in 0.1.0]

The wire format is owned by `hayven-native` (Rust) and read/written via the FFI bridge documented in §13.5. The format optimizes for: tiny per-op overhead, shared-string deduplication across ops in a batch, and brotli-compressible structure.

### 13.1 Batch envelope

```
[magic: "HYV1" : 4 bytes]
[op_count: varint]
[string_table_count: varint]
[ for each st_entry: { len: varint; bytes: utf8 } ]
[ for each op: encoded op record (variable length) ]
```

- **Magic** disambiguates a CRDT batch from a parse-protocol record at byte 0.
- **String table** is per-batch, not per-process: the encoder collects every entity ID, agent ID, and similar string referenced by the batch's ops into a deduplicated table and rewrites the op records to reference table indices instead of literal strings. Saves ~60% on batches dominated by trace ops (where `src`/`dst` repeat heavily).
- **Brotli quality 6** is applied to the full envelope. Smaller-than-128-byte envelopes skip brotli (compressed result is larger than raw); the leading byte of the on-disk record indicates compression: `0x00` = raw, `0x01` = brotli.

### 13.2 Per-op encoding

```
[ op_kind     : 1 byte ]    // 0x10=lww, 0x20=gset_observe, 0x30=or_add, 0x31=or_remove
[ hlc         : 12 bytes ]
[ writer_id   : 16 bytes ]
[ op-specific payload, see §13.3 ]
```

### 13.3 Op-specific payloads

| op_kind | Payload                                                                                              |
|---------|------------------------------------------------------------------------------------------------------|
| `0x10` LWW       | `[entity_id_idx: varint][content_hash: 32B][body_len: varint][brotli(body): bytes]`               |
| `0x20` G-Set obs | `[src_idx: varint][dst_idx: varint][ts_bucket: u32 be][observed: u16 be][weight: u16 be]` — **41 bytes including the op-kind + hlc + writer prefix when both indices fit in 1 varint byte (~256 distinct entities/batch).** |
| `0x30` OR-Set add  | `[claim_id_idx: varint][agent_idx: varint][payload_len: varint][payload: cbor bytes]`           |
| `0x31` OR-Set rm   | `[claim_id_idx: varint][observed_tag_count: varint][ tag: 28B ]*observed_tag_count`              |

`varint` is the standard LEB128 unsigned-int encoding (same as Protocol Buffers): 1 byte for values <128, growing 7 bits per byte.

**Decoder hardening [0.2.0].** Every length/count derived from an untrusted varint is bounds-checked before it indexes the buffer: the OR-remove `observed_tag_count * 28` uses `checked_mul`, and the cursor's `pos + n` uses `checked_add`. An overflow returns a clean truncation error rather than panicking. The FFI boundary (§13.5) additionally wraps encode/decode in `catch_unwind` so a decoder panic can never unwind across the C ABI. [A review found a crafted OR-remove `tag_count` could panic the decoder — remotely triggerable over §15's sync endpoints.]

**Length/count varint cap [0.2.0].** Every varint used as a *length or count* in the §13 wire format (the batch `op_count` and `string_table_count`, each string-table `len`, the LWW `body_len`, the OR-add `payload_len`, and the OR-remove `observed_tag_count`) MUST fit the unsigned 32-bit range — value ≤ `4_294_967_295` (`2^32 − 1`). Both the TypeScript and the Rust readers reject (clean error, no panic) any length/count varint that exceeds u32 range, before it is used to size or index a buffer. The shared cap keeps the two readers byte-compatible on the same rejection boundary. Generic, non-length varint values (e.g. enum/discriminator fields encoded as varints) are unaffected by this cap.

### 13.4 SQL → CRDT migration   [Q2 resolved]

On the first start of a daemon at schema version ≥2 against a database at schema version 1:

1. Begin transaction.
2. `DELETE FROM observations;`
3. `DELETE FROM claims;`
4. Bump `PRAGMA user_version = 2`.
5. Commit.
6. Log a single warning: `crdt_migration: dropped legacy v0.0.1 SQL state (traces=N, claims=M) — pre-MVP, intentional per ARCHITECTURE.md §13.4`.

The CRDT op logs under `.hayven/crdt/` start empty. There is no synthetic backfill. **This is a one-way operation**; once user_version is 2 the daemon will not roll back to schema 1.

### 13.5 FFI bridge

Bun FFI calls into the `hayven_native` cdylib (built alongside the binary by Cargo). Exported symbols:

| Symbol                       | Args                                              | Returns                          |
|------------------------------|---------------------------------------------------|----------------------------------|
| `hayven_crdt_encode_batch`   | `(ptr, len) → ptr` JSON-in, binary-out            | freshly-allocated bytes + length |
| `hayven_crdt_decode_batch`   | `(ptr, len) → ptr` binary-in, JSON-out            | freshly-allocated bytes + length |
| `hayven_crdt_free`           | `(ptr)`                                           | —                                |

Both calls are **stateless** — no global mutable state on the Rust side — so they are safe to call from any thread the JS runtime hands them. JSON is used at the FFI boundary (not the wire) for clarity during development; we revisit this with a benchmark before v1.0 if it shows up in profiles.

If the cdylib is not available at runtime (e.g., dev mode where only the binary was built), the daemon transparently falls back to spawning `hayven-native serialize` with the batch on stdin and the encoded bytes on stdout. The wire format is identical either way.

---

## 14. CRDT op-log persistence   [LOCKED in 0.2.0]

The CRDT logical layer (§12) is in-memory. Persistence is an append-only segmented log on disk that hydrates state on daemon start and that the sync layer (§15) gossips over a Merkle tree.

### 14.1 Directory layout

```
.hayven/crdt/
├── lww/
│   └── YYYY-MM-DD.log          # LWW ops bucketed by HLC day
├── gset/
│   └── YYYY-MM-DD.log          # G-Set ops, same bucketing
├── orset/
│   └── YYYY-MM-DD.log          # OR-Set ops, same bucketing
└── merkle.json                 # cached Merkle roots (regenerable)
```

**Day boundaries** are wall-clock UTC days derived from the **op's HLC `wall_ms`** — never the writer's local `now()`. [Enforced in 0.2.0; the first implementation bucketed by `now()`, which put the same op in differently-named files on different machines so they could never converge. A review caught it.] Because the HLC day is a property of the op, identical on every replica, the same op always lands in the same-named segment everywhere — the precondition for the order-independent Merkle leaves in §15.1. The "rsync the `crdt/` directory" DR story holds, with the §11.1 caveat: copy the data, not `config.json::writer_id`.

### 14.2 Segment file format

Each `.log` is a concatenation of length-prefixed §13 wire batches:

```
[batch: { varint batch_len; bytes batch[batch_len] }]*
```

`batch` is the exact byte-for-byte output of `encode_batch` (§13), including its leading compression marker. Readers stream the file by reading a varint, then `batch_len` bytes, then handing the chunk to `decode_batch`. EOF in the middle of a batch is treated as a torn write — the segment is truncated to the last complete batch on the next start and a `crdt_log:truncated_torn_write` warning is logged.

### 14.3 Write path

Writers always append. Format:

1. Encode one or more new ops into a single §13 batch via `encode_batch`.
2. Open the appropriate day's segment with `O_APPEND` (one writer per segment per daemon — the daemon serializes writes via a single worker queue).
3. Write the varint length, then the batch bytes.
4. `fdatasync` the file every N writes (default 32) or every M milliseconds (default 250 ms), whichever is sooner. Pre-MVP no production users, so the cost of a power-loss test gap is just "lose the last 250 ms of ops on this replica," which the sync layer will reconcile on next contact.

### 14.4 Hydrate path

On daemon start, for each CRDT type:

1. Enumerate `<type>/*.log` in lexicographic (date) order.
2. For each segment, stream batches and call the matching `applyXxx` per op.
3. On a torn write inside a segment (see §14.2), truncate that segment to its last good batch and continue hydrating later segments — a torn older segment must not hide the newer good days that sort after it.

The hydrated in-memory state is the source of truth for the request path; subsequent writes go to both the segment and the in-memory state in lock-step (segment first, then memory — a crash between the two re-reads the segment on next start and converges).

### 14.5 Garbage collection (out of scope for 0.2.0)

Old segments are not deleted today. Compaction is a v1.1 concern; the PRD's 30K-files-on-Mac-mini sizing makes the log small enough that this is not a 0.2.0 problem (estimate: ~50 MB/year of ops on a typical 10-engineer project).

---

## 15. Sync protocol   [LOCKED in 0.2.0]

The sync layer gossips §14 segments between peers using a Merkle tree over the segment files. Peers exchange root hashes; if equal, sync is a single 64-byte round-trip. If different, peers descend the tree to find the divergent segments and pull the missing batches.

### 15.1 Merkle tree shape

The tree is **per CRDT type**. Leaves are individual segment files (one per HLC day).

**The leaf hash is over the segment's op-key SET, not its raw bytes.** [Changed in 0.2.0 — the original "blake3 of the file's bytes" could never converge two real peers: each appends ops in its own order, so byte-identical files were impossible. A review caught it.] Concretely: decode the segment's batches, collect each op's 28-byte `[hlc][writer]` composite key, sort and de-duplicate them, then `blake3(0x00 ‖ key₀ ‖ key₁ ‖ …)`. Two replicas that hold the same op-set for a day produce the same leaf regardless of append order — which is the whole point of a CRDT.

Internal nodes are `blake3(0x01 ‖ min(a,b) ‖ max(a,b))` — children sorted before hashing so the tree is canonical regardless of order. The **domain-separation tags** (`0x00` leaf, `0x01` internal) stop a leaf hash from ever being reinterpreted as an internal-node hash. An odd level **promotes** the unpaired node unchanged rather than duplicating it, closing the classic Merkle duplication ambiguity where `root([A,B,C]) == root([A,B,C,C])`. [Both hardenings added in 0.2.0 per the review.]

A peer caches `merkle.json` (v2 format) keyed by `(crdt_type, segment_day) → { blake3, mtimeMs, size, ... }`. The cache key carries a **content discriminator** alongside `mtimeMs` and `size`; a cached leaf is reused only when the discriminator **and** `mtimeMs` **and** `size` all match the segment on disk, otherwise the segment is re-decoded. There is no separate cache-invalidation call: because the key is derived from segment content, *any* segment mutation — including a torn-write truncation (§14.4) or a same-size overwrite — produces a different key and so naturally recomputes the leaf. Decoding to extract op keys is the expensive part, which is exactly what the cache skips for unchanged days. (Perf note: today's segment changes constantly and is re-decoded on each sync; with the 30-min default `auto_sync_interval` this is acceptable, but a batched native `decode-segment` call is a known optimization if it shows up in profiles.)

### 15.2 Wire surface

```
GET  /api/sync/merkle
  → { lww: <root_hex>, gset: <root_hex>, orset: <root_hex> }

POST /api/sync/leaves
  body: { type: "lww" | "gset" | "orset", since_root: <hex> }
  → { leaves: [{ path: "YYYY-MM-DD", hash: <hex> }] }

POST /api/sync/batch
  body: { type, path: "YYYY-MM-DD", offset?: <varint>, max_bytes?: <int> }
  → application/octet-stream : raw segment bytes from `offset`, capped
    at `max_bytes` (default 1 MiB). Caller streams successive ranges
    until the segment-end is reached.

POST /api/sync/push
  body: { type, path, batch: <base64-encoded §13 envelope> }
  → { ok: true } — peer appends `batch` to its corresponding segment.
```

### 15.3 Live sync (WebSocket)

`/ws/sync` is the long-lived sibling of `/api/sync/push`. Frames:

```
text  : {"type":"hello","writer_id":"<32-hex>","versions":{"lww":<n>,"gset":<n>,"orset":<n>}}
binary: <1-byte type: 0x10|0x20|0x30> <§13 envelope bytes>
```

WebSocket peers do not Merkle-exchange; they push ops as they happen. A reconnect after disconnection triggers a one-shot `/api/sync/leaves` reconciliation to catch up any ops missed while offline. Live sync is a latency optimization, not a correctness mechanism — every op that goes over the WS path is also on disk in the sender's segment.

### 15.4 Bandwidth contract

Per PRD §16 (5): a routine daily sync between two machines transfers **<30 KB**. The Week 5 wire format (1.6% of JSON) plus the Merkle-tree descent (logarithmic in segments) gives us the headroom for that. The Week 6 measurement harness records actual bytes-on-the-wire on a `tc qdisc`-throttled link and the result lands in `CHANGELOG.md`.

### 15.5 CLI

```
hayven sync <peer-url>          # one-shot pull
hayven sync --watch <peer-url>  # WebSocket live sync, daemonized
hayven sync --status            # show last sync per configured peer
```

`config.json::sync_peers` drives the daemon's `auto_sync_interval_minutes` cron.

---

## 16. Native file watcher protocol   [LOCKED in 0.2.0]

The daemon supervises a long-running `hayven-native watch` subprocess that streams change events as NDJSON on stdout. This is the only new daemon ↔ native long-lived protocol in 0.2.0; the parse and serialize protocols stay byte-for-byte compatible with 0.1.0.

### 16.1 Invocation

```sh
hayven-native watch --root <abs-path> [--debounce-ms N] [--max-event-rate N]
```

### 16.2 NDJSON record types

```
{"type":"version","major":N,"minor":N,"patch":N,"protocol":2}
{"type":"ready","platform":"darwin|linux|windows","backend":"fsevents|inotify|rdcw"}
{"type":"change","file":"<repo-rel>","kind":"create|modify|delete|rename","from":"<repo-rel>?","ts_ms":N}
{"type":"overflow","dropped":N,"since_ms":N}
{"type":"heartbeat","ts_ms":N}      # every 15 s, lets daemon detect a hung backend
{"type":"warn","message":"..."}
{"type":"fatal","message":"..."}
```

- `version` is always first. See §16.4.
- `ready` arrives once the watcher has registered with the OS; the daemon doesn't treat `change` events as authoritative until `ready` has been seen.
- `overflow` is emitted when the OS event queue saturated (e.g., a 50 K-file `git checkout`) — the daemon responds by triggering a full re-scan rather than trusting the partial event stream. **Detection note [0.2.0]:** the `notify` crate delivers saturation as a normal `Ok(event)` carrying `EventKind::Other` + `Flag::Rescan` (inotify `Q_OVERFLOW`, FSEvents `MUST_SCAN_SUBDIRS`), **not** as a channel error. The watcher checks `event.flag() == Flag::Rescan` on the Ok branch and emits `overflow`; overflow signals are coalesced per loop pass so `dropped` is an honest count and `since_ms` marks when the uncertainty window opened. [A review found the original code only inspected the channel-error branch, so saturation was silently dropped and the §16.5 safety net never fired.]

### 16.3 Daemon-side debounce + re-ingest

The daemon batches `change` events on a configurable debounce window (default 200 ms) and re-runs `hayven-native parse` against only the affected files. This is incremental ingest — the full-repo ingest path stays unchanged for `hayven ingest` and the initial start.

**Reconcile, don't just append [0.2.0].** A batch is classified by `kind`: `delete` events (and a `rename`'s `from` path) purge the file's rows from the index; `create`/`modify`/`rename` files are purged **then** re-parsed, so a modification that removed entities doesn't leave stale rows. [A review found the original path only re-parsed-and-upserted, so deletes lingered forever.] All ingest work — incremental, overflow full-rescan, and API-triggered `hayven ingest` — runs through a **single-flight queue** so concurrent SQLite writers can't interleave. (Known limitation, deferred: incremental `--files` resolves edges only within the changed set; a full cross-graph edge re-resolution on incremental is a later pass.)

### 16.4 Version handshake   [Q5 resolved]

Every `hayven-native` subprocess invocation (parse, serialize, watch) emits a `version` NDJSON record as the **first** line on stdout. The daemon compares the record's `major` against its own bundled-version expectation. **Mismatched majors abort the invocation** with a fatal log line:

```
hayven-native version skew: daemon expects 0.x, native reports 1.x — refusing to run.
Fix: run `hayven doctor` or reinstall the matched pair.
```

Matching majors but mismatched minors are allowed and logged at debug level. **All three subprocess paths now enforce the check [0.2.0]:** parse and watch abort the run on a major mismatch (a review found parse was *swallowing* the skew error inside its generic NDJSON catch and ingesting anyway); the serialize subcommand emits its `version` on **stderr** (stdout is the binary payload) and the daemon's subprocess bridge checks that stderr line once per bridge. Old 0.0.1 binaries that emit `start` first (no `version`) are still tolerated during rollout.

### 16.5 CPU + correctness budget

Per PRD §16 (9): file watcher <0.1% CPU on 30K-file repos. Measured in the Week 6 harness on a 30K-TS-file synthetic repo by `top -pid` sampling during a representative edit pattern. Correctness budget: zero missed events under normal load (verified by a property test that scribbles random files and compares the watcher's reported set to the on-disk truth); under overflow the daemon falls back to full re-scan within 1 second.

---

## 17. Three-layer conflict defense (Week 7)   [LOCKED in 0.3.0]

Implements PRD §7. Target: two parallel agents on one codebase produce <3% semantic conflicts (§16(4)). The CRDT layer (§11–§15) guarantees *eventual convergence*; this section is the **application layer that enforces semantic validity and prevents conflicts before they happen**. The three layers are independent and additive — each can be tested and shipped on its own.

Contract-before-code, same as Weeks 5–6: the interfaces below are locked so the claim path, the verify gate, and the oracle can be built against an agreed shape.

**Why this layer exists — claims are advisory, not exclusive.   [Clarified in 0.0.3]** The OR-Set claim board (§12.3) is built to *converge*, not to grant mutual exclusion: under partition two agents can both claim the same entity and both survive the merge. So a held claim is **not** a lock — "I claimed it, so I'm safe" fails under exactly the partition conditions the CRDT is for. **This three-layer defense is the actual safety net** (Layer A scope-overlap 409, Layer C oracle), reasoning over the converged claim set at registration time. The claim board is its input, not a substitute for it.

### 17.1 Layer A — semantic (entity-level) claims

Already substantially shipped in Week 6: the OR-Set claim board (§12.3, `daemon/src/crdt/orset.ts`, `/api/claims`) stores `ClaimPayload.scope` as a list of **entity IDs** (`<scope>/<module>/<qualified_name>`, per `graph/idScheme.ts`), not file paths. Week 7's addition is **adjacency detection** (`daemon/src/conflict/adjacency.ts`), not new storage:

- **Scope is a set of canonical entity IDs.** Two claims *overlap* iff their scope sets intersect. Two claims are *adjacent* iff a graph edge (static or trace, §5; looked up via `Db.outgoing`/`Db.incoming`) connects any entity in one scope to any entity in the other, OR they share a containing **module prefix** — the entity id with its final `/`-segment removed (so `auth/login/handler` and `auth/login/validate` share `auth/login`; the structural separator is `/`, methods keep their `.` inside the last segment and are not split on). Overlap is a hard conflict; adjacency is the trigger for Layer C.
- `hayven claim <ids...> --intent` registers a claim; the daemon computes overlap (reject/409 naming the conflicting claim + overlapping entities) and adjacency (→ Layer C preview) against the set of **active** claims at registration time.

### 17.2 Layer B — pre-merge semantic verify

Implemented in `daemon/src/conflict/verify.ts`; hooked into the watcher's incremental re-ingest (`cli/daemon.ts` `onBatch → drainIngest`) — the one place with a known *affected-file set*. Runs **after** the merge is materialized into the read cache (never before — CRDT convergence is unconditional and is never rolled back). The full-ingest path (`hayven ingest`) re-walks the whole repo and has no merge semantics, so it is deliberately not gated. Granularity is the **repo-relative file** (the stable identifier the hook has), recorded with phase + language. The two phases:

1. **Syntax** — re-parse the affected file(s) via `hayven-native parse --files-stdin` (Tree-sitter). Because tree-sitter is error-recovering, the parser inspects `root_node().has_error()` and emits a syntax `warn` for any file containing an ERROR/MISSING node [native parse path, 0.3.0]; a `warn`/`fatal` for an affected file, or a non-zero native exit, fails that file's syntax phase.
2. **Type** — where a typechecker is *configured* for the language, run it scoped to the affected files. "Configured" is detected by toolchain + config presence: TS → `tsconfig.json` + `tsc`; Python → `mypy.ini`/`setup.cfg`/`pyproject.toml` + `mypy`; Rust → `Cargo.toml` + `cargo check`. JS/Go have no checker wired. Absence of a configured checker (or a missing tool, exit 127) is a *pass* (we don't block on what we can't check), surfaced in `skippedTypecheck`.

A failed gate does **not** roll back the CRDT; it records a `merge_rejected` (`{ file, phase, reason, language, detectedAt }`) in the `merge_rejections` SQL side-table and sets `nodes.merge_flagged` on the affected file's surviving rows, surfaced via `GET /api/merge-rejections` + the `/api/stats` count so an agent re-bases. Stale flags are cleared per-file at the start of each gated re-ingest (re-evaluated every time, no TTL). Schema v2→v3 (additive). The gate is advisory-to-the-agent, authoritative-to-the-application-cache: the conflict is visible rather than silently materialized.

### 17.3 Layer C — adversarial claim preview (the swappable seam)   [Q7]

When registering a claim that is *adjacent* (§17.1) to an active claim, the daemon runs one `ClaimConflictOracle` call. The interface is the locked commitment; the implementation behind it is swappable (Q7).

```ts
interface ClaimConflictOracle {
  /** Could these two intended work-scopes break each other's assumptions? */
  assess(incoming: ClaimContext, adjacent: ClaimContext): Promise<ConflictVerdict>;
  readonly id: string;        // e.g. "heuristic-v1", "gemma-e4b"
}
interface ClaimContext {
  scope: readonly string[];   // entity IDs
  intent: string;             // human/agent-written claim intent
  neighbors: readonly string[]; // adjacent entity IDs from the graph
}
interface ConflictVerdict {
  conflict: boolean;
  reason: string;             // one sentence
  confidence: number;         // 0..1; heuristic uses coarse bands
  oracle: string;             // which oracle answered (provenance)
}
```

- **Default impl — `HeuristicOracle` (`heuristic-v1`), deterministic, zero deps.** `conflict = true` when scopes share a graph neighbor AND the two intents touch overlapping surface (shared identifier tokens in intent/scope, or one scope's entity appears in the other's `neighbors`). Pure function of the claim board + graph; no I/O, fully unit-testable. This is the Week 7 shipping default and meets the deliverable via Layers A+B.
- **Future impl — `LlmOracle` (`gemma-e4b`/etc.), drop-in.** Wraps the PRD §7.3 prompt against a Tier-3 local model once the strata layer (PRD §8) is built. Same interface; selected by config (`conflict.oracle`). A Groq/Ollama bridge oracle, if ever wanted, implements the same interface.
- Implemented in `daemon/src/conflict/oracle.ts`: the interface, `HeuristicOracle`, and a `selectOracle(config.conflict.oracle)` factory defaulting to the heuristic — that factory is the LLM drop-in point. `HeuristicOracle` tokenizes intent/scope (lowercase, split on non-alphanumerics, drop stopwords + tokens < 3 chars) and bands confidence: 0.8 (≥2 shared identifier tokens), 0.5 (exactly 1), 0.0 (no shared neighbor or no shared surface).
- On `conflict: true`, claim registration returns **`202`** with the verdict(s) and does **not** register (the agent waits / proposes a coordination plan); with `force: true` it registers (`201`) and records the overridden verdict for audit. **The override record is local, non-converging metadata** (it lives beside the SQL read cache / DTO, surfaced as `overriddenVerdicts` on POST + GET — *not* in the OR-Set wire payload), because a force decision concerns this replica's override, not replicated claim state. `conflict: false` or no adjacency → normal `201`. The `hayven claim` CLI maps these to exit codes 0 (registered) / 3 (202 coordinate) / 1 (error).

### 17.4 Conflict-rate measurement harness

Deliverable evidence for §16(4). A test harness drives **two simulated agents** editing an indexed fixture repo with a controlled overlap distribution, runs the full A+B+C path, and reports the realized semantic-conflict rate. It asserts `< 0.03` and records the per-layer contribution (naive → +A → +B → +C) so the PRD §7 projection table is checked against measurement, not assumed. The harness is oracle-parameterized, so swapping in `LlmOracle` later re-runs the same measurement.

---

## 18. Model strata — local inference (Week 8)   [LOCKED in 0.3.0]

Implements PRD §8. **Engine decision: `candle` (pure Rust), not llama.cpp FFI.** Both give the same single-binary, fully-local property and read the same GGUF quantized Gemma models; candle builds on the **existing `cargo`/`cross` 5-platform matrix** (`release.yml`) with no C++/clang/bindgen, and integrates into `hayven-native` with no `unsafe` FFI boundary. The `ClaimConflictOracle` seam (§17.3) keeps the engine swappable, so this is not a one-way door (a llama.cpp-backed oracle can replace candle later without touching the claim path).

### 18.1 Engine + transport
- `candle-core` + `candle-transformers` in `hayven-native` (Gemma architecture, GGUF, Metal/CUDA/CPU backends). CPU backend is the portable default; Metal on macOS via cargo feature; CUDA optional, not in the default release.
- Transport: a new **`hayven-native infer`** subcommand, consistent with the existing subprocess model (parse/serialize/watch). The daemon spawns it with the prompt on stdin and reads the completion on stdout. No new FFI surface (a direct dlopen path is a later optimization, same posture as the CRDT bridge).

### 18.2 Hardware → model map (PRD §8)
- A **model registry** (`daemon/src/models/registry.ts`: `id → { tier, params, min_ram_mb, artifacts: { filename, url, sha256 }[] }`) is the source of truth; `config.models.tierN.model` references a registry id. Tier-3 (the reflex tier the Layer C oracle uses) defaults to the **smallest Gemma (~2B class, Q4_K_M GGUF)** so it runs on the broadest hardware (PRD §8 bottom tiers).
- **ID aliasing:** the PRD §8 `gemma4:*` ids are kept stable (config + `hardware/detect.ts` recommend by id) and aliased onto **real, currently-published** Gemma GGUF builds: `gemma4:e2b`/`e4b` → `bartowski/google_gemma-4-E{2,4}B-it-GGUF` (Q4_K_M); `gemma4:26b` → `bartowski/gemma-2-27b-it-GGUF`. sha256 values are the published HF LFS oids (verified, not invented).
- `hayven doctor` probes hardware and recommends a tier (§18.5); the user can override in `config.models`.

### 18.3 Model lifecycle
- A model's artifacts live in a **per-model directory** `.hayven/models/<dirname>/` (`dirname` = the id with `:`/`/` → `_`), NOT in the repo or binary. The directory holds **`model.gguf`** — and that's all that's required: **`hayven-native infer` builds the tokenizer from the GGUF's embedded `tokenizer.ggml.*` metadata** (`native/src/infer/gguf_tokenizer.rs`), so no sidecar download is needed [BL-14 resolved]. A `tokenizer.json` in the dir is an **optional byte-exact override** (used if present, else built from the GGUF). The §16(1) ~60 MB install is **binaries only**; weights are a separate, opt-in pull (~1–2 GB). `hayven-native infer --model <DIR>` loads the weights + builds/loads the tokenizer from the directory.
- `hayven models pull <id>` downloads each declared artifact (just `model.gguf`), **sha256-verifies** against the registry (warn-and-skip when a hash is unset rather than inventing one), and writes atomically (temp + rename); idempotent. `hayven models list` shows presence. Missing/offline is not an error. `isModelPresent` requires the declared artifacts (the gguf), so a plain `models pull` makes the model usable.
- **Graceful default (load-bearing):** if the tier-3 model is absent, Layer C uses `heuristic-v1` (always available, §17.3). The LLM oracle is opt-in-after-download. A fresh install ships working conflict defense with **zero download**; the LLM is an upgrade, not a dependency.
- **Tokenizer fidelity [BL-18].** The from-GGUF tokenizer is byte-exact for standard SentencePiece Gemma (2/3) — which covers the **config defaults**: `conflict.oracle` / Tier-3 reflex is `gemma3:1b` and the Tier-2 workhorse is `gemma3:4b` (both ungated bartowski Q4_K_M, sha256-pinned). The GGUF omits SPM's `precompiled_charsmap` (NFKC) and Gemma-4's custom newline pre-tokenizer, so **if** the **Gemma-4 E-series** were ever used (its `gemma4:*` ids are not loadable by candle 0.10.2 and are not the default — see §18.2/the registry header), multi-newline / NFKC-heavy inputs could differ by a token — immaterial for the short English §7.3 conflict-preview prompts; the optional sidecar `tokenizer.json` gives byte-exactness on demand. Unfaithfully-reconstructible families (BPE/unknown) are **refused** with an actionable "place a sidecar tokenizer.json" message rather than mis-tokenizing. Real-weights end-to-end validation is BL-18.

### 18.4 `LlmOracle` — the Layer C upgrade (retires the BL-13 gap)
- Implements the locked `ClaimConflictOracle` (§17.3). Builds the PRD §7.3 prompt ("Read claim A and my intended work — could our edits break each other's assumptions? YES/NO + one sentence"), spawns `hayven-native infer`, parses YES/NO + reason → `ConflictVerdict` (`conflict`, a `confidence` from the verdict, `reason`, `oracle` id e.g. `gemma-2b`).
- **Hard timeout** (default 2 s; PRD §7.3 targets ~200 ms with headroom) and **any error → fall back to `heuristic-v1`**. The claim path is never blocked on the model. `selectOracle` (§17.3) wires `LlmOracle` when `config.conflict.oracle` names a present model id, else the heuristic.
- The LLM was *intended* as the principled fix for the heuristic's ~50–60% adjacent-benign over-blocking (BL-13): reading *intent*, it could in principle tell a contract-changing edit from an internal one — the discrimination the token heuristic structurally cannot. **[Measured 2026-05-30 — see §10 Q8 / `docs/ORACLE_WARMTH_DECISION.md` §9.2: this is NOT borne out on local Gemma weights as currently prompted. `gemma3:1b` over-blocks 78%, `gemma3:4b` 100%, vs the heuristic's 45% — both WORSE. The §7.3 prompt biases toward YES on thin intent strings; fixing discrimination (prompt + real diff context) is prerequisite work before the LLM can claim the BL-13 fix.]**
- **Per-call cold spawn — adequacy on reference hardware is Q8.** Today `LlmOracle` cold-spawns `hayven-native infer` (`daemon/src/native/infer.ts`) on every `assess` — there is no resident/warm model — paying a full GGUF load + first-token cost against the 2000 ms timeout, with silent fallback to the heuristic on timeout/error. On a CPU-only reference box this very plausibly times out every call, so the oracle is unlikely to fire and the demotion is invisible (only a `logger.warn`; `verdict.oracle` flips to `heuristic-v1`). Whether this is acceptable on the $599 M4 — and whether honouring §9's no-resident-server stance here reopens BL-13 — was **§10 Q8**, now **RESOLVED 2026-05-31 (Blocker A → STRUCTURAL)**: the `LlmOracle` is experimental and the `HeuristicOracle` ships as primary, so the per-call cold spawn is moot (there is no winning verdict worth keeping warm). See `docs/ORACLE_WARMTH_DECISION.md` §10.

### 18.5 `hayven doctor` hardware detection
- Replaces the current stub. Reports: platform/arch, RAM, cores, GPU backend (macOS arm → Metal; `nvidia-smi` present → CUDA; else CPU), the recommended tier + model, and each configured model's presence (`.hayven/models/`) + a reachability/load check.

### 18.6 Build / distribution
- candle rides the existing `release.yml` `cargo`/`cross` matrix unchanged (pure Rust). Expect a binary-size increase (candle + backends); the weights-separate story (§18.3) keeps the install download within §16(1).
- CI builds the CPU backend for all 5 platforms; Metal on macOS runners; CUDA is an optional feature gate, excluded from the default release tarballs.
- **Per-target accelerator policy.** Release tarballs for the **Apple targets** (`darwin-arm64` / `darwin-x64`) ship **Metal-accelerated** candle (`release.yml` passes `--features metal` on those targets; `native/Cargo.toml` keeps `metal`/`cuda` OFF by default). **Linux / Windows** ship the **CPU** backend. **CUDA** is an **opt-in local build** (`--features cuda`), never in a default tarball.
- **Cold-load latency on reference hardware is currently UNMEASURED** — and it gates **§10 Q8**. The §18.4 oracle cold-spawns the model per call against a 2 s timeout; whether that fires within budget on the $599 M4 (CPU vs Metal) is the open measurement. See `docs/ORACLE_WARMTH_DECISION.md` and `bench/infer-latency.ts`.

---

## Changelog of this document

| Date       | Section(s) changed                                           | Reason                          |
|------------|---------------------------------------------------------------|---------------------------------|
| 2026-05-15 | Initial version — sections 1–10                              | Shipped alongside v0.0.1        |
| 2026-05-16 | §5 (storage), §10 (Q1/Q2/Q3 resolved), new §11, §12, §13     | Week 5 CRDT layer locked        |
| 2026-05-16 | §10 (Q5 resolved), new §14, §15, §16                         | Week 6 persistence + sync + watcher locked |
| 2026-05-19 | §11.1 (writer-id DR), §11.2 (HLC overflow), §12.1 (LWW tiebreak), §13.3 (decoder hardening), §14.1 (HLC-day bucketing), §15.1 (op-set leaves + domain tags), §16.2/§16.3/§16.4 (overflow detection, reconcile, skew enforcement) | Week 6 review hardening pass — fixes for 4 CRITICAL + several HIGH findings from the independent code review |
| 2026-05-29 | §14.4 (hydrate torn-write wording) | BL-5 — corrected the locked wording to match shipped behavior: a torn segment is truncated to its last good batch and hydration *continues* to later-day segments (rather than stopping), so a torn older segment can't hide newer good days. Doc-only; code was already correct (`daemon/src/crdt/oplog.ts::hydrate`). |
| 2026-05-29 | §15.1 (leaf-cache invalidation) | BL-6 — removed the over-promise of an explicit cache-invalidation hook (none exists, none needed). The leaf-cache key now carries a content discriminator alongside mtime/size (per BL-3), so any segment mutation — including torn-write truncation — recomputes the leaf without a separate invalidation call. Doc-only spec reconciliation. |
| 2026-05-29 | §13.3 (varint length cap) | BL-7 — documented the agreed length/count varint cap: every length/count varint in the §13 wire format MUST fit u32 range (≤ 2^32 − 1); both the TS and Rust readers reject out-of-range values with a clean error. Generic non-length varints unaffected. New spec text aligning the two readers. |
| 2026-05-29 | §10 (Q7 resolved), new §17 | Week 7 conflict-defense contracts locked before code. Q7 resolved: defer the model strata, ship Layers A+B (meet §16(4) <3%) plus Layer C's pluggable `ClaimConflictOracle` seam with a deterministic `HeuristicOracle` default; the Tier-3 LLM (PRD §7.3/§8) drops in behind the same interface later. §17 locks Layer A adjacency detection, Layer B pre-merge verify gate, the Layer C oracle interface, and the conflict-rate harness. |
| 2026-05-29 | §18.3 (BL-14 resolved) | The tokenizer is now built from the GGUF's embedded `tokenizer.ggml.*` metadata in `hayven-native` (`infer/gguf_tokenizer.rs`) — no sidecar download. A model is usable with only `model.gguf`; `tokenizer.json` is an optional byte-exact override; `isModelPresent` keys on the declared artifacts (the gguf) so a plain `models pull` activates the oracle. Fidelity caveat for Gemma-4 E-series (NFKC/newline) tracked as BL-18. |
| 2026-05-29 | §18.2/§18.3 (reconciled to shipped code) | Week 8 model-strata implementation reconciliation. Per-model **directory** layout `.hayven/models/<dirname>/` (not a flat `<id>.gguf`); registry is an `artifacts[]` list with real Gemma GGUF coordinates + published HF sha256 (ids `gemma4:*` aliased onto `bartowski/*` builds). candle loads the tokenizer from a **sidecar `tokenizer.json`**, not the GGUF — so the model dir holds `model.gguf` + `tokenizer.json` and `isModelPresent` requires both; the tokenizer source for an automated pull is the open BL-14 (preferred fix: build it from GGUF metadata). `hayven-native infer --model` takes the **directory**. **[superseded by the BL-14 row above: the tokenizer is now built from GGUF metadata, the sidecar `tokenizer.json` is optional, and `isModelPresent` keys on the gguf alone.]** |
| 2026-05-29 | new §18 (model strata) | Week 8 model-strata contract locked before code. **Engine: candle (pure Rust), not llama.cpp FFI** — same single-binary/fully-local property, builds on the existing cargo/cross 5-platform matrix with no C++/clang, swappable behind the §17.3 oracle seam. §18 locks the engine + `hayven-native infer` transport, the hardware→model registry, model lifecycle (`.hayven/models/`, sha256, graceful heuristic fallback when absent), the `LlmOracle` (retires the BL-13 precision gap), `hayven doctor` hardware detection, and the build/distribution story. |
| 2026-05-29 | §17.1/§17.2/§17.3 (reconciled to shipped code); native parse path (syntax-error detection) | Week 7 implementation reconciliation. §17.1: module prefix is the entity id minus its final `/`-segment (real `idScheme` separator), adjacency via `Db.outgoing`/`incoming`. §17.2: gate granularity is the repo-relative file, hooked at the watcher re-ingest (full-ingest is not gated), with the `merge_rejections` side-table + `nodes.merge_flagged` (schema v2→v3) and the configured-typechecker detection rules. **The native parser now inspects `root_node().has_error()` and emits a syntax `warn`** — tree-sitter is error-recovering, so without this Layer B's syntax phase could not see ordinary syntax errors. §17.3: the `--force` override verdict is local, non-converging metadata (read-cache/DTO, not the OR-Set wire payload). |
| 2026-05-30 | new §10 Q8 [OPEN]; §18.4, §18.6 (current-behavior + distribution notes) | The reference-hardware oracle-warmth contradiction. On the $599 M4 the default cascade (CPU-only candle → per-call cold spawn of `hayven-native infer` → 2 s timeout → silent `HeuristicOracle` fallback) makes the §18.4 `LlmOracle` statistically unlikely to fire and the failure invisible, putting §9 (no long-running servers) in direct contradiction with BL-13 (heuristic over-blocking unacceptable). The §16(4) <3% number is heuristic-derived so *safety* is unaffected; the silent loss is the *precision/UX* upgrade. Marked [OPEN] pending real-M4 cold-load (CPU vs Metal) + LLM-vs-heuristic conservatism measurements; decision doc at `docs/ORACLE_WARMTH_DECISION.md`. §18.6 also documents the per-target accelerator policy (Apple → Metal, Linux/Windows → CPU, CUDA opt-in local). Doc-only; no code change. |
| 2026-05-30 | §4 (source-of-truth rule) [Clarified in 0.0.3] | Made the two-canonical-stores model explicit: `nodes/*.md` **and** `.hayven/crdt/<type>/*.log` are canonical (the op log is the merge-critical convergence state); `index.sqlite` is the only disposable derived layer (`rm index.sqlite && hayven reindex` safe; `rm -rf crdt/` not safe). Documented the hand-edit reconciliation gap: a direct `nodes/*.md` edit mints no LWW op / bumps no HLC, so it doesn't sync and can be silently overwritten — body content is **projection-only**; edits go through `recordLww` / `PUT /api/nodes/:id/body` / `hayven node body`. Doc-only spec clarification. |
| 2026-05-30 | §12.3, §17 (claims-are-advisory) [Clarified in 0.0.3] | Caveat: the OR-Set claim board is designed to CONVERGE, not to provide mutual exclusion. Under partition two agents can both `add` a claim on one entity and both survive merge; a held claim is not a lock. The three-layer conflict defense (§17 — Layer A 409, Layer C oracle) is the actual safety net, reasoning over the converged claim set at registration time. "I claimed it, so I'm safe" is wrong under exactly the partition conditions the CRDT exists for. Doc-only clarification. |
