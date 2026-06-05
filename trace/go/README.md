# hayven-trace (Go)

Go runtime trace collector for the Hayvenhurst code-intelligence daemon.

Captures **call-graph structure only** (never argument values or return
values), aggregates in-process, and flushes batches to the daemon every 30
seconds. This is the Go sibling of `trace/python/` and mirrors its
architecture: a **collector** (samples call stacks), an **aggregator**
(in-memory edge counts, atomic drain/reset), and a **flusher** (background
goroutine, periodic, injectable transport, graceful no-op on error).

Module path: `github.com/hayvenhurst/hayven-trace`.

## Install

```sh
go get github.com/hayvenhurst/hayven-trace
```

Zero runtime dependencies — Go stdlib only (`runtime`, `runtime/pprof`,
`net/http`, `encoding/json`, `compress/gzip`, `sync`, `time`, `os`).

## Use

### Programmatic

```go
import hayventrace "github.com/hayvenhurst/hayven-trace"

c := hayventrace.Start(hayventrace.Config{
    DaemonURL:       "http://localhost:7777",
    FlushInterval:   30 * time.Second,
    ProjectPrefixes: []string{"github.com/me/myapp"}, // optional: scope frames
})
defer c.Stop() // stops sampler + flusher, flushes a final batch

// ... your code runs; the background sampler snapshots call stacks ...

c.FlushOnce() // optional manual flush
```

### From the environment

```go
if c := hayventrace.StartFromEnv(); c != nil {
    defer c.Stop()
}
```

`StartFromEnv` is a no-op (returns `nil`) unless `HAYVEN_TRACE` is enabled.

### One-shot CPU profile

To use the literal `runtime/pprof` mechanism instead of the always-on
interval sampler, capture a CPU profile over a region:

```go
c := hayventrace.NewCollector(hayventrace.Config{DaemonURL: "http://localhost:7777"})
n, err := c.CollectCPUProfile(5 * time.Second) // profiles, derives edges, flushes
```

### Environment variables

| Env var                 | Default                 | Notes |
|-------------------------|-------------------------|-------|
| `HAYVEN_TRACE`          | unset                   | Set to `1` (or `true`/`yes`/`on`) to enable. |
| `HAYVEN_TRACE_URL`      | `http://localhost:7777` | Daemon base URL. |
| `HAYVEN_TRACE_RATE`     | `1`                     | Envelope `sample_rate`. **In pprof/sampling mode this stays `1`** (see below); honored only by a future true 1-in-N hook. |
| `HAYVEN_TRACE_INTERVAL` | `30`                    | Flush cadence, seconds. |
| `HAYVEN_TRACE_PROJECT`  | (empty)                 | `:`-separated import-path prefixes to scope which frames are recorded. Empty drops Go runtime/stdlib frames by default. |

## Wire format

The flusher POSTs to `${daemon_url}/api/traces/observations` with
`Content-Type: application/json`:

```json
{
  "source": "go",
  "sample_rate": 1,
  "observations": [
    { "src": "myapp/auth.Login", "dst": "myapp/db.GetUser", "ts": 1715789520, "observed": 5, "weight": 5, "kind": "call" }
  ]
}
```

The daemon (`daemon/src/daemon/routes/traces.ts`) enforces, and **rejects the
batch with HTTP 400** on violation:

- `source` non-empty (`"go"`); `sample_rate` a **positive integer** at the
  **envelope** level.
- each observation: `src`/`dst` non-empty; `ts` finite (Unix **seconds**);
  `observed` a **non-negative integer** (the RAW count); `weight = observed *
  sample_rate`, re-derived by the daemon and rejected if off by more than ±1.
  We carry **both** — no hidden scaling.
- `observed` and `weight` must each be ≤ 65535 (uint16). The flusher **clamps**
  to that ceiling, preserving the invariant.
- `kind` is `"call"` for parity.

If the daemon is unreachable the flush **no-ops gracefully** — no panic, no
error propagated into your code (the error is recorded on
`Flusher.LastError()` and the next interval retries with fresh data).

### pprof sampling vs the `weight = observed * sample_rate` invariant

The v1.1 roadmap specifies `runtime/pprof`. pprof yields **weighted, sampled**
call stacks, not clean 1-in-N call counts, while the daemon requires
`weight == observed * sample_rate (±1)`. The honest mapping this collector
uses:

> **`sample_rate = 1`** and **`observed = weight = the number of pprof/stack
> samples in which an edge appeared`.**

We treat pprof's sample-derived edge counts as ground-truth `observed` with
**no extrapolation**, so the daemon's `weight == observed * sample_rate`
invariant holds trivially (`weight = observed * 1`). We are **not** claiming
1-in-N extrapolation — pprof's own sampling rate (hz) is the sampling, and we
report the sampled counts honestly.

This is a **deliberate honesty choice, not a limitation to "fix."** Inventing a
`sample_rate > 1` over pprof stacks would multiply sampled counts into
invocation estimates the data does not support — so `observed` and `weight` are
reported as the same sampled-edge count. If you wire a true 1-in-N call hook
upstream, set `SampleRate > 1`; the flusher keeps `weight = observed *
sample_rate` exactly either way.

## Entity-id resolution

**What this collector emits.** `src`/`dst` are the symbol names returned by
Go's `runtime.Func.Name()`:

- `<import-path>.<Func>` — e.g. `github.com/me/myapp/auth.Login`
- `<import-path>.(*Type).<Method>` — e.g.
  `github.com/me/myapp/db.(*Store).GetUser`

`ProjectPrefixes` scopes which frames are kept (import-path prefix match);
with no prefixes, Go runtime/stdlib frames are dropped by default (heuristic:
the first import-path segment lacks a `.` — `runtime`, `net/http`, `sync` are
stdlib; `github.com/...` is not). The collector never records its own frames.

**How the daemon resolves them.** The daemon maps each runtime name to an
indexed graph-entity id (`<scope>/<module>/<qualified_name>`) **conservatively**:
it normalizes separators (`::`, `.`, `:`, `/`; strips Go `(*Type)` receivers and
Rust `<...>` generics), then matches the **trailing** segment(s) against the
node index — the 2-segment `Type.method` qualified name first, then the bare
final `name` — and accepts **only unambiguous matches**. If the trailing name
is missing from the index or matches more than one entity, the raw runtime name
is kept as an **orphan observation** (no data loss; it just isn't joined to a
node).

**Practical consequence.** Emitting names whose trailing segment(s) are the
entity's qualified name maximizes resolution. After the daemon strips the
`(*Store)` receiver, `…/db.(*Store).GetUser` resolves on the trailing
`Store.GetUser` / `GetUser` the node index carries.

## Privacy

Per PRD §9.4: traces contain only the **structure** of execution — caller →
callee edges. The collector reads symbol names from stack frames; it never
reads argument or return values. The wire fields are fixed: `src`, `dst`,
`ts`, `observed`, `weight`, `kind`.

## Mechanism & overhead

Two derivation paths, both pure stdlib:

1. **Interval sampler** (default, `Start`): every `SampleInterval` (10 ms
   default) the collector snapshots all live goroutine stacks via
   `runtime.GoroutineProfile`, walks each stack, and emits caller→callee
   edges from adjacent frames into the aggregator.
2. **CPU profile** (`CollectCPUProfile`): captures a `runtime/pprof` CPU
   profile over a region, parses the pprof protobuf (minimal hand-rolled
   stdlib reader in `pprof.go`), and derives edges from each sample's stack.

Overhead is dominated by the snapshot cadence; widen `SampleInterval` or scope
with `ProjectPrefixes` to reduce it. The aggregator hot path is a single map
increment under a coarse mutex.

## Test

```sh
cd trace/go
go build ./...
go vet ./...
go test ./...          # unit + integration
go test -race ./...    # concurrency check
go test -short ./...   # skips the live CPU-profile capture
```

Tests use an **injected mock `Sender`** — no live daemon required. Coverage:
aggregator (count, drain reset, concurrency), flusher payload encoding
(asserts envelope shape, `source="go"`, and `weight == observed *
sample_rate`), the stack→edge derivation on a synthetic stack, and a
deterministic pprof-protobuf parse round-trip.

## File layout

| File             | Responsibility |
|------------------|----------------|
| `doc.go`         | Package doc, `Version`, the pprof→sample_rate=1 rationale. |
| `aggregator.go`  | `Aggregator`: mutex-guarded `(src,dst)` counts, atomic `Drain` reset. |
| `flusher.go`     | `Flusher`: background goroutine, JSON encode, injectable `Sender`, graceful no-op. |
| `collector.go`   | `Collector`: interval stack sampler, frame filtering, edge derivation, lifecycle. |
| `pprof.go`       | `CollectCPUProfile` + a minimal stdlib pprof-protobuf decoder. |
| `env.go`         | `Config`/`Collector` from `HAYVEN_TRACE_*` env vars. |
