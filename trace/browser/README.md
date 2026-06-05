# @hayvenhurst/trace-browser

Browser runtime trace collector for the Hayvenhurst code-intelligence daemon.

Drives the **V8 CPU profiler over the Chrome DevTools Protocol (CDP)**, captures
**call-graph structure only** (never argument values or return values),
aggregates in-process, and flushes batches to the daemon. This is the
browser-side sibling of `trace/python/` and `trace/go/` and mirrors their
architecture: a **collector** (drives CDP + decodes the CPU profile), an
**aggregator** (in-memory edge counts, atomic drain/reset), and a **flusher**
(background interval, builds the wire payload, injectable transport, graceful
no-op on error).

It is a small TS tool run under **Bun** (or Node) — it connects to a separate
Chrome process; it does not run *inside* the page.

## Install

```sh
bun add @hayvenhurst/trace-browser
```

Zero runtime dependencies — Bun built-ins only (`WebSocket`, `fetch`). No
third-party CDP client; we speak CDP directly over the websocket.

## Launch Chrome with remote debugging

The collector connects to a Chrome started with the DevTools endpoint open:

```sh
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/hayven-chrome

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/hayven-chrome
```

Then load the app you want to profile in that Chrome. Targets are discoverable
at `http://localhost:9222/json`.

## Use

### CLI (one-shot capture)

```sh
bunx hayven-trace-browser --duration 5000 --project https://myapp.local/
```

Connects, profiles the active page for `--duration` ms, decodes the CPU profile
into caller→callee edges, and flushes them to the daemon. **If no Chrome target
is reachable it prints a clear message and exits 0** — a skip is not a failure.

### Programmatic

```ts
import { Collector } from "@hayvenhurst/trace-browser";

const c = new Collector({
  cdpUrl: "http://localhost:9222",        // Chrome --remote-debugging-port
  daemonUrl: "http://localhost:7777",
  profileMs: 5000,                        // how long to profile per capture
  urlPrefixes: ["https://myapp.local/"],  // scope to project frames
});

const result = await c.profileOnce();     // skips cleanly if no Chrome
if (!result.skipped) {
  await c.flusher.flushOnce();            // POST the captured batch
}

// Or run the flusher on an interval and capture repeatedly:
c.start();                                 // background flusher
// ... loop: await c.profileOnce() ...
await c.stop();                            // final flush
```

### Environment variables

Flags override env override defaults.

| Env var                 | Default                  | Notes |
|-------------------------|--------------------------|-------|
| `HAYVEN_TRACE_CDP`      | `http://localhost:9222`  | Chrome CDP discovery endpoint. |
| `HAYVEN_TRACE_URL`      | `http://localhost:7777`  | Daemon base URL. |
| `HAYVEN_TRACE_INTERVAL` | `30000`                  | Flush cadence, **milliseconds**. |
| `HAYVEN_TRACE_DURATION` | `5000`                   | Profile window per capture, **milliseconds**. |
| `HAYVEN_TRACE_PROJECT`  | (empty)                  | `,`-separated URL prefixes to scope which frames are kept. (Comma, not `:`, because URLs contain `://`.) |

## Wire format

The flusher POSTs to `${daemon_url}/api/traces/observations` with
`Content-Type: application/json`:

```json
{
  "source": "browser",
  "sample_rate": 1,
  "observations": [
    { "src": "auth:login", "dst": "db:getUser", "ts": 1715789600, "observed": 5, "weight": 5, "kind": "call" }
  ]
}
```

The daemon (`daemon/src/daemon/routes/traces.ts`) enforces, and **rejects the
batch with HTTP 400** on violation:

- `source` non-empty (`"browser"`); `sample_rate` a **positive integer** at the
  **envelope** level.
- each observation: `src`/`dst` non-empty; `ts` finite (Unix **seconds**);
  `observed` a **non-negative integer** (the RAW sampled count); `weight =
  observed * sample_rate`, re-derived by the daemon and rejected if off by more
  than ±1. We carry **both** — no hidden scaling.
- `observed` and `weight` must each be ≤ 65535 (uint16). The flusher **clamps**
  to that ceiling, preserving the invariant.
- `kind` is `"call"` for parity.

If the daemon is unreachable the flush **no-ops gracefully** — no throw, no error
propagated into your code (the error is recorded on `Flusher.lastError` and the
next interval retries with fresh data).

## Capture model: the CDP V8 CPU profiler

The collector connects to a Chrome instance over the DevTools Protocol
(websocket) and drives the `Profiler` domain:

1. **Discover** inspectable targets at `http://<host>:9222/json`, pick a page
   target, and open a websocket to its `webSocketDebuggerUrl`.
2. `Profiler.enable` → `Profiler.start` → observe the page for a window →
   `Profiler.stop`, which returns a **CPU profile**.
3. The CPU profile is a **call tree**: a flat list of nodes
   `{ id, callFrame: { functionName, url, lineNumber }, hitCount, children: [ids] }`.
   We reconstruct the parent→child tree from each node's `children`.
4. **Every parent→child link is a caller→callee edge.** We aggregate by
   `(caller, callee)`.

CDP is plain JSON-RPC over the websocket — requests are `{ id, method, params }`,
responses `{ id, result }` — so we speak it directly with Bun's `WebSocket`; no
third-party CDP library.

### Honest sample mapping (mirrors trace/go)

The CPU profiler is a **sampling** profiler: `hitCount` is the number of CPU
ticks the sampler caught in a frame, not a clean 1-in-N invocation count, while
the daemon requires `weight == observed * sample_rate (±1)`. The honest mapping
this collector uses, identical in spirit to `trace/go`'s pprof choice:

> **`sample_rate = 1`** and, for each caller→callee edge, **`observed = weight =
> the inclusive (callee-subtree) hit count`** — how many CPU samples landed
> anywhere inside that callee while it was invoked from that caller.

We treat the sampled hit counts as ground-truth `observed` with **no
extrapolation**, so the daemon's `weight == observed * sample_rate` invariant
holds trivially (`weight = observed * 1`). This is a **deliberate honesty
choice, not a limitation to "fix."** Inventing a `sample_rate > 1` over CPU-
profile samples would multiply sampled counts into invocation estimates the
data does not support. (We also deliberately do not weight edges by the
`samples`/`timeDeltas` wall-time arrays — that would turn a sampled count into a
duration estimate the daemon's integer-count contract does not model.)

Edges whose callee subtree was never sampled (inclusive count 0) are dropped,
and counts are clamped to uint16 (65535) — the daemon ceiling.

## Entity-id resolution

**What this collector emits.** `src`/`dst` are runtime names in the form
`<module>:<functionName>` derived from the CDP `callFrame`:

- `<module>` is the **basename of the frame's script `url`**, with query/hash
  and a single file extension stripped — e.g. `https://app/src/auth.js?v=2` →
  `auth`.
- `<functionName>` is V8's `callFrame.functionName` — e.g. `login`, or
  `User.get` when V8 reports a method on a class — so the **trailing** segment
  is the function's bare name (and, when present, the `Type.method` qualified
  name).
- Anonymous frames become `<module>:(anonymous):<line>` so distinct closures in
  one module don't collapse; these stay as orphan observations (no named entity
  to join).

Synthetic V8 frames (`(root)`, `(program)`, `(idle)`, `(garbage collector)`),
`chrome-extension://`, `chrome://`, `devtools://`, `node:` and url-less builtin
frames are dropped. When a kept callee's caller frame is itself filtered out,
the collector **climbs to the nearest kept ancestor**, so an edge connects the
two nearest project frames (parity with the python/go collectors, which skip
runtime frames sitting between project frames).

**How the daemon resolves them.** The daemon maps each runtime name to an
indexed graph-entity id (`<scope>/<module>/<qualified_name>`) **conservatively**:
it normalizes separators (`::`, `.`, `:`, `/`; strips Go `(*Type)` receivers and
Rust `<...>` generics), then matches the **trailing** segment(s) against the
node index — the 2-segment `Type.method` qualified name first, then the bare
final `name` — and accepts **only unambiguous matches**. If the trailing name is
missing from the index or matches more than one entity, the raw runtime name is
kept as an **orphan observation** (no data loss; it just isn't joined to a node).

**Practical consequence.** Emitting names whose trailing segment(s) are the
entity's qualified name maximizes resolution. The `<module>:<functionName>`
shape this collector emits already lands the trailing `Type.method` / `name` the
daemon looks for.

## Privacy

Per PRD §9.4: traces contain only the **structure** of execution — caller→callee
edges. The CPU profile carries only function names, script URLs, and line
numbers; it never carries argument or return values. The wire fields are fixed:
`src`, `dst`, `ts`, `observed`, `weight`, `kind`.

## File layout

| File                  | Responsibility |
|-----------------------|----------------|
| `index.ts`            | Public API surface + `VERSION`. |
| `src/aggregator.ts`   | `Aggregator`: `(src,dst,kind)` counts, atomic `drain` reset. |
| `src/flusher.ts`      | `Flusher`: background interval, JSON encode, injectable `Sender`, graceful no-op, uint16 clamp. |
| `src/profile-tree.ts` | CDP CPU-profile → edges decoder + the frame-id/keep convention (the load-bearing pure core). |
| `src/cdp.ts`          | Minimal CDP client over `WebSocket`; target discovery via `fetch`; injectable connection seam. |
| `src/collector.ts`    | `Collector`: drives `Profiler.*`, decodes, aggregates; injectable/skippable CDP seams. |
| `src/env.ts`          | `CollectorOptions` from `HAYVEN_TRACE_*`. |
| `src/cli.ts`          | `hayven-trace-browser` one-shot CLI; clean skip + exit 0 when no Chrome. |

## Test

```sh
cd trace/browser
bun test          # aggregator, flusher encoding, CDP-profile→edges, collector, env
bunx tsc --noEmit # type check
```

Tests use an **injected mock `Sender`** (no live daemon) and an **injected mock
CDP connection** (no live Chrome). The load-bearing test feeds a **synthetic
`Profiler.stop` profile** through the decoder and asserts the exact
caller→callee pairs and inclusive counts — because live Chrome is probabilistic
and may be unavailable in CI. The live-Chrome path **skips cleanly** (exit 0,
clear message) when no browser is reachable.
