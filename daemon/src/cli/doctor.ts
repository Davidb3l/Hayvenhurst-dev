/**
 * `hayven doctor [--json]` — diagnostic: Bun version, native binary, FTS5
 * support, and the model strata (hardware detection + tier-3 model presence,
 * §18.5).
 *
 * With `--json` it emits the suite discovery handshake envelope
 * (SUITE_CONTRACTS §3, `schemaVersion: 1`) so peers — the Suite Hub, `sirius`,
 * `catryna` — can discover Hayvenhurst without tool-specific knowledge.
 * Per §4 rule 1 that means EXACTLY ONE JSON object on stdout and nothing else;
 * any diagnostic chatter goes to stderr.
 */
import { existsSync } from "node:fs";

import { tryLocateNativeBinary } from "../native/locate.ts";
import { Db } from "../db/queries.ts";
import { ftsAvailable } from "../db/migrations.ts";
import { detectRepoRoot, hayvenPathsFor } from "../util/paths.ts";
import { loadConfig } from "../config/load.ts";
import { detectHardware, recommendTier3Model } from "../hardware/detect.ts";
import { MODEL_REGISTRY, isModelPresent, modelPath } from "../models/registry.ts";
import { VERSION } from "../version.ts";
import { isJson } from "./_shared.ts";
import type { ParsedArgs } from "../cli.ts";

const REQUIRED_BUN = "1.3.0";

/**
 * Capabilities Hayvenhurst ACTUALLY implements today (SUITE_CONTRACTS §3).
 *
 * Deliberately conservative — a capability string is a promise a peer will act
 * on, so it is added only when the feature exists:
 *   - `mcp`  — `hayven mcp` serves the stateless MCP context server.
 * NOT advertised (and so, not in the §6 checklist yet): `events.emit` /
 * `events.consume` (the `.suite/` spine is unimplemented) and `resolve`.
 *
 * `ui` is intentionally ABSENT: per §3.2 a tool with no web UI omits both the
 * capability and the top-level `ui` field, and the spec's port table lists
 * hayven as "(no web UI in v0)". The daemon does serve a graph viewer on
 * :7777, but only while it is running, whereas doctor answers daemonlessly —
 * advertising a `ui` that is usually unreachable would mislead consumers.
 */
const CAPABILITIES: readonly string[] = ["mcp"];

/** One §3 check row: a stable snake_case name, its state, and a human detail. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /**
   * Whether this check gates overall health. The tier-3 model check does not:
   * a missing model degrades Layer C to the deterministic heuristic oracle,
   * which is a supported configuration, not a failure. Everything else does.
   */
  gating: boolean;
}

/** Everything doctor learned, rendered by either the human or JSON path. */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  /** Free-form, additive detail for the envelope's `report` field. */
  hardware: ReturnType<typeof detectHardware>;
  recommendedTier3: string | null;
  projectRoot: string;
  projectRootReason: string;
  initialized: boolean;
  /** Human-path lines for the model-strata section (kept byte-identical). */
  modelLines: string[];
}

/**
 * Overall health = the GATING checks only, matching what the human path has
 * always reported. A missing tier-3 model degrades Layer C to the deterministic
 * heuristic oracle — a supported configuration, not a failure — so its row can
 * be `ok:false` while the envelope stays `ok:true`.
 *
 * Exported so the fold is directly testable: a non-gating failure MUST NOT
 * drag the envelope unhealthy, and a gating one MUST.
 */
export function computeOk(checks: readonly DoctorCheck[]): boolean {
  return checks.every((c) => !c.gating || c.ok);
}

/** Run every check. Pure of output: neither path prints from here. */
function collect(): DoctorReport {
  const checks: DoctorCheck[] = [];

  // Bun version
  const bunVersion = typeof Bun !== "undefined" ? Bun.version : "unknown";
  const bunOk = compareSemver(bunVersion, REQUIRED_BUN) >= 0;
  checks.push({
    name: "bun_version",
    ok: bunOk,
    detail: `${bunVersion} (required >= ${REQUIRED_BUN})`,
    gating: true,
  });

  // Native binary
  const native = tryLocateNativeBinary();
  checks.push({
    name: "hayven_native",
    ok: native !== null,
    detail: native ?? "NOT FOUND — build with: cd native && cargo build --release",
    gating: true,
  });

  // SQLite FTS5 + trigram
  try {
    const db = new Db(":memory:");
    const hasFts = ftsAvailable(db.handle);
    db.close();
    checks.push({
      name: "sqlite_fts5_trigram",
      ok: hasFts,
      detail: hasFts ? "available" : "UNAVAILABLE (need SQLite >= 3.34)",
      gating: true,
    });
  } catch (err) {
    checks.push({
      name: "sqlite_fts5_trigram",
      ok: false,
      detail: `probe failed: ${(err as Error).message}`,
      gating: true,
    });
  }

  // Model strata — hardware detection + tier-3 model presence (§18.5).
  const hw = detectHardware();
  const rec = recommendTier3Model(hw);
  const modelLines: string[] = [];
  modelLines.push(
    `- Hardware: ${hw.platform}/${hw.arch}, ${hw.cores} cores, ` +
      `${(hw.totalRamMb / 1024).toFixed(1)} GB RAM, GPU backend: ${hw.gpu}`,
  );
  if (rec) {
    modelLines.push(
      `- Recommended tier-3 model: ${rec.id} (${rec.params}, needs ~${(rec.minRamMb / 1024).toFixed(1)} GB)`,
    );
  }

  const { root, reason } = detectRepoRoot();
  const hayvenDir = hayvenPathsFor(root).hayvenDir;
  const initialized = existsSync(hayvenDir);
  modelLines.push(`- Project root: ${root} (${reason})`);

  let modelCheck: DoctorCheck;
  if (!initialized) {
    modelLines.push("- Project: NOT INITIALIZED here — run `hayven init`.");
    modelLines.push(
      "    Model presence is per-project; nothing to report until the project exists.",
    );
    modelCheck = {
      name: "tier3_model",
      ok: true,
      detail: "project not initialized here; model presence is per-project",
      gating: false,
    };
  } else {
    const configuredTier3 = loadConfig(root).config.models.tier3.model;
    const entry = MODEL_REGISTRY[configuredTier3];
    if (!entry) {
      modelLines.push(`- Configured tier-3 model "${configuredTier3}": UNKNOWN (not in the model registry)`);
      modelCheck = {
        name: "tier3_model",
        ok: false,
        detail: `configured model "${configuredTier3}" is not in the model registry`,
        gating: false,
      };
    } else if (isModelPresent(hayvenDir, configuredTier3)) {
      modelLines.push(`- Configured tier-3 model "${configuredTier3}": PRESENT  OK`);
      modelLines.push("    Layer C will use the LLM oracle.");
      modelCheck = {
        name: "tier3_model",
        ok: true,
        detail: `"${configuredTier3}" present; Layer C uses the LLM oracle`,
        gating: false,
      };
    } else {
      modelLines.push(`- Configured tier-3 model "${configuredTier3}": NOT DOWNLOADED`);
      modelLines.push(`    Expected at: ${modelPath(hayvenDir, configuredTier3)}`);
      modelLines.push(`    Pull with:   hayven models pull ${configuredTier3}`);
      modelLines.push("    Until then, Layer C uses the deterministic heuristic-v1 oracle (no LLM).");
      modelCheck = {
        name: "tier3_model",
        ok: false,
        detail:
          `"${configuredTier3}" not downloaded (hayven models pull ${configuredTier3}); ` +
          "Layer C falls back to the deterministic heuristic-v1 oracle",
        gating: false,
      };
    }
  }
  checks.push(modelCheck);

  return {
    ok: computeOk(checks),
    checks,
    hardware: hw,
    recommendedTier3: rec ? rec.id : null,
    projectRoot: root,
    projectRootReason: reason,
    initialized,
    modelLines,
  };
}

/**
 * The SUITE_CONTRACTS §3 handshake envelope. Health lives in `ok`, never in the
 * exit code (§3.1: exit 0 + `ok:false` = present-but-unhealthy; a non-zero exit
 * means absent). `report` is free-form, additive detail.
 */
export function doctorEnvelope(report: DoctorReport): Record<string, unknown> {
  return {
    tool: "hayven",
    version: VERSION,
    schemaVersion: 1,
    ok: report.ok,
    capabilities: [...CAPABILITIES],
    checks: report.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
    report: {
      hardware: report.hardware,
      recommended_tier3_model: report.recommendedTier3,
      project_root: report.projectRoot,
      project_root_reason: report.projectRootReason,
      initialized: report.initialized,
    },
  };
}

/** The human report — unchanged from before `--json` existed. */
function renderHuman(report: DoctorReport): string {
  const lines: string[] = ["# hayven doctor", ""];
  // collect() always pushes all four rows; throw loudly rather than render a
  // half-report if a future check is added to only one path.
  const byName = (n: string): DoctorCheck => {
    const c = report.checks.find((x) => x.name === n);
    if (!c) throw new Error(`doctor: missing check '${n}'`);
    return c;
  };

  const bun = byName("bun_version");
  lines.push(`- Bun version: ${bun.detail}  ${bun.ok ? "OK" : "FAIL"}`);

  const native = byName("hayven_native");
  if (native.ok) {
    lines.push(`- hayven-native: ${native.detail}  OK`);
  } else {
    lines.push("- hayven-native: NOT FOUND  FAIL");
    lines.push("    Build with:  cd native && cargo build --release");
  }

  const fts = byName("sqlite_fts5_trigram");
  if (fts.detail.startsWith("probe failed: ")) {
    lines.push(`- SQLite probe failed: ${fts.detail.slice("probe failed: ".length)}  FAIL`);
  } else {
    lines.push(`- SQLite FTS5 trigram: ${fts.ok ? "OK" : "UNAVAILABLE (need SQLite >= 3.34)"}`);
  }

  lines.push("");
  lines.push("## Model strata (§18)");
  lines.push(...report.modelLines);

  lines.push("");
  lines.push(report.ok ? "All checks passed." : "Some checks failed — see above.");
  return lines.join("\n") + "\n";
}

/**
 * The envelope for a doctor run that could not even complete its checks — a
 * malformed `.hayven/config.json`, an unreadable repo root. Without this, the
 * throw escapes, stdout stays empty, and §3.1 makes every consumer classify an
 * INSTALLED-but-misconfigured Hayvenhurst as *absent* (with a stack trace).
 * Reporting `ok:false` with the reason keeps it visible as present-unhealthy.
 */
function envelopeForCollectFailure(err: Error): Record<string, unknown> {
  return {
    tool: "hayven",
    version: VERSION,
    schemaVersion: 1,
    ok: false,
    capabilities: [...CAPABILITIES],
    checks: [
      {
        name: "doctor_ran",
        ok: false,
        detail: `doctor could not complete its checks: ${err.message}`,
      },
    ],
    report: { error: err.message },
  };
}

export async function runDoctor(args: ParsedArgs): Promise<number> {
  if (isJson(args.flags)) {
    let envelope: Record<string, unknown>;
    try {
      envelope = doctorEnvelope(collect());
    } catch (err) {
      // Diagnostics go to stderr — stdout must carry the envelope alone (§4).
      process.stderr.write(`doctor: ${(err as Error).message}\n`);
      envelope = envelopeForCollectFailure(err as Error);
    }
    // §4 rule 1: exactly one JSON object on stdout, nothing else.
    process.stdout.write(JSON.stringify(envelope) + "\n");
    // §3/§3.1: an envelope was produced, so this probe SUCCEEDED — health is
    // carried by `ok`. Exiting non-zero here would make an installed but
    // degraded Hayvenhurst indistinguishable from an uninstalled one
    // ("absent"), hiding the very checks the envelope exists to report.
    return 0;
  }

  // Human mode is unchanged, including letting a collect() failure propagate
  // as it always has (`main` prints it and exits non-zero).
  const report = collect();
  process.stdout.write(renderHuman(report));
  // Keep the historical contract so `hayven doctor` remains a usable CI/shell
  // gate (§4's operational exit codes).
  return report.ok ? 0 : 1;
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
