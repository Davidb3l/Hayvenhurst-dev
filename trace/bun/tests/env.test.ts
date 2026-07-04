import { describe, expect, test } from "bun:test";

import { configFromEnv } from "../src/env.ts";
import { DEFAULT_CONFIG } from "../src/tracer.ts";

describe("configFromEnv (new knobs)", () => {
  test("HAYVEN_TRACE_SAMPLING_US sets the V8 sampling interval", () => {
    expect(configFromEnv({}, {}).samplingIntervalUs).toBe(DEFAULT_CONFIG.samplingIntervalUs);
    expect(configFromEnv({}, { HAYVEN_TRACE_SAMPLING_US: "100" }).samplingIntervalUs).toBe(100);
    // Invalid values are ignored, never clamp-guessed.
    expect(configFromEnv({}, { HAYVEN_TRACE_SAMPLING_US: "0" }).samplingIntervalUs).toBe(
      DEFAULT_CONFIG.samplingIntervalUs,
    );
    expect(configFromEnv({}, { HAYVEN_TRACE_SAMPLING_US: "abc" }).samplingIntervalUs).toBe(
      DEFAULT_CONFIG.samplingIntervalUs,
    );
  });

  test("HAYVEN_TRACE_MODULE_ROOT overrides; empty string disables path hints", () => {
    expect(configFromEnv({}, {}).moduleRoot).toBe(DEFAULT_CONFIG.moduleRoot);
    expect(configFromEnv({}, { HAYVEN_TRACE_MODULE_ROOT: "/repo" }).moduleRoot).toBe("/repo");
    expect(configFromEnv({}, { HAYVEN_TRACE_MODULE_ROOT: "" }).moduleRoot).toBe("");
  });
});
