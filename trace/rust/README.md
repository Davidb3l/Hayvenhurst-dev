# hayven-trace (Rust)

Rust runtime trace collector for the Hayvenhurst code-intelligence daemon.

Hooks the [`tracing`](https://docs.rs/tracing) crate, captures **call-graph
structure only** (never argument values or return values), aggregates
in-process, and flushes batches to the daemon every 30 seconds.

This is the Rust analogue of the [`hayven_trace` Python package](../python/README.md);
it mirrors that collector's three-part architecture:

| Module           | Role |
|------------------|------|
| `aggregator.rs`  | In-memory counts keyed by `(src, dst, kind)`; atomic `drain()` resets state. |
| `flusher.rs`     | Background thread; builds the wire payload, posts via an **injectable** transport, no-ops gracefully on error. |
| `layer.rs`       | A `tracing_subscriber::Layer` that derives caller→callee **edges** from the span stack. |
| `lib.rs`         | `TraceConfig`, env parsing, and the `start()/stop()` programmatic surface. |

## Install

```toml
# Cargo.toml
[dependencies]
hayven-trace = { path = "trace/rust" }   # or a version once published
tracing = "0.1"
tracing-subscriber = "0.3"
```

The only runtime dependencies are `tracing` + `tracing-subscriber` (the
integration point itself). JSON serialization and the HTTP POST are
hand-rolled — see [Dependencies](#dependencies).

## Use

### `tracing` Layer (recommended)

In Rust there is no global "every function call" hook like Python's
`sys.settrace`. The idiomatic equivalent is the **span tree**: annotate the
functions you care about with `#[tracing::instrument]` (or open spans
manually), compose `TraceLayer` into your subscriber, and **entering** a span
records an edge from the parent span (caller) to the entering span (callee).

```rust
use std::sync::Arc;
use std::time::Duration;
use tracing_subscriber::prelude::*;
use hayven_trace::{Aggregator, Flusher, HttpSender, TraceLayer};

let agg = Arc::new(Aggregator::new());
let layer = TraceLayer::new(Arc::clone(&agg), 100 /* sample 1-in-N */, vec![]);
tracing_subscriber::registry().with(layer).init();

let mut flusher = Flusher::new(
    agg,
    "http://localhost:7777",
    Duration::from_secs(30),
    100,
    "rust",
    Arc::new(HttpSender::new(Duration::from_secs(2))),
);
flusher.start();

// ... your instrumented code runs ...
#[tracing::instrument]
fn login() { get_user(); }
#[tracing::instrument]
fn get_user() {}

flusher.stop(true); // flush the final batch on shutdown
```

### Coverage: instrumentation **is** trace coverage

The `tracing_subscriber::Layer` captures **only instrumented spans** —
functions annotated with `#[tracing::instrument]` (or wrapped in a manual
`span!`). There is **no `sys.settrace` equivalent** in Rust: an uninstrumented
call is invisible to the layer **by design**, not as a defect. This is the
idiomatic Rust ceiling, and `#[tracing::instrument]` is the (already-existing,
no-custom-macro) mitigation — annotate the functions you want in the graph:

```rust
#[tracing::instrument]
fn login(user: &str) {
    get_user(user); // edge login -> get_user is recorded
}

#[tracing::instrument]
fn get_user(user: &str) { /* ... */ }
```

State it plainly: **instrumentation coverage = trace coverage.** A function you
don't instrument simply won't appear as a `src` or `dst`. Widen coverage by
annotating more functions (or opening manual spans); there is nothing to "fix"
here — it is how `tracing` works.

### Programmatic `start()` / `stop()`

The convenience path reads config from the environment, installs the layer as
the scoped-default subscriber, and starts the flusher. Hold the returned
`TraceGuard` for the program's lifetime; dropping it flushes the final batch.

```rust
let guard = hayven_trace::start(hayven_trace::TraceConfig::from_env());
// ... app runs ...
drop(guard); // or guard.stop();
```

`start()` honors the `HAYVEN_TRACE=1` opt-in — if it isn't set, it installs
nothing and returns a no-op guard, so the call is free to leave in production
code. Use `hayven_trace::install(cfg)` to force-enable regardless of the env
switch.

### Environment variables

Mirrors the Python collector's table:

| Env var                 | Default                  | Notes |
|-------------------------|--------------------------|-------|
| `HAYVEN_TRACE`          | unset                    | Set to `1` to enable (consulted by `start()`). |
| `HAYVEN_TRACE_URL`      | `http://localhost:7777`  | Daemon base URL. |
| `HAYVEN_TRACE_RATE`     | `100`                    | Sample rate, 1-in-N. |
| `HAYVEN_TRACE_INTERVAL` | `30`                     | Flush cadence in seconds. |
| `HAYVEN_TRACE_PROJECT`  | (empty)                  | `:`-separated `target`/module prefixes to scope what's recorded. |

## Wire format

The flusher POSTs to `${daemon_url}/api/traces/observations`
(`Content-Type: application/json`):

```json
{
  "source": "rust",
  "sample_rate": 100,
  "observations": [
    { "src": "myapp::auth::login", "dst": "myapp::db::get_user", "ts": 1715789520, "observed": 5, "weight": 500, "kind": "call" }
  ]
}
```

- `sample_rate` is a **positive integer at the envelope level** (not
  per-observation).
- Each observation carries **both** the raw sampled count `observed` and the
  scaled estimate `weight = observed * sample_rate`. The daemon recomputes and
  **rejects (HTTP 400)** if `weight` is off by more than ±1 — so there is no
  hidden scaling; we send both the ground truth and the convenience value
  (PRD §4.6).
- `ts` is **Unix seconds**.
- `kind` is `"call"` (the daemon ignores it; sent for parity with Python).
- The daemon caps `observed` and `weight` at uint16 (65535) per observation;
  edges are unlikely to hit that within a 30 s window at 1% sampling, but very
  hot edges could — a future revision can split such batches.

If the daemon is **unreachable**, the flush no-ops gracefully (logs at
`trace!`); aggregated data simply isn't delivered until the daemon returns. It
never panics or propagates into your code.

## Entity-id resolution

**What this collector emits.** `src`/`dst` are emitted as **`"<target>::<name>"`**,
read from the `tracing` span metadata:

- `<target>` is the `tracing` *target* — by default the module path of the
  span's call site, e.g. `myapp::auth`.
- `<name>` is the span name — the function name when using
  `#[tracing::instrument]`.

So `login()` in module `myapp::auth` becomes `myapp::auth::login`. A span with
no parent (an entry point) records its caller as the sentinel `<entry>`.

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
entity's qualified name maximizes resolution. The native `::` path the
`tracing` span yields already ends in the function (and, where instrumented on a
method, `Type::method`) the daemon looks for.

## Dependencies

Honoring PRD §2.4 ("original where it matters" — the Python collector is
zero-runtime-deps):

- **`tracing` + `tracing-subscriber`** are the only runtime deps. They *are*
  the integration point, so they're not optional.
- **HTTP:** the default `HttpSender` is a hand-rolled minimal HTTP/1.1 `POST`
  over `std::net::TcpStream` (bounded connect/read/write timeouts). The daemon
  is on localhost and the payload is a small fixed JSON shape, so a full
  async/TLS HTTP client would be unjustified weight. The transport is an
  **injectable trait** (`Sender`) — supply your own (e.g. a TLS client for a
  remote daemon) without changing the rest of the crate.
- **JSON:** hand-rolled in `encode_payload` (with correct string escaping).
  The payload is a tiny fixed shape; pulling `serde`/`serde_json` onto the
  runtime path isn't worth it. (`serde_json` is a **dev-dependency only** — the
  tests use it to parse our output back and prove a round-trip.)

## Privacy

Per PRD §9.4: traces never include argument values or return values. The layer
reads only span **metadata** (`target`, `name`) — never field values — so
runtime data cannot leak. The wire schema fields are fixed: `src`, `dst`,
`ts`, `observed`, `weight`, `kind`.

## Overhead

At the default sample rate of 1-in-100, the hot path (`on_enter`) does one
relaxed atomic increment + a modulo on the unsampled path; only every Nth
enter touches the aggregator (one lock + hash insert). Entity-id strings are
resolved once per span at `on_new_span` and cached in the span's registry
extension, so repeated enters don't re-derive them. Note that `tracing`'s own
span machinery is the dominant cost; sampling keeps the collector's added work
to roughly the same ≈1% envelope as the Python collector.

## Test

```sh
cd trace/rust
cargo test                                  # 20 unit + 2 doc tests
cargo clippy --all-targets -- -D warnings   # clean
```

Tests use an **injected mock `Sender`** (no live daemon): they assert the
aggregator counts and drains atomically, that the encoder emits
`weight == observed * sample_rate` with the exact envelope shape and
`source = "rust"`, and that the emitted JSON parses back to the expected
fields (round-trip).
