/**
 * Browser trace collector: drive the V8 CPU profiler over CDP, decode the
 * resulting CPU profile into caller -> callee edges, aggregate them, and flush
 * batches to the daemon.
 *
 * Capture model (shared with the bun collector):
 *   1. Discover targets at `http://<host>:9222/json`.
 *   2. Open a CDP websocket to the chosen target's `webSocketDebuggerUrl`.
 *   3. `Profiler.enable` -> `Profiler.start` -> observe the page for a window
 *      -> `Profiler.stop`, which returns a CPU profile (a call tree).
 *   4. Decode the call tree into edges (see profile-tree.ts) and aggregate.
 *   5. The Flusher POSTs batches on its interval.
 *
 * The CDP connection is INJECTABLE/SKIPPABLE: `CollectorOptions.connect` and
 * `.discover` default to the live implementations but tests pass mocks so no
 * live Chrome is needed; and `profileOnce` SKIPS cleanly (returns a
 * `{ skipped: true }` result) when no browser target is reachable.
 */

import { Aggregator } from "./aggregator.ts";
import { Flusher, type Sender } from "./flusher.ts";
import {
  connectCdp,
  discoverTargets,
  pickTarget,
  type CdpConnection,
  type CdpTarget,
} from "./cdp.ts";
import { edgesFromProfile, type CpuProfile } from "./profile-tree.ts";

export interface CollectorOptions {
  /** CDP discovery endpoint base. Default `http://localhost:9222`. */
  cdpUrl?: string;
  /** Daemon base URL. Default `http://localhost:7777`. */
  daemonUrl?: string;
  /** Flush cadence in ms. Default 30_000. */
  flushIntervalMs?: number;
  /** How long to profile the page per capture, in ms. Default 5_000. */
  profileMs?: number;
  /**
   * Keep only frames whose script `url` starts with one of these prefixes.
   * Empty = keep page code, drop chrome-extension/chrome/devtools/node internals.
   */
  urlPrefixes?: string[];
  /** Batch source tag. Default "browser". */
  source?: string;
  /** Injected transport for the flusher (test seam). */
  sender?: Sender;
  /** Injected target discovery (test seam). Default `discoverTargets`. */
  discover?: (base: string) => Promise<CdpTarget[]>;
  /** Injected CDP connect (test seam). Default `connectCdp`. */
  connect?: (wsUrl: string) => Promise<CdpConnection>;
}

/** Result of a single `profileOnce` capture. */
export type ProfileResult =
  | { skipped: true; reason: string }
  | { skipped: false; target: string; edges: number };

export class Collector {
  readonly aggregator: Aggregator;
  readonly flusher: Flusher;

  private readonly cdpUrl: string;
  private readonly profileMs: number;
  private readonly urlPrefixes: string[];
  private readonly discover: (base: string) => Promise<CdpTarget[]>;
  private readonly connect: (wsUrl: string) => Promise<CdpConnection>;

  constructor(opts: CollectorOptions = {}) {
    this.cdpUrl = opts.cdpUrl ?? "http://localhost:9222";
    this.profileMs = opts.profileMs && opts.profileMs > 0 ? opts.profileMs : 5_000;
    this.urlPrefixes = opts.urlPrefixes ?? [];
    this.discover = opts.discover ?? discoverTargets;
    this.connect = opts.connect ?? connectCdp;

    this.aggregator = new Aggregator();
    this.flusher = new Flusher(this.aggregator, {
      daemonUrl: opts.daemonUrl ?? "http://localhost:7777",
      intervalMs: opts.flushIntervalMs,
      // Honest mapping: sample_rate fixed at 1 (observed == weight).
      sampleRate: 1,
      source: opts.source ?? "browser",
      sender: opts.sender,
    });
  }

  /** Start the background flusher. */
  start(): void {
    this.flusher.start();
  }

  /** Stop the flusher (final flush by default). */
  async stop(flush = true): Promise<void> {
    await this.flusher.stop(flush);
  }

  /**
   * Run one capture: discover a target, profile it for `profileMs`, decode the
   * profile into edges, and aggregate them. Does NOT flush (the flusher does).
   *
   * SKIPS cleanly when no browser target is reachable — returns
   * `{ skipped: true, reason }` instead of throwing, so a CLI can exit 0.
   */
  async profileOnce(): Promise<ProfileResult> {
    const targets = await this.discover(this.cdpUrl);
    const target = pickTarget(targets);
    if (!target || !target.webSocketDebuggerUrl) {
      return {
        skipped: true,
        reason: `no inspectable Chrome target at ${this.cdpUrl} (start Chrome with --remote-debugging-port=9222)`,
      };
    }

    let conn: CdpConnection;
    try {
      conn = await this.connect(target.webSocketDebuggerUrl);
    } catch (e) {
      return {
        skipped: true,
        reason: `could not open CDP websocket: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    try {
      const profile = await this.captureProfile(conn);
      const edges = edgesFromProfile(profile, this.urlPrefixes);
      for (const e of edges) this.aggregator.add(e.src, e.dst, e.count);
      return { skipped: false, target: target.url ?? target.id, edges: edges.length };
    } finally {
      conn.close();
    }
  }

  /**
   * Enable + start the V8 profiler, observe for `profileMs`, stop, and return
   * the CPU profile. Factored out so the wiring is testable with a mock conn.
   */
  async captureProfile(conn: CdpConnection): Promise<CpuProfile> {
    await conn.send("Profiler.enable");
    await conn.send("Profiler.start");
    await delay(this.profileMs);
    const result = await conn.send<{ profile: CpuProfile }>("Profiler.stop");
    return result.profile;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
