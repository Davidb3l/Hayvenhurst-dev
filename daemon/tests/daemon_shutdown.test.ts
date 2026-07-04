/**
 * `drainIngestChain` — shutdown waits (bounded) for an in-flight ingest/re-point
 * to settle before the db is closed, so a live write isn't cut off mid-flight
 * (use-after-close). See `cli/daemon.ts`.
 */
import { describe, expect, test } from "bun:test";

import { drainIngestChain } from "../src/cli/daemon.ts";

describe("drainIngestChain", () => {
  test("resolves 'drained' when the chain settles before the timeout", async () => {
    let done = false;
    const chain = new Promise<void>((r) => setTimeout(() => { done = true; r(); }, 10));
    const result = await drainIngestChain(chain, 1000);
    expect(result).toBe("drained");
    expect(done).toBe(true); // it actually waited for the chain
  });

  test("resolves 'drained' even if the chain REJECTS (we only care it stopped writing)", async () => {
    const chain = Promise.reject(new Error("ingest blew up"));
    const result = await drainIngestChain(chain, 1000);
    expect(result).toBe("drained");
  });

  test("returns 'timeout' when the chain hangs past the timeout (never blocks exit)", async () => {
    const neverSettles = new Promise<void>(() => {}); // hangs forever
    const start = Date.now();
    const result = await drainIngestChain(neverSettles, 30);
    expect(result).toBe("timeout");
    expect(Date.now() - start).toBeLessThan(500); // bounded, didn't hang
  });

  test("an already-resolved chain drains immediately", async () => {
    expect(await drainIngestChain(Promise.resolve(), 1000)).toBe("drained");
  });
});
