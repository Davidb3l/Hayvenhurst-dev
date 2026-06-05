/**
 * Hayven runtime trace collector for Bun / Node (TypeScript / JavaScript).
 *
 * Public surface:
 *
 * ```ts
 * import * as hayvenTrace from "@hayvenhurst/trace-bun";
 *
 * await hayvenTrace.start({ daemonUrl: "http://localhost:7777" });
 * // ... your code runs; the V8 CPU profiler samples the call tree ...
 * await hayvenTrace.stop(); // stops the profiler + flusher, flushes a final batch
 * ```
 *
 * Or from the environment (no-op unless `HAYVEN_TRACE` is truthy):
 *
 * ```ts
 * await hayvenTrace.startFromEnv();
 * ```
 *
 * Design notes (PRD §9, mirrors trace/python + trace/go):
 *
 *  - Captures via the in-process **V8 CPU profiler** (`node:inspector`
 *    `Session` -> `Profiler.start`/`stop`), which returns a CALL TREE. Every
 *    parent->child link is a caller->callee edge; an edge's `observed` is the
 *    summed sample count of the callee's subtree.
 *  - Honest mapping (like trace/go's pprof path): `sample_rate = 1`,
 *    `observed == weight == summed sample count`. No 1-in-N extrapolation.
 *  - Captures only the **structure** of execution — caller -> callee — never
 *    argument or return VALUES (PRD §9.4). The profiler only ever sees frame
 *    names; values are never read.
 *  - Aggregates in-process; flushes to the daemon every 30s; the flush no-ops
 *    gracefully if the daemon is unreachable.
 */

import { HayvenTracer, DEFAULT_CONFIG, type TracerConfig } from "./src/tracer.ts";
import { configFromEnv, isEnabled } from "./src/env.ts";

export { Aggregator } from "./src/aggregator.ts";
export type { Observation, CallKey } from "./src/aggregator.ts";
export { Flusher, encodePayload } from "./src/flusher.ts";
export type { Sender, WirePayload, WireObservation, FlusherOptions } from "./src/flusher.ts";
export { deriveEdges, UINT16_MAX } from "./src/profile.ts";
export type { CpuProfile, ProfileNode, CallFrame, DerivedEdge, NameResolver } from "./src/profile.ts";
export { makeResolver, urlToPath, moduleOf } from "./src/names.ts";
export type { ScopeOptions } from "./src/names.ts";
export { HayvenTracer, DEFAULT_CONFIG } from "./src/tracer.ts";
export type { TracerConfig } from "./src/tracer.ts";
export { configFromEnv, isEnabled } from "./src/env.ts";

export const VERSION = "0.0.4";

/** Public `start` options. All optional except none — every field has a default. */
export interface StartOptions {
  daemonUrl?: string;
  /** Envelope sample_rate. The CPU-profiler model uses 1. */
  sampleRate?: number;
  flushIntervalSeconds?: number;
  /** Path / module-prefix scope (`:`-style array). Drops node_modules/internal otherwise. */
  projectPaths?: string[];
  /** Keep node_modules / node:/bun: frames. Default false. */
  includeInternal?: boolean;
  source?: string;
}

let active: HayvenTracer | null = null;

/** True if a tracer is currently installed in this process. */
export function isActive(): boolean {
  return active !== null;
}

/**
 * Start tracing the current process and return the active tracer.
 *
 * Idempotent: a second call returns the existing tracer. If the runtime's CPU
 * profiler is unavailable the tracer records `lastError` and returns anyway
 * (no throw) — check `tracer.isInstalled` / `tracer.lastError`.
 */
export async function start(opts: StartOptions = {}): Promise<HayvenTracer> {
  if (active) return active;
  const cfg: TracerConfig = {
    ...DEFAULT_CONFIG,
    ...(opts.daemonUrl !== undefined ? { daemonUrl: opts.daemonUrl } : {}),
    ...(opts.sampleRate !== undefined ? { sampleRate: Math.max(1, Math.floor(opts.sampleRate)) } : {}),
    ...(opts.flushIntervalSeconds !== undefined
      ? { flushIntervalSeconds: opts.flushIntervalSeconds }
      : {}),
    ...(opts.projectPaths !== undefined ? { projectPaths: opts.projectPaths } : {}),
    ...(opts.includeInternal !== undefined ? { includeInternal: opts.includeInternal } : {}),
    ...(opts.source !== undefined ? { source: opts.source } : {}),
  };
  const tracer = new HayvenTracer(cfg);
  await tracer.install();
  active = tracer;
  return tracer;
}

/**
 * Start tracing from `HAYVEN_TRACE_*` env vars. Returns `null` (no-op) unless
 * `HAYVEN_TRACE` is truthy. `overrides` win over env, env wins over defaults.
 */
export async function startFromEnv(overrides: StartOptions = {}): Promise<HayvenTracer | null> {
  if (!isEnabled()) return null;
  if (active) return active;
  const partial: Partial<TracerConfig> = {};
  if (overrides.daemonUrl !== undefined) partial.daemonUrl = overrides.daemonUrl;
  if (overrides.sampleRate !== undefined) partial.sampleRate = overrides.sampleRate;
  if (overrides.flushIntervalSeconds !== undefined)
    partial.flushIntervalSeconds = overrides.flushIntervalSeconds;
  if (overrides.projectPaths !== undefined) partial.projectPaths = overrides.projectPaths;
  if (overrides.includeInternal !== undefined) partial.includeInternal = overrides.includeInternal;
  if (overrides.source !== undefined) partial.source = overrides.source;

  const cfg = configFromEnv(partial);
  const tracer = new HayvenTracer(cfg);
  await tracer.install();
  active = tracer;
  return tracer;
}

/** Stop the active tracer (if any), harvest the final window, and flush. */
export async function stop(): Promise<void> {
  const tracer = active;
  active = null;
  if (tracer) await tracer.uninstall();
}
