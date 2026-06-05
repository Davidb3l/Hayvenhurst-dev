import { describe, expect, test } from "bun:test";
import { Aggregator } from "../src/aggregator.ts";
import { Flusher, type Sender } from "../src/flusher.ts";

/** A mock sender that records every (url, parsed-payload) it receives. */
function recordingSender(): { sender: Sender; calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = [];
  const sender: Sender = async (url, payload) => {
    calls.push({ url, body: JSON.parse(payload) });
  };
  return { sender, calls };
}

describe("Flusher payload encoding", () => {
  test("envelope shape: source=browser, sample_rate=1, observations[]", async () => {
    const agg = new Aggregator();
    agg.add("auth:login", "db:getUser", 5);
    const { sender, calls } = recordingSender();
    const f = new Flusher(agg, { daemonUrl: "http://localhost:7777", sender });

    const n = await f.flushOnce();
    expect(n).toBe(1);
    expect(calls).toHaveLength(1);

    const { url, body } = calls[0]!;
    expect(url).toBe("http://localhost:7777/api/traces/observations");
    expect(body.source).toBe("browser");
    expect(body.sample_rate).toBe(1);
    expect(Array.isArray(body.observations)).toBe(true);

    const o = body.observations[0];
    expect(o.src).toBe("auth:login");
    expect(o.dst).toBe("db:getUser");
    expect(o.observed).toBe(5);
    expect(o.kind).toBe("call");
    expect(typeof o.ts).toBe("number");
  });

  test("weight == observed * sample_rate holds (honest mapping: rate=1)", async () => {
    const agg = new Aggregator();
    agg.add("a:f", "b:g", 7);
    agg.add("c:h", "d:k", 12);
    const { sender, calls } = recordingSender();
    const f = new Flusher(agg, { daemonUrl: "http://x", sender });

    await f.flushOnce();
    const { body } = calls[0]!;
    expect(body.sample_rate).toBe(1);
    for (const o of body.observations) {
      expect(o.weight).toBe(o.observed * body.sample_rate);
      // With the honest mapping, weight == observed.
      expect(o.weight).toBe(o.observed);
    }
  });

  test("weight == observed * sample_rate when rate > 1", async () => {
    const agg = new Aggregator();
    agg.add("a:f", "b:g", 4);
    const { sender, calls } = recordingSender();
    const f = new Flusher(agg, { daemonUrl: "http://x", sender, sampleRate: 100 });

    await f.flushOnce();
    const { body } = calls[0]!;
    expect(body.sample_rate).toBe(100);
    const o = body.observations[0];
    expect(o.observed).toBe(4);
    expect(o.weight).toBe(400);
    expect(o.weight).toBe(o.observed * body.sample_rate);
  });

  test("clamps observed/weight to uint16 preserving the invariant", async () => {
    const agg = new Aggregator();
    agg.add("a:f", "b:g", 70000); // > 65535
    const { sender, calls } = recordingSender();
    const f = new Flusher(agg, { daemonUrl: "http://x", sender });

    await f.flushOnce();
    const o = calls[0]!.body.observations[0];
    expect(o.observed).toBe(65535);
    expect(o.weight).toBe(65535);
    expect(o.weight).toBe(o.observed * calls[0]!.body.sample_rate);
  });

  test("rate>1 clamp keeps weight<=uint16 and invariant exact", async () => {
    const agg = new Aggregator();
    agg.add("a:f", "b:g", 1000);
    const { sender, calls } = recordingSender();
    const f = new Flusher(agg, { daemonUrl: "http://x", sender, sampleRate: 100 });

    await f.flushOnce();
    const o = calls[0]!.body.observations[0];
    expect(o.weight).toBeLessThanOrEqual(65535);
    expect(o.observed).toBeLessThanOrEqual(65535);
    expect(o.weight).toBe(o.observed * 100);
  });

  test("empty aggregator: no send, returns 0", async () => {
    const agg = new Aggregator();
    const { sender, calls } = recordingSender();
    const f = new Flusher(agg, { daemonUrl: "http://x", sender });
    expect(await f.flushOnce()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("unreachable daemon: flush no-ops gracefully, error stashed, no throw", async () => {
    const agg = new Aggregator();
    agg.add("a:f", "b:g");
    const failing: Sender = async () => {
      throw new Error("ECONNREFUSED");
    };
    const f = new Flusher(agg, { daemonUrl: "http://x", sender: failing });

    // Must NOT throw.
    const n = await f.flushOnce();
    expect(n).toBe(1); // drained, attempted
    expect(f.lastError).toContain("ECONNREFUSED");
    expect(f.lastFlushCount).toBe(0); // never recorded a success
  });

  test("trailing slashes on daemonUrl are normalized", async () => {
    const agg = new Aggregator();
    agg.add("a:f", "b:g");
    const { sender, calls } = recordingSender();
    const f = new Flusher(agg, { daemonUrl: "http://localhost:7777///", sender });
    await f.flushOnce();
    expect(calls[0]!.url).toBe("http://localhost:7777/api/traces/observations");
  });
});
