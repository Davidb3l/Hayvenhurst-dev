# hayven-trace

Python runtime trace collector for the Hayvenhurst code-intelligence daemon.

Hooks `sys.settrace`, captures **call-graph structure only** (never argument values or return values), aggregates in-process, and flushes batches to the daemon every 30 seconds.

## Install

```sh
pip install hayven-trace
```

Zero runtime dependencies — stdlib only.

## Use

### Programmatic

```python
import hayven_trace

hayven_trace.start(
    daemon_url="http://localhost:7777",
    sample_rate=100,            # 1 in 100 calls observed (~1% overhead)
    flush_interval_seconds=30,
    project_paths=["/path/to/my/project"],   # optional: limit scope
)

# ... your code runs ...

hayven_trace.stop()
```

### Pytest

The package registers a pytest plugin entry-point. Just install it and opt in:

```sh
HAYVEN_TRACE=1 pytest
# or
pytest -p hayven_trace --hayven-trace
```

Environment variables:

| Env var                     | Default                  | Notes |
|-----------------------------|--------------------------|-------|
| `HAYVEN_TRACE`              | unset                    | Set to `1` to enable. |
| `HAYVEN_TRACE_URL`          | `http://localhost:7777`  | Daemon base URL. |
| `HAYVEN_TRACE_RATE`         | `100`                    | Sample rate, 1-in-N. |
| `HAYVEN_TRACE_INTERVAL`     | `30`                     | Flush cadence in seconds. |
| `HAYVEN_TRACE_PROJECT`      | (empty)                  | `:`-separated path prefixes. |
| `HAYVEN_TRACE_INCLUDE_STDLIB` | unset                  | Set to `1` to keep stdlib frames. |

## Wire format

The flusher POSTs to `${daemon_url}/api/traces/observations`:

```json
{
  "source": "python",
  "sample_rate": 100,
  "observations": [
    { "src": "myapp.auth:login", "dst": "myapp.db:get_user", "ts": 1715789520, "observed": 5, "weight": 500, "kind": "call" }
  ]
}
```

- `sample_rate` is a **positive integer at the envelope level** (not
  per-observation).
- Each observation carries **both** the raw sampled count `observed` and the
  scaled estimate `weight = observed * sample_rate`. The daemon
  (`daemon/src/daemon/routes/traces.ts`) recomputes `weight` from `observed`
  and the envelope `sample_rate` and **rejects the batch (HTTP 400)** if it is
  off by more than ±1 — so there is no hidden scaling: `observed` is the raw
  sampled count and `weight` is the scaled estimate, and both are carried on
  the wire (PRD §4.6 / §9).
- `ts` is **Unix seconds**.
- `kind` is `"call"` (sent for parity).
- The daemon caps `observed` and `weight` at uint16 (65535) per observation
  and rejects batches that exceed it.

`src` and `dst` are stable node ids in the form `<module>:<qualname>` — see
[Entity-id resolution](#entity-id-resolution).

## Entity-id resolution

**What this collector emits.** `src`/`dst` are runtime names in the form
`<module>:<qualname>` — e.g. `myapp.auth:login`, `myapp.db:User.get` — derived
from the traced frame's module and qualified name.

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
entity's qualified name maximizes resolution. The `<module>:<qualname>` shape
this collector emits already lands the trailing `Type.method` / `name` the
daemon looks for.

## Privacy

Per PRD §9.4: traces never include argument values or return values by default. The wire schema fields are fixed: `src`, `dst`, `ts`, `observed`, `weight`, `kind`. Argument *types* (no values) can be opted in via `capture_arg_types=True` but the v0.0.1 build records call edges only.

## Overhead

At the default sample rate of 1-in-100, overhead measured against a typical pytest run is **under 2%**. The hot path performs one increment, one modulo, and a single `dict.get`/`__setitem__` per *sampled* event — unsampled events do a path-cache lookup and return.

## Test

```sh
pip install -e ".[dev]"
pytest        # 18 tests
mypy src/hayven_trace
```
