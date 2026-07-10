import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareSemver,
  computeOk,
  doctorEnvelope,
  type DoctorCheck,
  type DoctorReport,
} from "../src/cli/doctor.ts";
import { VERSION } from "../src/version.ts";

describe("compareSemver", () => {
  it("compares major/minor/patch", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
  });

  it("strips pre-release suffixes", () => {
    expect(compareSemver("1.3.0-alpha", "1.3.0")).toBe(0);
  });

  it("handles different segment counts", () => {
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
    expect(compareSemver("1", "1.0.1")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// SUITE_CONTRACTS §3 discovery envelope. Peers (the Suite Hub, `sirius`) probe
// `hayven doctor --json` and read this shape; a drift here silently drops
// Hayvenhurst out of every suite roster, so pin it.
// ---------------------------------------------------------------------------

function reportFixture(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    ok: true,
    checks: [
      { name: "bun_version", ok: true, detail: "1.3.13 (required >= 1.3.0)", gating: true },
      { name: "hayven_native", ok: true, detail: "/usr/local/bin/hayven-native", gating: true },
      { name: "sqlite_fts5_trigram", ok: true, detail: "available", gating: true },
      { name: "tier3_model", ok: true, detail: "present", gating: false },
    ],
    hardware: {
      platform: "darwin",
      arch: "arm64",
      cores: 8,
      totalRamMb: 16384,
      gpu: "metal",
    } as DoctorReport["hardware"],
    recommendedTier3: "qwen2.5-coder-1.5b",
    projectRoot: "/repo",
    projectRootReason: "git-root",
    initialized: true,
    modelLines: [],
    ...overrides,
  };
}

// The gating fold is the novel decision in this design: a non-gating check may
// fail without dragging the envelope unhealthy. Test it where it can FAIL —
// `doctorEnvelope` only copies `report.ok`, so asserting on a pre-built report
// would prove nothing (docs/DESIGN_LESSONS.md: a test that cannot fail is not
// a test).
describe("computeOk (which checks gate health)", () => {
  const row = (name: string, ok: boolean, gating: boolean): DoctorCheck => ({
    name,
    ok,
    detail: "",
    gating,
  });

  it("stays healthy when a NON-gating check fails (missing tier-3 model degrades, not fails)", () => {
    expect(computeOk([row("bun_version", true, true), row("tier3_model", false, false)])).toBe(true);
  });

  it("goes unhealthy when a GATING check fails", () => {
    expect(computeOk([row("hayven_native", false, true), row("tier3_model", true, false)])).toBe(
      false,
    );
  });

  it("is healthy when everything passes", () => {
    expect(computeOk([row("bun_version", true, true), row("tier3_model", true, false)])).toBe(true);
  });
});

describe("doctor --json envelope (SUITE_CONTRACTS §3)", () => {
  it("carries the §3 fields with tool id 'hayven'", () => {
    const env = doctorEnvelope(reportFixture());
    // §3: `tool` is the CLI name exactly — a mismatch means the peer is absent.
    expect(env["tool"]).toBe("hayven");
    expect(env["schemaVersion"]).toBe(1);
    expect(env["ok"]).toBe(true);
    // Never hardcoded: the same version `hayven --version` prints.
    expect(env["version"]).toBe(VERSION);
    expect(Array.isArray(env["capabilities"])).toBe(true);
    expect(typeof env["report"]).toBe("object");
  });

  it("omits `ui` entirely — hayven serves no web UI (§3.2)", () => {
    const env = doctorEnvelope(reportFixture());
    expect("ui" in env).toBe(false);
    expect(env["capabilities"]).not.toContain("ui");
  });

  it("advertises only capabilities that exist today", () => {
    const env = doctorEnvelope(reportFixture());
    // `mcp` is real (`hayven mcp`). The event spine and `resolve` are not
    // implemented, so they must not be promised to peers.
    expect(env["capabilities"]).toEqual(["mcp"]);
    expect(env["capabilities"]).not.toContain("events.emit");
    expect(env["capabilities"]).not.toContain("events.consume");
    expect(env["capabilities"]).not.toContain("resolve");
  });

  it("emits {name, ok, detail} check rows with stable snake_case names", () => {
    const env = doctorEnvelope(reportFixture());
    const checks = env["checks"] as Array<Record<string, unknown>>;
    expect(checks.length).toBe(4);
    for (const c of checks) {
      expect(typeof c["name"]).toBe("string");
      expect(typeof c["ok"]).toBe("boolean");
      expect(typeof c["detail"]).toBe("string");
      expect(c["name"]).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
      // The internal `gating` flag stays internal — the wire rows are §3-exact.
      expect("gating" in c).toBe(false);
    }
    expect(checks.map((c) => c["name"])).toEqual([
      "bun_version",
      "hayven_native",
      "sqlite_fts5_trigram",
      "tier3_model",
    ]);
  });

  it("reports failure in `ok`, not by hiding the envelope (§3.1 present-but-unhealthy)", () => {
    const report = reportFixture({
      ok: false,
      checks: [
        { name: "bun_version", ok: true, detail: "1.3.13", gating: true },
        { name: "hayven_native", ok: false, detail: "NOT FOUND", gating: true },
        { name: "sqlite_fts5_trigram", ok: true, detail: "available", gating: true },
        { name: "tier3_model", ok: true, detail: "present", gating: false },
      ],
    });
    const env = doctorEnvelope(report);
    expect(env["ok"]).toBe(false);
    const native = (env["checks"] as Array<Record<string, unknown>>).find(
      (c) => c["name"] === "hayven_native",
    );
    expect(native?.["ok"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: §4 rule 1 — `--json` prints EXACTLY ONE JSON object on stdout.
// A stray log line makes the whole tool unparseable, hence "absent" per §3.1.
// ---------------------------------------------------------------------------

const CLI = join(import.meta.dir, "../src/cli.ts");

async function runCli(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

describe("doctor --json stdout discipline", () => {
  it("prints exactly one JSON object on stdout and exits 0", async () => {
    const { code, stdout } = await runCli(["doctor", "--json"]);
    expect(code).toBe(0);
    // Parses whole — no Markdown, no log lines, no second object.
    const env = JSON.parse(stdout) as Record<string, unknown>;
    expect(env["tool"]).toBe("hayven");
    expect("ui" in env).toBe(false);
    expect(stdout.trimEnd().split("\n").length).toBe(1);
  });

  it("stays ok:true even when the non-gating tier3_model row fails", async () => {
    // This repo has no tier-3 model pulled, so that row is genuinely ok:false.
    // The envelope must still report healthy — the whole point of `gating`.
    const { code, stdout } = await runCli(["doctor", "--json"]);
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as Record<string, unknown>;
    const checks = env["checks"] as Array<Record<string, unknown>>;
    const tier3 = checks.find((c) => c["name"] === "tier3_model");
    expect(tier3).toBeDefined();
    // Guard the guard: if a model ever IS present here, this test would be
    // vacuous — assert the coupling only in the state that can disprove it.
    if (tier3?.["ok"] === false) {
      expect(env["ok"]).toBe(true);
    }
    // Gating rows and the envelope must always agree.
    for (const name of ["bun_version", "hayven_native", "sqlite_fts5_trigram"]) {
      const row = checks.find((c) => c["name"] === name);
      if (row?.["ok"] === false) expect(env["ok"]).toBe(false);
    }
  });

  it("emits an ok:false envelope (exit 0) when doctor cannot even run its checks", async () => {
    // A malformed .hayven/config.json makes collect() throw. Without the guard
    // this exits 1 with empty stdout, and §3.1 makes consumers call an
    // INSTALLED-but-misconfigured hayven "absent" instead of unhealthy.
    const repo = mkdtempSync(join(tmpdir(), "hayven-doctor-badcfg-"));
    mkdirSync(join(repo, ".hayven"), { recursive: true });
    writeFileSync(join(repo, ".hayven", "config.json"), "{ this is not json");

    const { code, stdout } = await runCli(["doctor", "--json"], {}, repo);
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as Record<string, unknown>;
    expect(env["tool"]).toBe("hayven");
    expect(env["ok"]).toBe(false);
    expect(env["version"]).toBe(VERSION);
  });

  it("stays parseable and exits 0 when a check fails (present-but-unhealthy)", async () => {
    // Hide `hayven-native` from every lookup path so the check genuinely fails.
    const { code, stdout } = await runCli(["doctor", "--json"], {
      HAYVEN_NATIVE_BIN: "/nonexistent/bogus",
      PATH: "/usr/bin:/bin",
    });
    expect(code).toBe(0); // §3.1: unhealthy is NOT absent.
    const env = JSON.parse(stdout) as Record<string, unknown>;
    expect(env["ok"]).toBe(false);
    const native = (env["checks"] as Array<Record<string, unknown>>).find(
      (c) => c["name"] === "hayven_native",
    );
    expect(native?.["ok"]).toBe(false);
  });

  it("human mode still exits 1 on a failing check (CI/shell gate)", async () => {
    const { code } = await runCli(["doctor"], {
      HAYVEN_NATIVE_BIN: "/nonexistent/bogus",
      PATH: "/usr/bin:/bin",
    });
    expect(code).toBe(1);
  });
});
