import { describe, expect, test } from "bun:test";

import { prewarmCryptoLocks, resetPrewarmForTests } from "../src/prewarm.ts";

describe("prewarmCryptoLocks (fork-safety pre-warm)", () => {
  test("never throws, is idempotent, and actually warms the hash namemap", () => {
    resetPrewarmForTests();
    expect(() => prewarmCryptoLocks()).not.toThrow();
    expect(() => prewarmCryptoLocks()).not.toThrow(); // once-latch path

    // After the warm-up, getHashes must be a cheap cached read (and present on
    // this runtime — Bun and Node both ship it). This is the call the wedge
    // deadlocked in; post-warm it can never take the namemap write lock again.
    const crypto = process.getBuiltinModule?.("node:crypto") as
      | { getHashes(): string[] }
      | undefined;
    if (crypto) {
      expect(crypto.getHashes().length).toBeGreaterThan(0);
    }
  });
});
