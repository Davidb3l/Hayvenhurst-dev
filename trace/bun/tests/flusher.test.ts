import { describe, expect, test } from "bun:test";

import { Aggregator } from "../src/aggregator.ts";
import { Flusher, encodePayload, type Sender, type WirePayload } from "../src/flusher.ts";
import { UINT16_MAX } from "../src/profile.ts";

describe("encodePayload (wire contract)", () => {
  test("envelope shape: source, positive integer sample_rate, observations[]", () => {
    const p = encodePayload(
      [{ src: "a:f", dst: "b:g", ts: 1715789600, observed: 5, kind: "call" }],
      1,
      "bun",
    );
    expect(p.source).toBe("bun");
    expect(Number.isInteger(p.sample_rate)).toBe(true);
    expect(p.sample_rate).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(p.observations)).toBe(true);
    const o = p.observations[0]!;
    expect(o).toEqual({
      src: "a:f",
      dst: "b:g",
      ts: 1715789600,
      observed: 5,
      weight: 5,
      kind: "call",
    });
  });

  test("weight == observed * sample_rate for every observation", () => {
    for (const rate of [1, 2, 7, 100]) {
      const p = encodePayload(
        [
          { src: "a:f", dst: "b:g", ts: 1, observed: 3, kind: "call" },
          { src: "c:h", dst: "d:i", ts: 1, observed: 0, kind: "call" },
        ],
        rate,
        "bun",
      );
      for (const o of p.observations) {
        expect(o.weight).toBe(o.observed * rate);
      }
    }
  });

  test("honest CPU-profiler mapping: at sample_rate=1, observed == weight", () => {
    const p = encodePayload(
      [{ src: "a:f", dst: "b:g", ts: 1, observed: 42, kind: "call" }],
      1,
      "bun",
    );
    expect(p.observations[0]!.weight).toBe(p.observations[0]!.observed);
    expect(p.observations[0]!.observed).toBe(42);
  });

  test("clamps so observed*sample_rate never exceeds uint16, invariant preserved", () => {
    const p = encodePayload(
      [{ src: "a:f", dst: "b:g", ts: 1, observed: 999999, kind: "call" }],
      1,
      "bun",
    );
    const o = p.observations[0]!;
    expect(o.observed).toBe(UINT16_MAX);
    expect(o.weight).toBe(UINT16_MAX);
    expect(o.weight).toBe(o.observed * p.sample_rate);

    // With sample_rate > 1, observed is clamped first so weight stays <= ceiling.
    const p2 = encodePayload(
      [{ src: "a:f", dst: "b:g", ts: 1, observed: 999999, kind: "call" }],
      100,
      "bun",
    );
    const o2 = p2.observations[0]!;
    expect(o2.weight).toBeLessThanOrEqual(UINT16_MAX);
    expect(o2.weight).toBe(o2.observed * 100);
  });

  test("default kind is call when missing/empty", () => {
    const p = encodePayload(
      [{ src: "a:f", dst: "b:g", ts: 1, observed: 1, kind: "" }],
      1,
      "bun",
    );
    expect(p.observations[0]!.kind).toBe("call");
  });
});

describe("Flusher (injected mock sender)", () => {
  function mockSender() {
    const calls: Array<{ url: string; payload: WirePayload }> = [];
    const sender: Sender = async (url, body) => {
      calls.push({ url, payload: JSON.parse(body) as WirePayload });
    };
    return { calls, sender };
  }

  test("posts to /api/traces/observations and reports count", async () => {
    const { calls, sender } = mockSender();
    const agg = new Aggregator();
    agg.add("a:f", "b:g", "call", 5);
    const f = new Flusher(agg, { daemonUrl: "http://localhost:7777/", sender });
    const n = await f.flushOnce();

    expect(n).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://localhost:7777/api/traces/observations");
    expect(calls[0]!.payload.source).toBe("bun");
    expect(calls[0]!.payload.observations[0]).toMatchObject({
      src: "a:f",
      dst: "b:g",
      observed: 5,
      weight: 5,
    });
    expect(f.lastFlushCount).toBe(1);
    expect(f.lastError).toBeNull();
  });

  test("empty aggregator => no send, returns 0", async () => {
    const { calls, sender } = mockSender();
    const f = new Flusher(new Aggregator(), { daemonUrl: "http://x", sender });
    expect(await f.flushOnce()).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("drain happens once: a second flush sends nothing", async () => {
    const { calls, sender } = mockSender();
    const agg = new Aggregator();
    agg.add("a:f", "b:g");
    const f = new Flusher(agg, { daemonUrl: "http://x", sender });
    expect(await f.flushOnce()).toBe(1);
    expect(await f.flushOnce()).toBe(0);
    expect(calls.length).toBe(1);
  });

  test("unreachable daemon: flush no-ops, records lastError, never throws", async () => {
    const failing: Sender = async () => {
      throw new Error("ECONNREFUSED");
    };
    const agg = new Aggregator();
    agg.add("a:f", "b:g");
    const f = new Flusher(agg, { daemonUrl: "http://localhost:1", sender: failing });
    const n = await f.flushOnce(); // must not throw
    expect(n).toBe(0);
    expect(f.lastError).toContain("ECONNREFUSED");
  });

  test("source tag is configurable but defaults to bun", async () => {
    const { calls, sender } = mockSender();
    const agg = new Aggregator();
    agg.add("a:f", "b:g");
    const f = new Flusher(agg, { daemonUrl: "http://x", sender });
    await f.flushOnce();
    expect(calls[0]!.payload.source).toBe("bun");
  });

  test("stop(flush=true) flushes a final batch then is idempotent", async () => {
    const { calls, sender } = mockSender();
    const agg = new Aggregator();
    agg.add("a:f", "b:g");
    const f = new Flusher(agg, { daemonUrl: "http://x", sender });
    await f.stop(true);
    expect(calls.length).toBe(1);
    await f.stop(true); // nothing left to send
    expect(calls.length).toBe(1);
  });
});
