/**
 * Hayven browser runtime trace collector — public API.
 *
 * Captures call-graph STRUCTURE only (caller -> callee edges; never argument
 * or return values, per PRD §9.4) by driving the V8 CPU profiler over the
 * Chrome DevTools Protocol, decoding the resulting CPU profile (a call tree)
 * into edges, aggregating in-process, and flushing batches to the daemon.
 *
 * Quickstart:
 *
 *   import { Collector } from "@hayvenhurst/trace-browser";
 *
 *   const c = new Collector({
 *     cdpUrl: "http://localhost:9222",       // Chrome --remote-debugging-port=9222
 *     daemonUrl: "http://localhost:7777",
 *     urlPrefixes: ["https://myapp.local/"], // scope to project frames
 *   });
 *   const r = await c.profileOnce();          // skips cleanly if no Chrome
 *   if (!r.skipped) await c.flusher.flushOnce();
 */

export { Aggregator, type Observation } from "./src/aggregator.ts";
export { Flusher, type Sender, type FlusherOptions } from "./src/flusher.ts";
export {
  Collector,
  type CollectorOptions,
  type ProfileResult,
} from "./src/collector.ts";
export {
  edgesFromProfile,
  keepFrame,
  frameId,
  moduleFromUrl,
  type CpuProfile,
  type ProfileNode,
  type CallFrame,
  type ProfileEdge,
} from "./src/profile-tree.ts";
export {
  connectCdp,
  discoverTargets,
  pickTarget,
  type CdpConnection,
  type CdpTarget,
} from "./src/cdp.ts";
export { collectorOptionsFromEnv, type EnvLike } from "./src/env.ts";

export const VERSION = "0.0.5";
