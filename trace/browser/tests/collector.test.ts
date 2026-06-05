import { describe, expect, test } from "bun:test";
import { Collector } from "../src/collector.ts";
import type { CdpConnection, CdpTarget } from "../src/cdp.ts";
import type { CpuProfile } from "../src/profile-tree.ts";
import type { Sender } from "../src/flusher.ts";

const PROFILE: CpuProfile = {
  nodes: [
    { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
    { id: 2, callFrame: { functionName: "main", url: "https://app.local/app.js" }, hitCount: 1, children: [3] },
    { id: 3, callFrame: { functionName: "login", url: "https://app.local/auth.js" }, hitCount: 6, children: [4] },
    { id: 4, callFrame: { functionName: "getUser", url: "https://app.local/db.js" }, hitCount: 3, children: [] },
  ],
};

/** A mock CDP connection that records commands and returns the fixture. */
function mockConn(): { conn: CdpConnection; commands: string[]; closed: { v: boolean } } {
  const commands: string[] = [];
  const closed = { v: false };
  const conn: CdpConnection = {
    async send<T>(method: string): Promise<T> {
      commands.push(method);
      if (method === "Profiler.stop") {
        return { profile: PROFILE } as unknown as T;
      }
      return {} as T;
    },
    close() {
      closed.v = true;
    },
  };
  return { conn, commands, closed };
}

describe("Collector", () => {
  test("profileOnce drives Profiler.* and aggregates decoded edges", async () => {
    const { conn, commands, closed } = mockConn();
    const target: CdpTarget = {
      id: "t1",
      type: "page",
      url: "https://app.local/",
      webSocketDebuggerUrl: "ws://localhost:9222/devtools/page/t1",
    };
    const c = new Collector({
      profileMs: 1, // keep the test fast
      discover: async () => [target],
      connect: async () => conn,
    });

    const result = await c.profileOnce();
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.target).toBe("https://app.local/");
      expect(result.edges).toBe(2); // main->login, login->getUser (root dropped)
    }

    // Drove the full profiler lifecycle and closed the connection.
    expect(commands).toEqual(["Profiler.enable", "Profiler.start", "Profiler.stop"]);
    expect(closed.v).toBe(true);

    // Aggregated edges are present.
    const obs = c.aggregator.drain();
    const byKey = new Map(obs.map((o) => [`${o.src}->${o.dst}`, o.observed]));
    expect(byKey.get("app:main->auth:login")).toBe(9); // inclusive: 6 + 3
    expect(byKey.get("auth:login->db:getUser")).toBe(3);
  });

  test("end-to-end: profiled edges flush through an injected sender", async () => {
    const { conn } = mockConn();
    const calls: any[] = [];
    const sender: Sender = async (_url, payload) => {
      calls.push(JSON.parse(payload));
    };
    const target: CdpTarget = {
      id: "t1",
      type: "page",
      webSocketDebuggerUrl: "ws://x",
    };
    const c = new Collector({
      profileMs: 1,
      discover: async () => [target],
      connect: async () => conn,
      sender,
    });

    await c.profileOnce();
    const sent = await c.flusher.flushOnce();
    expect(sent).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe("browser");
    expect(calls[0].sample_rate).toBe(1);
    for (const o of calls[0].observations) {
      expect(o.weight).toBe(o.observed * 1);
    }
  });

  test("SKIPS cleanly when no Chrome target is reachable", async () => {
    const c = new Collector({
      discover: async () => [], // no targets (Chrome down)
    });
    const result = await c.profileOnce();
    expect(result.skipped).toBe(true);
    if (result.skipped) {
      expect(result.reason).toContain("--remote-debugging-port=9222");
    }
    // Nothing aggregated.
    expect(c.aggregator.size()).toBe(0);
  });

  test("SKIPS cleanly when the CDP websocket cannot be opened", async () => {
    const target: CdpTarget = { id: "t", type: "page", webSocketDebuggerUrl: "ws://x" };
    const c = new Collector({
      discover: async () => [target],
      connect: async () => {
        throw new Error("connection refused");
      },
    });
    const result = await c.profileOnce();
    expect(result.skipped).toBe(true);
    if (result.skipped) expect(result.reason).toContain("connection refused");
  });
});
