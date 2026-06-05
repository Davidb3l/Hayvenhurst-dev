/**
 * Build CollectorOptions from `HAYVEN_TRACE_*` environment variables, mirroring
 * the env-var conventions of the python/go collectors.
 *
 * | Env var                 | Default                  |
 * |-------------------------|--------------------------|
 * | `HAYVEN_TRACE_CDP`      | `http://localhost:9222`  |
 * | `HAYVEN_TRACE_URL`      | `http://localhost:7777`  |
 * | `HAYVEN_TRACE_INTERVAL` | `30000` (ms)             |
 * | `HAYVEN_TRACE_DURATION` | `5000`  (ms)             |
 * | `HAYVEN_TRACE_PROJECT`  | (empty) `,`-sep prefixes |
 *
 * NOTE: project prefixes are `,`-separated (not `:`-separated like the
 * python/go path lists) because URL prefixes contain `://`.
 */

import type { CollectorOptions } from "./collector.ts";

export type EnvLike = Record<string, string | undefined>;

export function collectorOptionsFromEnv(env: EnvLike): CollectorOptions {
  const opts: CollectorOptions = {};
  if (env.HAYVEN_TRACE_CDP) opts.cdpUrl = env.HAYVEN_TRACE_CDP;
  if (env.HAYVEN_TRACE_URL) opts.daemonUrl = env.HAYVEN_TRACE_URL;

  const interval = numeric(env.HAYVEN_TRACE_INTERVAL);
  if (interval !== undefined) opts.flushIntervalMs = interval;

  const duration = numeric(env.HAYVEN_TRACE_DURATION);
  if (duration !== undefined) opts.profileMs = duration;

  if (env.HAYVEN_TRACE_PROJECT) {
    opts.urlPrefixes = env.HAYVEN_TRACE_PROJECT.split(",").filter(Boolean);
  }
  return opts;
}

function numeric(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
