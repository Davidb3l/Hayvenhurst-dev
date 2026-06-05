import { describe, expect, test } from "bun:test";
import { Aggregator } from "../src/aggregator.ts";

describe("Aggregator", () => {
  test("counts repeated edges", () => {
    const a = new Aggregator();
    a.add("auth:login", "db:getUser");
    a.add("auth:login", "db:getUser");
    a.add("auth:login", "db:getUser", 3);
    expect(a.size()).toBe(1);
    const obs = a.drain();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.src).toBe("auth:login");
    expect(obs[0]!.dst).toBe("db:getUser");
    expect(obs[0]!.observed).toBe(5);
    expect(obs[0]!.kind).toBe("call");
  });

  test("distinct edges are separate keys", () => {
    const a = new Aggregator();
    a.add("a:f", "b:g");
    a.add("a:f", "c:h");
    a.add("x:p", "b:g");
    expect(a.size()).toBe(3);
    expect(a.drain()).toHaveLength(3);
  });

  test("kind is part of edge identity", () => {
    const a = new Aggregator();
    a.add("a:f", "b:g", 1, "call");
    a.add("a:f", "b:g", 1, "await");
    expect(a.size()).toBe(2);
  });

  test("drops empty src/dst and non-positive counts", () => {
    const a = new Aggregator();
    a.add("", "b:g");
    a.add("a:f", "");
    a.add("a:f", "b:g", 0);
    a.add("a:f", "b:g", -2);
    expect(a.size()).toBe(0);
  });

  test("drain is atomic — resets state and stamps a Unix-SECONDS ts", () => {
    const a = new Aggregator();
    a.add("a:f", "b:g");
    const before = Math.floor(Date.now() / 1000);
    const obs = a.drain();
    const after = Math.floor(Date.now() / 1000);
    // ts is seconds, not ms.
    expect(obs[0]!.ts).toBeGreaterThanOrEqual(before);
    expect(obs[0]!.ts).toBeLessThanOrEqual(after);
    expect(String(obs[0]!.ts).length).toBeLessThanOrEqual(11);
    // State was reset.
    expect(a.size()).toBe(0);
    expect(a.drain()).toHaveLength(0);
  });

  test("addMany records one per pair", () => {
    const a = new Aggregator();
    a.addMany([
      ["a:f", "b:g"],
      ["a:f", "b:g"],
      ["", "b:g"],
    ]);
    const obs = a.drain();
    expect(obs).toHaveLength(1);
    expect(obs[0]!.observed).toBe(2);
  });
});
