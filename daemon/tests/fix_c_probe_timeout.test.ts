/**
 * Lane C regressions in `daemon/detach.ts`:
 *
 *   C3 — `probeDaemon`'s fetch had no `AbortSignal`, and `waitForDaemon` only
 *        consulted its deadline AFTER the probe returned. Against a socket that
 *        ACCEPTS and never answers — a live daemon with a pegged event loop,
 *        i.e. the runaway-ingest incident — one probe took 300,020 ms (Bun's
 *        5-minute default idle timeout) and a `waitForDaemon(…, 10_000)` was
 *        still parked at 45 s. Five stacked `hayven daemon start` processes came
 *        from exactly this.
 *
 *   C4 — nothing ever compared the daemon's reported `version` against the
 *        CLI's, so a new CLI drove an old resident daemon and took a mystery
 *        JSON 404 on a route it does not serve.
 *
 * PORT DISCIPLINE: the hang tests bind an OS-assigned port (`listen(0)`) and
 * assert the assignment, so nothing here depends on a fixed port being free.
 * They pass with the real daemon running on 127.0.0.1:7777.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";

import {
  DETACH_PROBE_TIMEOUT_MS,
  checkDaemonVersion,
  probeDaemon,
  waitForDaemon,
} from "../src/daemon/detach.ts";
import { VERSION } from "../src/version.ts";

/* ---------------- an accept-and-never-answer TCP server ---------------- */

let server: Server | null = null;
const sockets: Socket[] = [];

/**
 * Bind a TCP listener that COMPLETES the handshake and then goes silent — the
 * shape a wedged daemon presents. A `connect` refusal would not exercise the
 * bug at all: the old code returned `unreachable` instantly for ECONNREFUSED.
 * Port 0 lets the OS pick, so this never collides with the real daemon.
 */
async function startHangingServer(): Promise<string> {
  const s = createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {}); // the client aborting must not throw here
    // Deliberately no write, no end.
  });
  server = s;
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const addr = s.address();
  if (addr === null || typeof addr === "string") throw new Error("expected a TCP address");
  expect(addr.port).toBeGreaterThan(0); // explicit precondition: we own a real port
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  for (const sock of sockets.splice(0)) sock.destroy();
  const s = server;
  server = null;
  if (s !== null) await new Promise<void>((resolve) => s.close(() => resolve()));
});

describe("C3: the health probe is actually bounded", () => {
  it("probeDaemon gives up on a socket that accepts and never answers", async () => {
    const base = await startHangingServer();
    const started = Date.now();
    const probe = await probeDaemon(base, fetch, 400);
    const elapsed = Date.now() - started;

    expect(probe.kind).toBe("unreachable");
    // Without the AbortSignal this sat for ~300 s. Generous ceiling so a loaded
    // CI box does not flake, still 3 orders of magnitude under the bug.
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  it("waitForDaemon's timeoutMs bounds TOTAL elapsed time against a hang", async () => {
    // DELIBERATE SHAPE: the per-probe budget (8 s) is far LARGER than the total
    // budget (400 ms). Only the clamp-to-remaining-budget can satisfy this — a
    // loop that merely checks its deadline AFTER each probe (the old code, even
    // with an AbortSignal added) returns at ~8 s and fails here. Without that
    // asymmetry the assertion would pass for the wrong reason.
    const base = await startHangingServer();
    const started = Date.now();
    const health = await waitForDaemon(base, {
      timeoutMs: 400,
      intervalMs: 50,
      probeTimeoutMs: 8_000,
    });
    const elapsed = Date.now() - started;

    expect(health).toBeNull();
    expect(elapsed).toBeLessThan(3_000);
  }, 30_000);

  it("the default per-probe budget is small enough to be useful", () => {
    // A regression fence: if someone sets this to Bun's default (300_000) the
    // fix is undone even though the AbortSignal is still technically present.
    expect(DETACH_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it("passes an AbortSignal to fetch on every probe", async () => {
    let sawSignal = false;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await probeDaemon("http://x", fetchImpl);
    expect(sawSignal).toBe(true);
  });

  it("a hung probe still lets waitForDaemon see a daemon that comes up later", async () => {
    // The clamp must not turn "slow first answer" into "gave up forever".
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ ok: true, version: VERSION, root: "/repo" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const health = await waitForDaemon("http://x", {
      timeoutMs: 5_000,
      intervalMs: 1,
      fetchImpl,
      sleep: async () => {},
    });
    expect(health?.root).toBe("/repo");
    expect(calls).toBe(3);
  });
});

describe("C4: CLI ↔ daemon version handshake", () => {
  it("accepts a daemon at the CLI's own version", () => {
    expect(checkDaemonVersion(VERSION, VERSION)).toEqual({ ok: true });
  });

  it("refuses a daemon older than the supported floor, naming both versions", () => {
    const check = checkDaemonVersion("0.0.5", "0.0.6", "0.0.6");
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("0.0.5");
      expect(check.reason).toContain("0.0.6");
      expect(check.reason).toContain("hayven daemon stop");
    }
  });

  it("refuses a daemon from a newer MAJOR, telling the user to upgrade", () => {
    const check = checkDaemonVersion("1.2.0", "0.0.6", "0.0.6");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("Upgrade the binary");
  });

  it("allows a daemon newer within the same major (do not break the common case)", () => {
    expect(checkDaemonVersion("0.1.4", "0.0.6", "0.0.6")).toEqual({ ok: true });
    expect(checkDaemonVersion("0.0.9", "0.0.6", "0.0.6")).toEqual({ ok: true });
  });

  it("treats an unparseable version as incompatible rather than assuming it is fine", () => {
    const check = checkDaemonVersion("dev", "0.0.6", "0.0.6");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("dev");
  });

  it("probeDaemon rejects a well-shaped but STALE daemon and carries the reason", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, version: "0.0.1", root: "/repo" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const probe = await probeDaemon("http://x", fetchImpl);

    // Not `hayven` — the caller must refuse instead of proceeding into a 404.
    expect(probe.kind).toBe("foreign");
    if (probe.kind === "foreign") {
      expect(probe.reason).toBeDefined();
      expect(probe.reason).toContain("0.0.1");
      // `health` is carried so a caller can report WHICH daemon it found.
      expect(probe.health?.root).toBe("/repo");
    }
  });

  it("a genuinely non-hayven 200 stays reason-less foreign (the two cases differ)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const probe = await probeDaemon("http://x", fetchImpl);
    expect(probe.kind).toBe("foreign");
    if (probe.kind === "foreign") expect(probe.reason).toBeUndefined();
  });
});
