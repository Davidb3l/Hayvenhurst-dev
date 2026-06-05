import { describe, expect, test } from "bun:test";
import { collectorOptionsFromEnv } from "../src/env.ts";

describe("collectorOptionsFromEnv", () => {
  test("empty env -> empty options (defaults applied by Collector)", () => {
    expect(collectorOptionsFromEnv({})).toEqual({});
  });

  test("maps HAYVEN_TRACE_* vars", () => {
    const opts = collectorOptionsFromEnv({
      HAYVEN_TRACE_CDP: "http://localhost:9333",
      HAYVEN_TRACE_URL: "http://daemon:7777",
      HAYVEN_TRACE_INTERVAL: "5000",
      HAYVEN_TRACE_DURATION: "2000",
      HAYVEN_TRACE_PROJECT: "https://a.local/,https://b.local/",
    });
    expect(opts.cdpUrl).toBe("http://localhost:9333");
    expect(opts.daemonUrl).toBe("http://daemon:7777");
    expect(opts.flushIntervalMs).toBe(5000);
    expect(opts.profileMs).toBe(2000);
    expect(opts.urlPrefixes).toEqual(["https://a.local/", "https://b.local/"]);
  });

  test("ignores non-numeric / non-positive interval and duration", () => {
    const opts = collectorOptionsFromEnv({
      HAYVEN_TRACE_INTERVAL: "nope",
      HAYVEN_TRACE_DURATION: "-1",
    });
    expect(opts.flushIntervalMs).toBeUndefined();
    expect(opts.profileMs).toBeUndefined();
  });
});
