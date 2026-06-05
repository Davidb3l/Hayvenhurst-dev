/**
 * Hardware detection for the model strata — ARCHITECTURE.md §18.2 / §18.5.
 *
 * Pure + injectable: the real probes (`process.platform`, `os.*`, `nvidia-smi`)
 * are behind a `HardwareProbes` seam so the detection + recommendation logic
 * unit-tests deterministically without touching the host or shelling out.
 */
import { cpus, totalmem } from "node:os";

import { MODEL_REGISTRY, type ModelEntry } from "../models/registry.ts";

export type GpuBackend = "metal" | "cuda" | "cpu";

export interface HardwareInfo {
  platform: NodeJS.Platform;
  arch: string;
  totalRamMb: number;
  cores: number;
  gpu: GpuBackend;
}

export interface HardwareProbes {
  platform: () => NodeJS.Platform;
  arch: () => string;
  totalRamBytes: () => number;
  cores: () => number;
  /** True if an NVIDIA GPU + driver is present (nvidia-smi succeeds). */
  hasNvidiaSmi: () => boolean;
}

function probeNvidiaSmi(): boolean {
  try {
    // Bun.spawnSync is sync; nvidia-smi -L lists GPUs and exits 0 when present.
    const r = Bun.spawnSync(["nvidia-smi", "-L"], { stdout: "ignore", stderr: "ignore" });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

export const REAL_PROBES: HardwareProbes = {
  platform: () => process.platform,
  arch: () => process.arch,
  totalRamBytes: () => totalmem(),
  cores: () => cpus().length,
  hasNvidiaSmi: probeNvidiaSmi,
};

/**
 * Detect platform/arch/RAM/cores and the best available inference backend:
 * Apple-Silicon macOS → Metal; an NVIDIA GPU → CUDA; otherwise CPU. (§18.1's
 * default release ships CPU; Metal/CUDA are backend features.)
 */
export function detectHardware(probes: HardwareProbes = REAL_PROBES): HardwareInfo {
  const platform = probes.platform();
  const arch = probes.arch();

  let gpu: GpuBackend;
  if (platform === "darwin" && arch === "arm64") gpu = "metal";
  else if (probes.hasNvidiaSmi()) gpu = "cuda";
  else gpu = "cpu";

  return {
    platform,
    arch,
    totalRamMb: Math.round(probes.totalRamBytes() / (1024 * 1024)),
    cores: probes.cores(),
    gpu,
  };
}

/**
 * Recommend the **tier-3** (reflex) model for this hardware: the largest
 * registry tier-3 entry whose `minRamMb` fits in total RAM, falling back to the
 * smallest tier-3 entry if even that doesn't fit (it'll be slow, but the
 * graceful-heuristic fallback in §18.3 covers the can't-run case at runtime).
 * Only `loadable` entries are considered — `doctor` must never recommend a model
 * the native can't actually run (e.g. the `gemma4:*` entries, kept for a future
 * `quantized_gemma4` loader). Returns null only if there are no loadable tier-3
 * entries.
 */
export function recommendTier3Model(hw: HardwareInfo): ModelEntry | null {
  const tier3 = Object.values(MODEL_REGISTRY)
    .filter((m) => m.tier === 3 && m.loadable)
    .sort((a, b) => a.minRamMb - b.minRamMb); // ascending
  if (tier3.length === 0) return null;

  let best = tier3[0]!; // smallest as the floor
  for (const m of tier3) {
    if (hw.totalRamMb >= m.minRamMb) best = m; // largest that still fits
  }
  return best;
}
