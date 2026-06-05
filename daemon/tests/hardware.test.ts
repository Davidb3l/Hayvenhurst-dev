// Hardware detection + tier-3 recommendation — ARCHITECTURE.md §18.2/§18.5.
// Probes are injected so the logic is deterministic without touching the host.
import { describe, expect, test } from "bun:test";

import {
  detectHardware,
  recommendTier3Model,
  type HardwareProbes,
} from "../src/hardware/detect.ts";

function probes(over: {
  platform?: NodeJS.Platform;
  arch?: string;
  ramMb?: number;
  cores?: number;
  nvidia?: boolean;
} = {}): HardwareProbes {
  return {
    platform: () => over.platform ?? "linux",
    arch: () => over.arch ?? "x64",
    totalRamBytes: () => (over.ramMb ?? 16384) * 1024 * 1024,
    cores: () => over.cores ?? 8,
    hasNvidiaSmi: () => over.nvidia ?? false,
  };
}

describe("detectHardware", () => {
  test("Apple Silicon → Metal", () => {
    const hw = detectHardware(probes({ platform: "darwin", arch: "arm64" }));
    expect(hw.gpu).toBe("metal");
    expect(hw.platform).toBe("darwin");
  });

  test("Intel mac (no arm) → not Metal; falls to cpu without nvidia", () => {
    const hw = detectHardware(probes({ platform: "darwin", arch: "x64", nvidia: false }));
    expect(hw.gpu).toBe("cpu");
  });

  test("NVIDIA present → CUDA (non-Apple)", () => {
    const hw = detectHardware(probes({ platform: "linux", arch: "x64", nvidia: true }));
    expect(hw.gpu).toBe("cuda");
  });

  test("no GPU → cpu", () => {
    const hw = detectHardware(probes({ platform: "win32", arch: "x64", nvidia: false }));
    expect(hw.gpu).toBe("cpu");
  });

  test("Apple Silicon wins even if nvidia-smi somehow answered", () => {
    const hw = detectHardware(probes({ platform: "darwin", arch: "arm64", nvidia: true }));
    expect(hw.gpu).toBe("metal");
  });

  test("RAM is reported in MB, cores passed through", () => {
    const hw = detectHardware(probes({ ramMb: 32768, cores: 12 }));
    expect(hw.totalRamMb).toBe(32768);
    expect(hw.cores).toBe(12);
  });
});

describe("recommendTier3Model", () => {
  // Only `loadable` tier-3 entries are recommendable; the `gemma4:*` entries are
  // loadable:false (no quantized_gemma4 loader), so the one loadable tier-3 entry
  // today is the verified gemma3:1b. doctor must never suggest a model that can't run.
  test("ample RAM → a loadable tier-3 model (gemma3:1b), never an unloadable gemma4", () => {
    const hw = detectHardware(probes({ ramMb: 16384 }));
    const m = recommendTier3Model(hw);
    expect(m?.id).toBe("gemma3:1b");
    expect(m?.tier).toBe(3);
    expect(m?.loadable).toBe(true);
  });

  test("below the smallest floor → still returns the loadable model (graceful, §18.3)", () => {
    const hw = detectHardware(probes({ ramMb: 1024 }));
    expect(recommendTier3Model(hw)?.id).toBe("gemma3:1b");
  });

  test("never recommends an unloadable (gemma4:*) or a tier-2 model", () => {
    const hw = detectHardware(probes({ ramMb: 65536 }));
    const m = recommendTier3Model(hw);
    expect(m?.tier).toBe(3);
    expect(m?.loadable).toBe(true);
    expect(m?.id.startsWith("gemma4")).toBe(false);
  });
});
