import { describe, expect, test } from "bun:test";

import { Aggregator } from "../src/aggregator.ts";

describe("Aggregator", () => {
  test("counts repeated edges and sums weights", () => {
    const agg = new Aggregator();
    agg.add("a:f", "b:g"); // +1
    agg.add("a:f", "b:g"); // +1
    agg.add("a:f", "b:g", "call", 5); // +5
    agg.add("a:f", "c:h"); // distinct edge
    expect(agg.size()).toBe(2);

    const obs = agg.drain();
    const byPair = new Map(obs.map((o) => [`${o.src}->${o.dst}`, o]));
    expect(byPair.get("a:f->b:g")!.observed).toBe(7);
    expect(byPair.get("a:f->c:h")!.observed).toBe(1);
  });

  test("drain is atomic: resets state and a second drain is empty", () => {
    const agg = new Aggregator();
    agg.add("a:f", "b:g");
    expect(agg.drain().length).toBe(1);
    expect(agg.size()).toBe(0);
    expect(agg.drain().length).toBe(0);
  });

  test("drain stamps a Unix-seconds ts and carries kind", () => {
    const agg = new Aggregator();
    agg.add("a:f", "b:g", "call", 3);
    const before = Math.floor(Date.now() / 1000);
    const [o] = agg.drain();
    expect(o).toBeDefined();
    expect(o!.kind).toBe("call");
    expect(Number.isInteger(o!.ts)).toBe(true);
    // Unix SECONDS, not ms: roughly "now", far below ms magnitude.
    expect(o!.ts).toBeGreaterThanOrEqual(before - 2);
    expect(o!.ts).toBeLessThan(before + 2);
  });

  test("ignores empty names and non-positive weights", () => {
    const agg = new Aggregator();
    agg.add("", "b:g");
    agg.add("a:f", "");
    agg.add("a:f", "b:g", "call", 0);
    agg.add("a:f", "b:g", "call", -3);
    expect(agg.size()).toBe(0);
  });

  test("edges differing only by kind are distinct keys", () => {
    const agg = new Aggregator();
    agg.add("a:f", "b:g", "call");
    agg.add("a:f", "b:g", "other");
    expect(agg.size()).toBe(2);
  });
});
