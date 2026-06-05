/**
 * Configuration from `HAYVEN_TRACE_*` environment variables.
 *
 * Mirrors the Python/Go collectors' env surface. Used by {@link startFromEnv}
 * so a process can opt into tracing without code changes.
 */

import { DEFAULT_CONFIG, type TracerConfig } from "./tracer.ts";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Whether `HAYVEN_TRACE` is set to a truthy value. */
export function isEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.HAYVEN_TRACE ?? "").trim().toLowerCase();
  return TRUTHY.has(v);
}

/**
 * Build a {@link TracerConfig} from the environment, layering env over the
 * passed overrides over the defaults.
 *
 * | Env var                  | Default                  |
 * |--------------------------|--------------------------|
 * | `HAYVEN_TRACE`           | unset (set 1 to enable)  |
 * | `HAYVEN_TRACE_URL`       | `http://localhost:7777`  |
 * | `HAYVEN_TRACE_INTERVAL`  | `30` (seconds)           |
 * | `HAYVEN_TRACE_PROJECT`   | (empty; `:`-separated)   |
 * | `HAYVEN_TRACE_RATE`      | `1` (envelope sample_rate)|
 */
export function configFromEnv(
  overrides: Partial<TracerConfig> = {},
  env: Record<string, string | undefined> = process.env,
): TracerConfig {
  const cfg: TracerConfig = { ...DEFAULT_CONFIG, ...overrides };

  const url = env.HAYVEN_TRACE_URL?.trim();
  if (url) cfg.daemonUrl = url;

  const interval = Number(env.HAYVEN_TRACE_INTERVAL);
  if (Number.isFinite(interval) && interval > 0) cfg.flushIntervalSeconds = interval;

  const rate = Number(env.HAYVEN_TRACE_RATE);
  if (Number.isInteger(rate) && rate >= 1) cfg.sampleRate = rate;

  const project = env.HAYVEN_TRACE_PROJECT?.trim();
  if (project) {
    cfg.projectPaths = project
      .split(":")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  return cfg;
}
