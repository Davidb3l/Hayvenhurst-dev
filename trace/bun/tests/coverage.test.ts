/**
 * Per-test coverage: the CoverageAggregator, deriveCoverage's window-boundary
 * attribution (the anonymous-`it()` sidestep), the wire `test_coverage` field
 * (mirroring trace/python's payload exactly), and the flusher's chunked +
 * re-buffered sends.
 */
import { describe, expect, test } from "bun:test";

import { Aggregator, CoverageAggregator } from "../src/aggregator.ts";
import {
  Flusher,
  encodePayload,
  FLUSH_BATCH_SIZE,
  type Sender,
  type WirePayload,
} from "../src/flusher.ts";
import { deriveCoverage, deriveEdges, type CpuProfile, type NameResolver } from "../src/profile.ts";
import { makeResolver } from "../src/names.ts";

describe("CoverageAggregator", () => {
  test("accumulates (test, entity) weights and drains atomically", () => {
    const c = new CoverageAggregator();
    c.add("src/utils/body.test", "src/utils/body:parseBody", 3);
    c.add("src/utils/body.test", "src/utils/body:parseBody", 2);
    c.add("src/utils/body.test", "src/utils/buffer:bufferToString");
    expect(c.size()).toBe(2);

    const rows = c.drain();
    expect(c.size()).toBe(0);
    expect(rows).toContainEqual({
      test: "src/utils/body.test",
      entity: "src/utils/body:parseBody",
      weight: 5,
    });
    expect(rows).toContainEqual({
      test: "src/utils/body.test",
      entity: "src/utils/buffer:bufferToString",
      weight: 1,
    });
    expect(c.drain()).toEqual([]);
  });

  test("ignores empty names and non-positive weights", () => {
    const c = new CoverageAggregator();
    c.add("", "e");
    c.add("t", "");
    c.add("t", "e", 0);
    c.add("t", "e", -1);
    expect(c.size()).toBe(0);
  });
});

describe("deriveCoverage (window-boundary attribution)", () => {
  // A hono-shaped tree: (root) -> anonymous it() callback -> parseBody.
  // The anonymous frame is dropped by the resolver, so deriveEdges yields NO
  // test-attributable edge — but deriveCoverage still reports parseBody as
  // covered, which is the whole point: attribution comes from the window
  // (tagged with the current test file), not from a nameable caller frame.
  const profile: CpuProfile = {
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "" }, hitCount: 0, children: [2] },
      {
        id: 2,
        callFrame: { functionName: "", url: "file:///proj/src/utils/body.test.ts" }, // anonymous it()
        hitCount: 1,
        children: [3],
      },
      {
        id: 3,
        callFrame: { functionName: "parseBody", url: "file:///proj/src/utils/body.ts" },
        hitCount: 4,
        children: [4],
      },
      {
        id: 4,
        callFrame: { functionName: "bufferToString", url: "file:///proj/src/utils/buffer.ts" },
        hitCount: 2,
        children: [],
      },
    ],
  };
  const resolver = makeResolver({ projectPaths: ["/proj/"], moduleRoot: "/proj" });

  test("reports entities the window executed, with subtree sample sums", () => {
    const covered = deriveCoverage(profile, resolver);
    const byName = new Map(covered.map((c) => [c.name, c.observed]));
    expect(byName.get("src/utils/body:parseBody")).toBe(6); // 4 own + 2 callee
    expect(byName.get("src/utils/buffer:bufferToString")).toBe(2);
    expect(byName.size).toBe(2); // (root) + anonymous frames dropped
  });

  test("sidesteps the anonymous-it() blindness deriveEdges has", () => {
    const edges = deriveEdges(profile, resolver);
    // Only the callee->callee edge survives; nothing links a TEST to parseBody.
    expect(edges).toEqual([
      { src: "src/utils/body:parseBody", dst: "src/utils/buffer:bufferToString", observed: 2 },
    ]);
    // ...but coverage still attributes parseBody to the window's test context.
    const covered = deriveCoverage(profile, resolver);
    expect(covered.some((c) => c.name === "src/utils/body:parseBody")).toBe(true);
  });

  test("skips frames never sampled (zero subtree sum)", () => {
    const p: CpuProfile = {
      nodes: [
        {
          id: 1,
          callFrame: { functionName: "cold", url: "file:///proj/a.ts" },
          hitCount: 0,
          children: [],
        },
      ],
    };
    expect(deriveCoverage(p, resolver)).toEqual([]);
  });

  test("empty/malformed profile yields no coverage", () => {
    const r: NameResolver = { nameOf: () => "x:y" };
    expect(deriveCoverage({ nodes: [] }, r)).toEqual([]);
    expect(deriveCoverage(undefined as unknown as CpuProfile, r)).toEqual([]);
  });
});

describe("wire contract: test_coverage (mirrors trace/python)", () => {
  test("encodePayload appends test_coverage rows beside unchanged observations", () => {
    const p = encodePayload(
      [{ src: "a:f", dst: "b:g", ts: 1, observed: 5, kind: "call" }],
      1,
      "bun",
      [{ test: "src/utils/body.test", entity: "src/utils/body:parseBody", weight: 6 }],
    );
    expect(p.observations[0]!.weight).toBe(5);
    expect(p.test_coverage).toEqual([
      { test: "src/utils/body.test", entity: "src/utils/body:parseBody", weight: 6 },
    ]);
  });

  test("omits the key entirely when there is no coverage (legacy byte-identical)", () => {
    const p = encodePayload([{ src: "a:f", dst: "b:g", ts: 1, observed: 1, kind: "call" }], 1, "bun");
    expect("test_coverage" in p).toBe(false);
  });

  test("coverage-only payload carries observations: [] (daemon accepts it)", () => {
    const p = encodePayload([], 1, "bun", [{ test: "t", entity: "e", weight: 1 }]);
    expect(p.observations).toEqual([]);
    expect(p.test_coverage).toEqual([{ test: "t", entity: "e", weight: 1 }]);
  });
});

describe("Flusher with coverage (chunking + re-buffer)", () => {
  function mockSender() {
    const calls: Array<{ url: string; payload: WirePayload }> = [];
    const sender: Sender = async (url, body) => {
      calls.push({ url, payload: JSON.parse(body) as WirePayload });
    };
    return { calls, sender };
  }

  test("coverage rides the flush and both aggregators are drained", async () => {
    const { calls, sender } = mockSender();
    const agg = new Aggregator();
    const cov = new CoverageAggregator();
    agg.add("a:f", "b:g", "call", 5);
    cov.add("src/x.test", "a:f", 2);
    const f = new Flusher(agg, { daemonUrl: "http://x", sender, coverage: cov });

    expect(await f.flushOnce()).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]!.payload.test_coverage).toEqual([
      { test: "src/x.test", entity: "a:f", weight: 2 },
    ]);
    expect(agg.size()).toBe(0);
    expect(cov.size()).toBe(0);
  });

  test("coverage-only flush still POSTs (never drain-then-drop)", async () => {
    const { calls, sender } = mockSender();
    const cov = new CoverageAggregator();
    cov.add("src/x.test", "a:f");
    const f = new Flusher(new Aggregator(), { daemonUrl: "http://x", sender, coverage: cov });

    await f.flushOnce();
    expect(calls.length).toBe(1);
    expect(calls[0]!.payload.observations).toEqual([]);
    expect(calls[0]!.payload.test_coverage!.length).toBe(1);
  });

  test("large batches split into bounded chunks", async () => {
    const { calls, sender } = mockSender();
    const agg = new Aggregator();
    for (let i = 0; i < FLUSH_BATCH_SIZE + 5; i++) agg.add(`m:f${i}`, "m:g");
    const f = new Flusher(agg, { daemonUrl: "http://x", sender });

    expect(await f.flushOnce()).toBe(FLUSH_BATCH_SIZE + 5);
    expect(calls.length).toBe(2);
    expect(calls[0]!.payload.observations.length).toBe(FLUSH_BATCH_SIZE);
    expect(calls[1]!.payload.observations.length).toBe(5);
  });

  test("a failed chunk is re-buffered and retried on the next flush", async () => {
    let failNext = true;
    const delivered: WirePayload[] = [];
    const sender: Sender = async (_url, body) => {
      if (failNext) {
        failNext = false;
        throw new Error("ECONNREFUSED");
      }
      delivered.push(JSON.parse(body) as WirePayload);
    };
    const agg = new Aggregator();
    const cov = new CoverageAggregator();
    agg.add("a:f", "b:g", "call", 3);
    cov.add("src/x.test", "a:f", 2);
    const f = new Flusher(agg, { daemonUrl: "http://x", sender, coverage: cov });

    expect(await f.flushOnce()).toBe(0); // failed → re-buffered, not dropped
    expect(f.lastError).toContain("ECONNREFUSED");
    expect(agg.size()).toBe(1);
    expect(cov.size()).toBe(1);

    expect(await f.flushOnce()).toBe(1); // retry delivers the same data
    expect(f.lastError).toBeNull();
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.observations[0]).toMatchObject({ src: "a:f", dst: "b:g", observed: 3 });
    expect(delivered[0]!.test_coverage).toEqual([{ test: "src/x.test", entity: "a:f", weight: 2 }]);
  });
});
