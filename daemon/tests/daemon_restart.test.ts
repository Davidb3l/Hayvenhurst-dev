/**
 * `hayven daemon restart` (HD-6). It was advertised in DAEMON_USAGE and in the
 * relocate hint ("hayven daemon restart") but the dispatcher had no case for it:
 * `unknown daemon subcommand: restart`, exit 2.
 *
 * Driven through the real `runDaemon` dispatcher; only stop/start/the
 * address-quiet probe are injected so no daemon is spawned and no port is bound.
 */
import { describe, expect, it } from "bun:test";

import { runDaemon } from "../src/cli/daemon.ts";

function capture<T>(fn: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: string) => (out.push(String(s)), true);
  (process.stderr as { write: unknown }).write = (s: string) => (err.push(String(s)), true);
  return fn().then(
    (value) => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      return { value, out: out.join(""), err: err.join("") };
    },
    (e) => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      throw e;
    },
  );
}

const ARGS = { positionals: ["restart"], flags: {} };

describe("hayven daemon restart", () => {
  it("is dispatched (no longer 'unknown daemon subcommand') and runs stop -> wait -> start in order", async () => {
    const calls: string[] = [];
    const r = await capture(() =>
      runDaemon(ARGS, {
        restart: {
          stop: async () => (calls.push("stop"), 0),
          addressQuiet: async () => (calls.push("quiet?"), true),
          start: async () => (calls.push("start"), 0),
        },
      }),
    );
    expect(r.value).toBe(0);
    expect(calls).toEqual(["stop", "quiet?", "start"]);
    expect(r.err).not.toContain("unknown daemon subcommand");
  });

  it("waits until the address stops answering before starting", async () => {
    let probes = 0;
    const calls: string[] = [];
    const r = await capture(() =>
      runDaemon(ARGS, {
        restart: {
          stop: async () => 0,
          addressQuiet: async () => {
            probes++;
            return probes >= 4; // answers for 3 polls (still draining), then quiet
          },
          start: async () => (calls.push(`start@probe${probes}`), 0),
          pollMs: 5,
          waitMs: 5_000,
        },
      }),
    );
    expect(r.value).toBe(0);
    expect(calls).toEqual(["start@probe4"]);
  });

  it("propagates start's exit code", async () => {
    const r = await capture(() =>
      runDaemon(ARGS, {
        restart: { stop: async () => 0, addressQuiet: async () => true, start: async () => 7 },
      }),
    );
    expect(r.value).toBe(7);
  });

  it("does NOT start when stop failed, and returns stop's code", async () => {
    let started = false;
    const r = await capture(() =>
      runDaemon(ARGS, {
        restart: {
          stop: async () => 1,
          addressQuiet: async () => true,
          start: async () => ((started = true), 0),
        },
      }),
    );
    expect(r.value).toBe(1);
    expect(started).toBe(false);
    expect(r.err).toContain("restart aborted");
  });

  it("does NOT start a second daemon over an address that never goes quiet (bounded wait)", async () => {
    let started = false;
    const t0 = Date.now();
    const r = await capture(() =>
      runDaemon(ARGS, {
        restart: {
          stop: async () => 0,
          addressQuiet: async () => false,
          start: async () => ((started = true), 0),
          pollMs: 5,
          waitMs: 80,
        },
      }),
    );
    expect(r.value).toBe(1);
    expect(started).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.err).toContain("still answering");
  });

  it("an unrelated subcommand is still rejected with exit 2", async () => {
    const r = await capture(() => runDaemon({ positionals: ["frobnicate"], flags: {} }));
    expect(r.value).toBe(2);
    expect(r.err).toContain("unknown daemon subcommand: frobnicate");
  });
});
