// Unit tests for the hand-rolled useQuery cache, focused on the stale-request
// cancellation fix: a slow earlier fetch must never clobber the cache once a
// newer fetch for the same key has superseded it, and an aborted/AbortError
// fetch must never surface as a user-facing error.

import { test, expect, describe, beforeEach } from "bun:test";
import { __test } from "../src/components/useQuery";

const { runFetch, keyOf, readEntry, reset } = __test;

// A deferred promise we can resolve/reject on demand to control fetch ordering.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useQuery cache: stale-request cancellation", () => {
  beforeEach(() => reset());

  test("a late-resolving superseded fetch does not overwrite a newer result", async () => {
    const key = keyOf(["search", "ab"]);
    const first = deferred<{ hits: string[] }>();
    const second = deferred<{ hits: string[] }>();

    // Start fetch #1 (will resolve LAST, simulating an out-of-order response).
    const p1 = runFetch(key, () => first.promise, false);
    // Supersede it with fetch #2 for the SAME key (e.g. refetch / interval).
    const p2 = runFetch(key, () => second.promise, false);

    // #2 resolves first with the fresh result.
    second.resolve({ hits: ["fresh"] });
    await p2;
    expect(readEntry<{ hits: string[] }>(key)?.data).toEqual({ hits: ["fresh"] });

    // #1 (the stale one) resolves LATER — it must be ignored, not clobber.
    first.resolve({ hits: ["stale"] });
    await p1;
    expect(readEntry<{ hits: string[] }>(key)?.data).toEqual({ hits: ["fresh"] });
  });

  test("superseded fetch's signal is aborted when a newer fetch starts", async () => {
    const key = keyOf(["search", "x"]);
    let capturedSignal: AbortSignal | undefined;
    const first = deferred<number>();

    const p1 = runFetch(
      key,
      (signal) => {
        capturedSignal = signal;
        return first.promise;
      },
      false,
    );
    expect(capturedSignal?.aborted).toBe(false);

    // Newer fetch supersedes → the prior signal must now be aborted.
    const p2 = runFetch(key, () => Promise.resolve(2), false);
    expect(capturedSignal?.aborted).toBe(true);

    first.resolve(1);
    await Promise.all([p1, p2]);
    expect(readEntry<number>(key)?.data).toBe(2);
  });

  test("an AbortError from the queryFn is never surfaced as an error", async () => {
    const key = keyOf(["search", "y"]);
    const abortErr = new DOMException("aborted", "AbortError");
    await runFetch(key, () => Promise.reject(abortErr), false);
    const e = readEntry<unknown>(key);
    expect(e?.error).toBeUndefined();
    expect(e?.data).toBeUndefined();
  });

  test("a superseded fetch that rejects does not overwrite the newer result", async () => {
    const key = keyOf(["search", "z"]);
    const first = deferred<number>();

    const p1 = runFetch(key, () => first.promise, false);
    const p2 = runFetch(key, () => Promise.resolve(99), false);
    await p2;
    expect(readEntry<number>(key)?.data).toBe(99);

    // The superseded fetch rejects late — must not set error or wipe data.
    first.reject(new Error("network blip"));
    await p1;
    const e = readEntry<number>(key);
    expect(e?.error).toBeUndefined();
    expect(e?.data).toBe(99);
  });

  test("a genuine (non-aborted) error is still surfaced", async () => {
    const key = keyOf(["search", "err"]);
    await runFetch(key, () => Promise.reject(new Error("HTTP 500")), false);
    expect(readEntry<unknown>(key)?.error?.message).toBe("HTTP 500");
  });

  test("dedup coalesces concurrent identical fetches into one request", async () => {
    const key = keyOf(["search", "dedup"]);
    let calls = 0;
    const d = deferred<number>();
    const fn = () => {
      calls++;
      return d.promise;
    };
    // Two concurrent mount-path fetches (dedup=true, the default) share one.
    const p1 = runFetch(key, fn);
    const p2 = runFetch(key, fn);
    expect(calls).toBe(1);
    d.resolve(7);
    await Promise.all([p1, p2]);
    expect(readEntry<number>(key)?.data).toBe(7);
  });

  test("after a fetch settles, inFlight and controller are cleared", async () => {
    const key = keyOf(["search", "clear"]);
    await runFetch(key, () => Promise.resolve(1), false);
    const e = readEntry<number>(key)!;
    expect(e.inFlight).toBeUndefined();
    expect(e.controller).toBeUndefined();
    expect(e.data).toBe(1);
  });
});
