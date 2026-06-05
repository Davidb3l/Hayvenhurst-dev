#!/usr/bin/env bun
/**
 * `hayven-trace-browser` — one-shot CLI.
 *
 * Connects to a Chrome started with `--remote-debugging-port=9222`, profiles
 * the active page over the V8 CPU profiler via CDP, derives caller -> callee
 * edges, and flushes them to the Hayvenhurst daemon.
 *
 * Config (flags override env override defaults):
 *   --url <cdp>        / HAYVEN_TRACE_CDP   default http://localhost:9222
 *   --daemon <url>     / HAYVEN_TRACE_URL   default http://localhost:7777
 *   --interval <ms>    / HAYVEN_TRACE_INTERVAL (flush cadence, default 30000)
 *   --duration <ms>    / HAYVEN_TRACE_DURATION (profile window, default 5000)
 *   --project <p,p>    / HAYVEN_TRACE_PROJECT  (`,`-sep url prefixes to scope)
 *
 * If no Chrome target is reachable the command prints a clear message and
 * EXITS 0 (a skip is not a failure — the daemon simply gets no browser data).
 */

import { Collector } from "./collector.ts";
import { collectorOptionsFromEnv } from "./env.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "1";
      }
    }
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(Bun.argv.slice(2));
  const base = collectorOptionsFromEnv(Bun.env);

  if (args.url) base.cdpUrl = args.url;
  if (args.daemon) base.daemonUrl = args.daemon;
  if (args.interval) base.flushIntervalMs = Number(args.interval);
  if (args.duration) base.profileMs = Number(args.duration);
  if (args.project) base.urlPrefixes = args.project.split(",").filter(Boolean);

  const collector = new Collector(base);
  const result = await collector.profileOnce();

  if (result.skipped) {
    // A skip is a clean, expected outcome — exit 0.
    console.error(`hayven-trace-browser: skipped — ${result.reason}`);
    return 0;
  }

  console.error(
    `hayven-trace-browser: profiled ${result.target} → ${result.edges} edges`,
  );
  // Flush the captured batch once and report.
  const sent = await collector.flusher.flushOnce();
  if (collector.flusher.lastError) {
    console.error(
      `hayven-trace-browser: flush failed (daemon unreachable?): ${collector.flusher.lastError}`,
    );
  } else {
    console.error(`hayven-trace-browser: flushed ${sent} observations`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`hayven-trace-browser: unexpected error: ${err}`);
    process.exit(1);
  },
);
