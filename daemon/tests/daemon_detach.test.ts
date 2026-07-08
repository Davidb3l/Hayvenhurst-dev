/**
 * Detached daemon start plumbing (`daemon/detach.ts`):
 *   1. `buildDetachedCommand` — the re-exec argv for BOTH execution modes
 *      (source: `bun src/cli.ts …`; compiled single binary: virtual `$bunfs`
 *      entrypoint), always with the internal `--foreground` flag, forwarding
 *      the user's bind overrides.
 *   2. `looksLikeHayvenHealth` — the shape check that tells "port owned by a
 *      hayven daemon" apart from "port owned by something else".
 *   3. `probeDaemon` / `waitForDaemon` — classification + bounded polling,
 *      with fetch/sleep injected so nothing binds a real port.
 */
import { describe, expect, it } from "bun:test";

import {
  buildDetachedCommand,
  looksLikeHayvenHealth,
  probeDaemon,
  waitForDaemon,
} from "../src/daemon/detach.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("buildDetachedCommand", () => {
  it("source mode: re-execs `bun <script> daemon start --foreground`", () => {
    const cmd = buildDetachedCommand({
      execPath: "/usr/local/bin/bun",
      entryScript: "/repo/daemon/src/cli.ts",
    });
    expect(cmd).toEqual([
      "/usr/local/bin/bun",
      "/repo/daemon/src/cli.ts",
      "daemon",
      "start",
      "--foreground",
    ]);
  });

  it("compiled mode ($bunfs entrypoint): re-execs the binary itself", () => {
    const cmd = buildDetachedCommand({
      execPath: "/usr/local/bin/hayven",
      entryScript: "/$bunfs/root/cli",
    });
    expect(cmd).toEqual(["/usr/local/bin/hayven", "daemon", "start", "--foreground"]);
  });

  it("missing entry script is treated as compiled (never passes a bogus arg)", () => {
    const cmd = buildDetachedCommand({
      execPath: "/usr/local/bin/hayven",
      entryScript: undefined,
    });
    expect(cmd).toEqual(["/usr/local/bin/hayven", "daemon", "start", "--foreground"]);
  });

  it("forwards bind overrides so child and parent agree on the address", () => {
    const cmd = buildDetachedCommand({
      execPath: "/usr/local/bin/bun",
      entryScript: "/repo/daemon/src/cli.ts",
      extraArgs: ["--port", "7911", "--host", "127.0.0.1"],
    });
    expect(cmd.slice(-6)).toEqual(["start", "--foreground", "--port", "7911", "--host", "127.0.0.1"]);
    // The internal flag is present exactly once.
    expect(cmd.filter((a) => a === "--foreground")).toHaveLength(1);
  });
});

describe("looksLikeHayvenHealth", () => {
  it("accepts a real health payload", () => {
    expect(
      looksLikeHayvenHealth({ ok: true, version: "0.0.5", root: "/repo", projects: [] }),
    ).toBe(true);
  });

  it("rejects a random 200 JSON body (a foreign dev server)", () => {
    expect(looksLikeHayvenHealth({ ok: true })).toBe(false);
    expect(looksLikeHayvenHealth({ status: "up" })).toBe(false);
    expect(looksLikeHayvenHealth(null)).toBe(false);
    expect(looksLikeHayvenHealth("ok")).toBe(false);
  });

  it("rejects ok:false even with the right fields", () => {
    expect(looksLikeHayvenHealth({ ok: false, version: "0.0.5", root: "/repo" })).toBe(false);
  });
});

describe("probeDaemon", () => {
  it("classifies a hayven health payload as `hayven`", async () => {
    const probe = await probeDaemon("http://x", (async () =>
      jsonResponse({ ok: true, version: "0.0.5", root: "/repo" })) as unknown as typeof fetch);
    expect(probe.kind).toBe("hayven");
    if (probe.kind === "hayven") expect(probe.health.root).toBe("/repo");
  });

  it("classifies a non-hayven 200 as `foreign`", async () => {
    const probe = await probeDaemon("http://x", (async () =>
      jsonResponse({ hello: "world" })) as unknown as typeof fetch);
    expect(probe.kind).toBe("foreign");
  });

  it("classifies a non-JSON body as `foreign`", async () => {
    const probe = await probeDaemon("http://x", (async () =>
      new Response("<html>not a daemon</html>", { status: 200 })) as unknown as typeof fetch);
    expect(probe.kind).toBe("foreign");
  });

  it("classifies an error status as `foreign`", async () => {
    const probe = await probeDaemon("http://x", (async () =>
      jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch);
    expect(probe.kind).toBe("foreign");
  });

  it("classifies a connection failure as `unreachable`", async () => {
    const probe = await probeDaemon("http://x", (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(probe.kind).toBe("unreachable");
  });
});

describe("waitForDaemon", () => {
  it("resolves with the health payload once the daemon comes up", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNREFUSED"); // still starting
      return jsonResponse({ ok: true, version: "0.0.5", root: "/repo" });
    }) as unknown as typeof fetch;
    const health = await waitForDaemon("http://x", {
      timeoutMs: 5_000,
      intervalMs: 1,
      fetchImpl,
      sleep: async () => {},
    });
    expect(health).not.toBeNull();
    expect(calls).toBe(3);
  });

  it("returns null when the deadline passes with nothing listening", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const health = await waitForDaemon("http://x", {
      timeoutMs: 5,
      intervalMs: 1,
      fetchImpl,
      sleep: async () => {},
    });
    expect(health).toBeNull();
  });

  it("keeps polling through transient foreign answers until the deadline", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ warming: "up" }); // never a hayven health shape
    }) as unknown as typeof fetch;
    const health = await waitForDaemon("http://x", {
      timeoutMs: 5,
      intervalMs: 1,
      fetchImpl,
      sleep: async () => {},
    });
    expect(health).toBeNull();
    expect(calls).toBeGreaterThan(1);
  });
});
