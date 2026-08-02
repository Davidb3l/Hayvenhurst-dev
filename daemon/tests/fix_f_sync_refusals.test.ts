// LANE F — `hayven sync` must survive a per-segment refusal.
//
// F4 gave `/api/sync/push` real rejections (bad segment day, oversized batch,
// segment at its hard cap). Those rejections are correct, but the CLI's
// transfer loops call `postJson`, which throws on any non-2xx — so without the
// per-segment catch, ONE segment stamped by a peer with a skewed clock aborts
// `runSyncWith` entirely and every other segment in the session, including all
// the good ones, silently never transfers. On every subsequent run, forever.
// That would be a strictly worse bug than the one F4 fixed.
//
// `isRefusal` is the load-bearing classifier: a 4xx means "skip this segment
// and keep going", anything else (connection refused, 5xx, a thrown TypeError)
// must still abort loudly. This asserts it against the EXACT message shape
// `postJson`/`fetchJson` build, so a change to that format cannot quietly turn
// every refusal into a fatal error — or, worse, every transport failure into a
// silently-skipped segment.
import { describe, expect, test } from "bun:test";

import { isRefusal } from "../src/cli/sync.ts";

const PUSH = "http://peer.example:7777/api/sync/push";

describe("LANE F — sync refusal classification", () => {
  test("4xx refusals from postJson are skippable, not fatal", () => {
    for (const status of [400, 404, 413, 429, 499]) {
      const err = new Error(`POST ${PUSH} → ${status}: {"error":"nope"}`);
      expect(isRefusal(err)).toBe(true);
    }
    // The two F4 rejections, verbatim.
    expect(
      isRefusal(
        new Error(
          `POST ${PUSH} → 400: {"error":"segment day 9999-12-31 is more than 7 days in the future"}`,
        ),
      ),
    ).toBe(true);
    expect(
      isRefusal(new Error(`POST ${PUSH} → 413: {"error":"batch is 9000000 bytes, over the cap"}`)),
    ).toBe(true);
  });

  test("everything that is NOT a refusal still aborts the sync", () => {
    // A 5xx is a peer fault, not a refusal — retrying/aborting is right.
    expect(isRefusal(new Error(`POST ${PUSH} → 500: boom`))).toBe(false);
    expect(isRefusal(new Error(`POST ${PUSH} → 503: unavailable`))).toBe(false);
    // Transport failures carry no status at all.
    expect(isRefusal(new Error("Unable to connect. Is the computer able to access the url?"))).toBe(
      false,
    );
    expect(isRefusal(new TypeError("fetch failed"))).toBe(false);
    expect(isRefusal(undefined)).toBe(false);
    expect(isRefusal(null)).toBe(false);
    // A 4-digit status that merely STARTS with 4 is not a 4xx.
    expect(isRefusal(new Error(`POST ${PUSH} → 4000: weird`))).toBe(false);
  });
});
