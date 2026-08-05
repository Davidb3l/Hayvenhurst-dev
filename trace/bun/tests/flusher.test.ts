import { describe, expect, test } from "bun:test";

import { Aggregator } from "../src/aggregator.ts";
import {
  Flusher,
  SenderHttpError,
  encodePayload,
  type Sender,
  type WirePayload,
} from "../src/flusher.ts";
import { UINT16_MAX } from "../src/profile.ts";
import pkg from "../package.json";

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

  test("transient failure (network / 5xx / 429) re-buffers and the next flush resends", async () => {
    for (const boom of [
      new Error("ECONNREFUSED"),
      new SenderHttpError(500, "daemon returned 500"),
      new SenderHttpError(429, "daemon returned 429"),
      new SenderHttpError(408, "daemon returned 408"),
    ]) {
      const calls: WirePayload[] = [];
      let failNext = true;
      const sender: Sender = async (_url, body) => {
        if (failNext) {
          failNext = false;
          throw boom;
        }
        calls.push(JSON.parse(body) as WirePayload);
      };
      const agg = new Aggregator();
      agg.add("a:f", "b:g", "call", 5);
      const f = new Flusher(agg, { daemonUrl: "http://x", sender });

      await f.flushOnce(); // fails, rows re-buffered
      expect(f.lastError).not.toBeNull();
      expect(f.lastError!.startsWith("dropped-permanent")).toBe(false);

      const n = await f.flushOnce(); // retry succeeds with the SAME rows
      expect(n).toBe(1);
      expect(calls.length).toBe(1);
      expect(calls[0]!.observations[0]).toMatchObject({ src: "a:f", dst: "b:g", observed: 5 });
      expect(f.lastError).toBeNull();
    }
  });

  test("permanent rejection (400) drops the batch instead of re-buffering", async () => {
    let sends = 0;
    const sender: Sender = async () => {
      sends++;
      throw new SenderHttpError(400, "daemon returned 400: weight mismatch");
    };
    const agg = new Aggregator();
    agg.add("a:f", "b:g", "call", 5);
    const f = new Flusher(agg, { daemonUrl: "http://x", sender });

    await f.flushOnce();
    expect(sends).toBe(1);
    expect(f.lastError).toStartWith("dropped-permanent: ");
    expect(f.lastError).toContain("400");

    // The rejected rows were NOT re-buffered: the next flush has nothing to
    // send, so the same batch is never re-POSTed every interval forever.
    expect(await f.flushOnce()).toBe(0);
    expect(sends).toBe(1);
  });

  test("overlapping flushes are serialized, never concurrent", async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    let sends = 0;
    const sender: Sender = async () => {
      const id = ++sends;
      active++;
      maxActive = Math.max(maxActive, active);
      // Yield twice so a concurrent (unserialized) second flush would be
      // observed as active > 1 here.
      await new Promise((r) => setTimeout(r, 5));
      active--;
      order.push(id);
    };
    const agg = new Aggregator();
    agg.add("a:f", "b:g", "call", 1);
    const f = new Flusher(agg, { daemonUrl: "http://x", sender });

    const p1 = f.flushOnce();
    // Let flush 1 drain and enter its (slow) send before adding more rows,
    // so flush 2 genuinely overlaps an in-flight send rather than being
    // absorbed into flush 1's drain.
    await new Promise((r) => setTimeout(r, 1));
    agg.add("c:h", "d:i", "call", 1);
    const p2 = f.flushOnce();
    const [n1, n2] = await Promise.all([p1, p2]);

    expect(maxActive).toBe(1); // never overlapped
    expect(order).toEqual([1, 2]); // strictly queued
    expect(n1).toBe(1);
    expect(n2).toBe(1);
  });

  test("default sender sends a User-Agent sourced from package.json", async () => {
    // Captured via an object property so TS control-flow analysis does not
    // narrow the value to `null` at the assertions below.
    const captured: { ua: string | null } = { ua: null };
    const realFetch = globalThis.fetch;
    // Bun's fetch is assignable; restore in finally so no other test sees it.
    (globalThis as { fetch: typeof fetch }).fetch = (async (
      _url: unknown,
      init?: RequestInit,
    ) => {
      captured.ua = (init?.headers as Record<string, string>)["User-Agent"] ?? null;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const agg = new Aggregator();
      agg.add("a:f", "b:g", "call", 1);
      const f = new Flusher(agg, { daemonUrl: "http://localhost:7777" }); // default sender
      await f.flushOnce();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = realFetch;
    }
    expect(captured.ua).toBe(`hayven-trace-bun/${pkg.version}`);
    expect(captured.ua).not.toContain("0.0.4"); // the stale hardcode this replaced
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
