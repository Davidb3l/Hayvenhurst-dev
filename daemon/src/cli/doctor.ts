/**
 * `hayven doctor` — diagnostic: Bun version, native binary, FTS5 support, and
 * the model strata (hardware detection + tier-3 model presence, §18.5).
 */
import { existsSync } from "node:fs";

import { tryLocateNativeBinary } from "../native/locate.ts";
import { Db } from "../db/queries.ts";
import { ftsAvailable } from "../db/migrations.ts";
import { detectRepoRoot, hayvenPathsFor } from "../util/paths.ts";
import { loadConfig } from "../config/load.ts";
import { detectHardware, recommendTier3Model } from "../hardware/detect.ts";
import { MODEL_REGISTRY, isModelPresent, modelPath } from "../models/registry.ts";
import type { ParsedArgs } from "../cli.ts";

const REQUIRED_BUN = "1.3.0";

export async function runDoctor(_args: ParsedArgs): Promise<number> {
  const lines: string[] = ["# hayven doctor", ""];
  let ok = true;

  // Bun version
  const bunVersion = typeof Bun !== "undefined" ? Bun.version : "unknown";
  const bunOk = compareSemver(bunVersion, REQUIRED_BUN) >= 0;
  lines.push(`- Bun version: ${bunVersion} (required >= ${REQUIRED_BUN})  ${bunOk ? "OK" : "FAIL"}`);
  if (!bunOk) ok = false;

  // Native binary
  const native = tryLocateNativeBinary();
  if (native) {
    lines.push(`- hayven-native: ${native}  OK`);
  } else {
    lines.push("- hayven-native: NOT FOUND  FAIL");
    lines.push("    Build with:  cd native && cargo build --release");
    ok = false;
  }

  // SQLite FTS5 + trigram
  try {
    const db = new Db(":memory:");
    const hasFts = ftsAvailable(db.handle);
    db.close();
    lines.push(`- SQLite FTS5 trigram: ${hasFts ? "OK" : "UNAVAILABLE (need SQLite >= 3.34)"}`);
    if (!hasFts) ok = false;
  } catch (err) {
    lines.push(`- SQLite probe failed: ${(err as Error).message}  FAIL`);
    ok = false;
  }

  // Model strata — hardware detection + tier-3 model presence (§18.5).
  lines.push("");
  lines.push("## Model strata (§18)");
  const hw = detectHardware();
  lines.push(
    `- Hardware: ${hw.platform}/${hw.arch}, ${hw.cores} cores, ` +
      `${(hw.totalRamMb / 1024).toFixed(1)} GB RAM, GPU backend: ${hw.gpu}`,
  );
  const rec = recommendTier3Model(hw);
  if (rec) {
    lines.push(`- Recommended tier-3 model: ${rec.id} (${rec.params}, needs ~${(rec.minRamMb / 1024).toFixed(1)} GB)`);
  }

  // Report the resolved project root + reason so the operator knows which tree
  // we're inspecting (audit H2). When there's no initialized project here, the
  // model-presence check is per-project and would inspect the wrong/empty dir —
  // so we say so explicitly instead of printing a misleading PRESENT/NOT-FOUND.
  const { root, reason } = detectRepoRoot();
  const hayvenDir = hayvenPathsFor(root).hayvenDir;
  const initialized = existsSync(hayvenDir);
  lines.push(`- Project root: ${root} (${reason})`);
  if (!initialized) {
    lines.push("- Project: NOT INITIALIZED here — run `hayven init`.");
    lines.push("    Model presence is per-project; nothing to report until the project exists.");
  } else {
    const configuredTier3 = loadConfig(root).config.models.tier3.model;
    const entry = MODEL_REGISTRY[configuredTier3];
    if (!entry) {
      lines.push(`- Configured tier-3 model "${configuredTier3}": UNKNOWN (not in the model registry)`);
    } else if (isModelPresent(hayvenDir, configuredTier3)) {
      lines.push(`- Configured tier-3 model "${configuredTier3}": PRESENT  OK`);
      lines.push("    Layer C will use the LLM oracle.");
    } else {
      lines.push(`- Configured tier-3 model "${configuredTier3}": NOT DOWNLOADED`);
      lines.push(`    Expected at: ${modelPath(hayvenDir, configuredTier3)}`);
      lines.push(`    Pull with:   hayven models pull ${configuredTier3}`);
      lines.push("    Until then, Layer C uses the deterministic heuristic-v1 oracle (no LLM).");
    }
  }

  lines.push("");
  lines.push(ok ? "All checks passed." : "Some checks failed — see above.");
  process.stdout.write(lines.join("\n") + "\n");
  return ok ? 0 : 1;
}

/** Tiny semver comparator. Returns -1/0/1. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number(s.replace(/[^0-9].*$/, "")) || 0);
  const pb = b.split(".").map((s) => Number(s.replace(/[^0-9].*$/, "")) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
