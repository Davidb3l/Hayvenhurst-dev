# hayven-trace (Bun / Node)

Bun/Node (TypeScript/JavaScript) runtime trace collector for the Hayvenhurst
code-intelligence daemon.

Captures the **V8 CPU-profiler call tree** in-process, derives caller→callee
edges (**call-graph structure only** — never argument or return values),
aggregates in memory, and flushes batches to the daemon every 30 seconds. This
is the Bun/Node sibling of `trace/python/` and `trace/go/`, mirroring their
architecture: a **tracer** (drives the CPU profiler and derives edges), an
**aggregator** (in-memory `(src,dst)` counts, atomic drain/reset), and a
**flusher** (background interval, builds the wire payload, injectable
transport, graceful no-op on error).

It closes a real gap: the Hayvenhurst daemon itself is Bun/TypeScript and had
no trace collector, so its own runtime call graph was invisible to traces. With
this package the daemon (and any Bun/Node program) can be traced — including
tracing **itself** (see [Tracing the daemon itself](#tracing-the-daemon-itself)).

## Install

This package lives in the monorepo at `trace/bun/`. Within the repo it is
zero-dependency (built-ins only: `node:inspector`, `fetch`). From another Bun/Node
project, depend on it by path / workspace and import it:

```ts
import * as hayvenTrace from "@hayvenhurst/trace-bun";
```

No runtime dependencies — Bun/Node built-ins only.

## Use

### Programmatic

```ts
import * as hayvenTrace from "@hayvenhurst/trace-bun";

await hayvenTrace.start({
  daemonUrl: "http://localhost:7777",
  flushIntervalSeconds: 30,
  projectPaths: ["/path/to/my/project/src"], // optional: scope which frames are kept
});

// ... your code runs; the V8 CPU profiler samples the call tree ...

await hayvenTrace.stop(); // stops the profiler + flusher, flushes a final batch
```

`start()` is idempotent (a second call returns the active tracer). If the host
runtime lacks the CPU profiler, `start()` records the failure on
`tracer.lastError` and returns **without throwing** — check `tracer.isInstalled`.

### From the environment

```ts
const tracer = await hayvenTrace.startFromEnv();
// returns null (no-op) unless HAYVEN_TRACE is truthy
```

### Environment variables

| Env var                 | Default                  | Notes |
|-------------------------|--------------------------|-------|
| `HAYVEN_TRACE`          | unset                    | Set to `1` (or `true`/`yes`/`on`) to enable `startFromEnv`. |
| `HAYVEN_TRACE_URL`      | `http://localhost:7777`  | Daemon base URL. |
| `HAYVEN_TRACE_INTERVAL` | `30`                     | Flush + re-profile cadence, seconds. |
| `HAYVEN_TRACE_PROJECT`  | (empty)                  | `:`-separated path / module-id prefixes to scope which frames are kept. Empty drops `node_modules` / `node:` / `bun:` internal frames by default. |
| `HAYVEN_TRACE_RATE`     | `1`                      | Envelope `sample_rate`. **Stays `1` in the CPU-profiler model** (see below); honored only if you wire a true 1-in-N call hook upstream. |

## Capture model — V8 CPU profiler

The collector captures via the **in-process V8 CPU profiler**, driven through
Node's built-in `node:inspector` `Session`:

```
new inspector.Session() → Profiler.enable → Profiler.start … Profiler.stop
```

`Profiler.stop` returns a **call tree** flattened into `nodes[]`, each node:

```
{ id, callFrame: { functionName, scriptId, url, lineNumber, columnNumber },
  hitCount, children: number[] }   // children = child node IDs
```

`hitCount` is the number of CPU samples whose stack **top** was this node. We
walk the tree: **every parent→child link is a caller→callee edge**, and an
edge's count is the **summed hit count of the callee's entire subtree** (the
samples in which control was anywhere inside the callee while the caller was its
parent). Edges are aggregated by `(caller, callee)` — the same pair appearing
under multiple call sites sums.

### Does this work under Bun? — Yes (verified)

Bun is the daemon's runtime, so the critical question was whether Bun's
`node:inspector` exposes the programmatic CPU profiler. **It does** — verified
empirically on **Bun 1.3.13**: a `Session().connect()` + `Profiler.enable` /
`setSamplingInterval` / `start` / `stop` round-trip returns a real V8 call tree
with populated `hitCount`s and `children`. The live smoke test
(`tests/smoke.test.ts`) profiles a sample function under the host runtime and
asserts ≥1 derived edge — it passes under Bun. The collector uses this path
directly; there was **no need to fall back** to a degraded approach. If a future
runtime ever lacks the CPU profiler, `install()` records `lastError` and no-ops
gracefully rather than faking data.

A profile accumulates into one tree until `stop`, so to flush on an interval the
tracer runs **one profile window per flush**: `stop` (collect + derive edges),
then immediately `start` a fresh window. Each window contributes its samples;
the aggregator sums windows. `stop()` harvests a final partial window.

### Honesty note (mirrors trace/go's pprof rationale)

The daemon requires `weight == observed * sample_rate (±1)`. The CPU profiler
yields **weighted, sampled** stacks, not clean 1-in-N call counts. The honest
mapping this collector uses:

> **`sample_rate = 1`**, and **`observed == weight == the summed sample count`**
> of the edge.

We treat the profiler's sample-derived edge counts as ground-truth `observed`
with **no extrapolation**, so the daemon's invariant holds trivially
(`weight = observed * 1`). The V8 sampler's own interval *is* the sampling; we
report the sampled counts honestly. Inventing a `sample_rate > 1` over CPU-profile
stacks would multiply sampled counts into invocation estimates the data does not
support — so we don't. This is a **deliberate honesty choice (PRD §4.6 / §9), not
a limitation to "fix".** Both `observed` and `weight` are clamped to the uint16
ceiling (65535); at `sample_rate = 1` that clamp keeps `observed == weight`.

**Coverage note.** A CPU sampler observes the *executing* call graph: hot paths
and anything on the stack when a sample fires. Rarely-executed or very fast
functions may never be sampled in a given window, so the trace is a sampled view
of *which edges ran*, not an exhaustive static call graph — same shape of
approximation as trace/go's sampler.

## Wire format

The flusher POSTs to `${daemonUrl}/api/traces/observations` with
`Content-Type: application/json`:

```json
{
  "source": "bun",
  "sample_rate": 1,
  "observations": [
    { "src": "auth:Session.login", "dst": "db:getUser", "ts": 1715789600, "observed": 5, "weight": 5, "kind": "call" }
  ]
}
```

The daemon (`daemon/src/daemon/routes/traces.ts`) enforces, and **rejects the
batch with HTTP 400** on violation:

- `source` non-empty (`"bun"`); `sample_rate` a **positive integer** at the
  **envelope** level.
- each observation: `src`/`dst` non-empty; `ts` finite (Unix **seconds**);
  `observed` a **non-negative integer** (the raw summed sample count);
  `weight = observed * sample_rate`, re-derived by the daemon and rejected if
  off by more than ±1. We carry **both** — no hidden scaling.
- `observed` and `weight` must each be ≤ 65535 (uint16). The collector
  **clamps** to that ceiling, preserving the invariant.
- `kind` is `"call"` for parity.

If the daemon is **unreachable** the flush **no-ops gracefully** — no throw into
user code; the error is recorded on `flusher.lastError` and the next interval
retries with fresh data.

This payload shape was confirmed end-to-end against a live daemon (HTTP 200,
`{"ok":true,"accepted":1,"source":"bun","sample_rate":1}`), with a deliberate
weight mismatch correctly rejected (HTTP 400).

## Entity-id resolution

**What this collector emits.** `src`/`dst` are runtime names in the form
`<module>:<functionName>`, derived from each profile node's call frame:

- `<module>` is the source file's basename without extension
  (`auth.ts` → `auth`), decoded from the frame's `url`.
- `<functionName>` is V8's `callFrame.functionName`. V8 already qualifies
  methods as `Class.method` / `obj.method`, so a method shows up as
  `auth:Session.login` and a bare function as `db:getUser`.

This mirrors the Python collector's `<module>:<qualname>` shape.

**How the daemon resolves them.** The daemon maps each runtime name to an
indexed graph-entity id (`<scope>/<module>/<qualified_name>`) **conservatively**:
it normalizes separators (`::`, `.`, `:`, `/`; strips Go `(*Type)` receivers and
Rust `<...>` generics), then matches the **trailing** segment(s) against the
node index — the 2-segment `Type.method` qualified name first, then the bare
final `name` — and accepts **only unambiguous matches**. If the trailing name is
missing or matches more than one entity, the raw runtime name is kept as an
**orphan observation** (no data loss; it just isn't joined to a node).

**Practical consequence.** Putting the function's qualified name in the trailing
position (after the `:` module hint) maximizes resolution: `auth:Session.login`
resolves on the trailing `Session.login` / `login`, and `db:getUser` on
`getUser`. Resolution is best-effort, on parity with the Python/Go collectors.

## Privacy

Per PRD §9.4: traces contain only the **structure** of execution — caller →
callee edges. The CPU profiler only ever exposes frame **names** (function name,
file url, line); the collector never reads argument or return **values**. The
wire fields are fixed: `src`, `dst`, `ts`, `observed`, `weight`, `kind`.

## Tracing the daemon itself

Because the daemon is a Bun/TypeScript process and this collector runs
in-process via `node:inspector`, the daemon can trace its **own** runtime call
graph: call `hayvenTrace.start({ daemonUrl: "http://localhost:7777", projectPaths: ["<repo>/daemon/src"] })`
early in the daemon's startup and `stop()` on shutdown. The collector drops its
own `trace/bun/src/` frames so it never amplifies its own cost, and scoping to
`daemon/src` keeps the trace to the daemon's code. The flush then POSTs the
daemon's caller→callee edges back to the daemon's own ingest endpoint — the
daemon's call graph becomes visible to traces for the first time.

## Scoping & overhead

By default, `node_modules`, `node:` / `bun:` internals, V8 pseudo-frames
(`(root)`, `(program)`, `(idle)`, `(garbage collector)`), anonymous frames, and
the collector's own `src/` frames are dropped, so the trace reflects the user's
own call graph. Supply `projectPaths` (or `HAYVEN_TRACE_PROJECT`) to restrict
further to specific path / module-id prefixes. Overhead is dominated by the V8
sampling interval (default 1 ms); widen it or narrow `projectPaths` to reduce
cost. Edge derivation runs once per flush window, off the hot path.

## File layout

| File                | Responsibility |
|---------------------|----------------|
| `index.ts`          | Public API: `start` / `stop` / `startFromEnv` / `isActive`, re-exports. |
| `src/aggregator.ts` | `Aggregator`: `(src,dst,kind)` counts, atomic `drain()` reset. |
| `src/profile.ts`    | `deriveEdges`: pure V8-CPU-profile-tree → edge derivation (the unit-testable core), `UINT16_MAX`. |
| `src/names.ts`      | `makeResolver`: frame → `<module>:<fn>` id + scoping/filter rules. |
| `src/flusher.ts`    | `Flusher` + `encodePayload`: background interval, JSON wire encode, injectable `Sender`, graceful no-op. |
| `src/tracer.ts`     | `HayvenTracer`: drives the `node:inspector` CPU profiler, per-window harvest, lifecycle. |
| `src/env.ts`        | `configFromEnv` / `isEnabled` from `HAYVEN_TRACE_*`. |

## Test

```sh
cd trace/bun
bun test          # 32 tests
bunx tsc --noEmit # type check
```

Tests use an **injected mock `Sender`** — no live daemon required. Coverage:
- **aggregator** — count, weight summing, atomic drain/reset, kind keying.
- **profile derivation** (`deriveEdges` on a **synthetic, deterministic** V8
  profile) — subtree-summed counts, multi-call-site aggregation, dropped-frame
  splicing, anonymous-frame drop, self-loop rejection, uint16 clamp.
- **names** — entity-id convention, pseudo/anonymous/internal/self frame drops,
  `projectPaths` scoping.
- **flusher payload encoding** — envelope shape, `source: "bun"`,
  `weight == observed * sample_rate`, uint16 clamp invariant, unreachable-daemon
  no-op via the mock sender.
- **smoke** — the **real** V8 CPU profiler under the host runtime: profiles a
  sample function and asserts ≥1 derived edge + a contract-valid payload.
