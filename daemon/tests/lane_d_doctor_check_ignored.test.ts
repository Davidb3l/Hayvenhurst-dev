/**
 * LANE D — `hayven doctor` must surface check-ignored version skew.
 *
 * The packer's gitignore gate (`src/native/ignore.ts`) is FAIL-CLOSED: a
 * `hayven-native` built before the `check-ignored` subcommand existed (clap
 * exits 2 on an unknown subcommand) makes the packer refuse EVERY file read,
 * announced only by a one-time stderr warning that stdio MCP users never see.
 * These tests pin the two visibility fixes:
 *
 *   1. `doctor` grows a `native_check_ignored` row that probes the SAME binary
 *      the gate would spawn and classifies OK / STALE_BINARY / ERROR — while
 *      `doctor --json` keeps the SUITE_CONTRACTS §3 posture (ALWAYS exit 0,
 *      health in `ok`; peers read a nonzero exit as "tool absent").
 *   2. The gate's one-time warning, in the stale-binary case, names the binary
 *      path, says ALL reads are refused, and points at `hayven doctor`.
 *
 * The stale binary is faked the way lane B fakes native binaries: a tiny shell
 * shim behind $HAYVEN_NATIVE_BIN (the locator's first candidate), exiting 2
 * exactly as clap does for an unknown subcommand.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isPathExcludedByWalker,
  locateCheckIgnoredBinary,
  probeCheckIgnored,
  resetWalkerExclusionCache,
} from "../src/native/ignore.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `hayven-laned-${tag}-`));
  dirs.push(root);
  return root;
}

/** A shim that exits 2 on `check-ignored` — clap's unknown-subcommand exit,
 *  i.e. any binary built before this WIP. */
function makeStaleBinary(): string {
  const dir = tmpRoot("stalebin");
  const bin = join(dir, "hayven-native");
  writeFileSync(bin, "#!/bin/sh\nexit 2\n");
  chmodSync(bin, 0o755);
  return bin;
}

/** A shim that fails for a reason that is NOT version skew: runs, exits 1. */
function makeBrokenBinary(): string {
  const dir = tmpRoot("brokenbin");
  const bin = join(dir, "hayven-native");
  writeFileSync(bin, "#!/bin/sh\necho boom >&2\nexit 1\n");
  chmodSync(bin, 0o755);
  return bin;
}

async function runDoctorJson(
  env: Record<string, string>,
): Promise<{ code: number; envelope: Record<string, unknown>; stdout: string }> {
  const proc = Bun.spawn([process.execPath, CLI, "doctor", "--json"], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, envelope: JSON.parse(stdout) as Record<string, unknown>, stdout };
}

function checkByName(
  envelope: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  return (envelope["checks"] as Array<Record<string, unknown>>).find((c) => c["name"] === name);
}

// ---------------------------------------------------------------------------
// The probe itself (unit level): classification mirrors the gate's taxonomy.
// ---------------------------------------------------------------------------

describe("probeCheckIgnored classification", () => {
  it("classifies a clap exit-2 shim as stale_binary", () => {
    expect(probeCheckIgnored(makeStaleBinary())).toEqual({ state: "stale_binary" });
  });

  it("classifies a nonzero-but-not-2 exit as error, with the exit named", () => {
    const probe = probeCheckIgnored(makeBrokenBinary());
    expect(probe.state).toBe("error");
    if (probe.state === "error") expect(probe.message).toContain("exit 1");
  });

  it("classifies an unrunnable file as error, not stale_binary", () => {
    const dir = tmpRoot("noexec");
    const bin = join(dir, "hayven-native");
    writeFileSync(bin, "not an executable\n");
    chmodSync(bin, 0o644);
    expect(probeCheckIgnored(bin).state).toBe("error");
  });

  it("classifies a well-formed but wrong-arity response as error", () => {
    // Exit 0 with an `ignored` array that does not answer the one path asked
    // about — the gate would fail closed on this, so the probe must not say OK.
    const dir = tmpRoot("liarbin");
    const bin = join(dir, "hayven-native");
    writeFileSync(bin, '#!/bin/sh\necho \'{"ignored":[]}\'\n');
    chmodSync(bin, 0o755);
    expect(probeCheckIgnored(bin).state).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// STALE_BINARY through the real CLI: the envelope shape and the §3 exit-0
// contract, with the fake stale binary planted as the locator's first hit.
// ---------------------------------------------------------------------------

describe("doctor --json with a stale native binary", () => {
  it("exits 0, reports ok:false, and names the binary in native_check_ignored", async () => {
    const stale = makeStaleBinary();
    const { code, envelope, stdout } = await runDoctorJson({ HAYVEN_NATIVE_BIN: stale });

    // §3.1: unhealthy is NOT absent — a failing check must never leak into the
    // exit code, and stdout stays exactly one JSON object.
    expect(code).toBe(0);
    expect(stdout.trimEnd().split("\n").length).toBe(1);

    const row = checkByName(envelope, "native_check_ignored");
    expect(row).toBeDefined();
    expect(row?.["ok"]).toBe(false);
    const detail = row?.["detail"] as string;
    expect(detail).toContain("STALE_BINARY");
    expect(detail).toContain(stale); // the offending path, named
    expect(detail.toLowerCase()).toMatch(/rebuild|reinstall/);

    // The binary EXISTS, so hayven_native alone stays green — this row is the
    // only one that can catch the skew, which is the whole point of adding it.
    expect(checkByName(envelope, "hayven_native")?.["ok"]).toBe(true);

    // A packer that refuses every read is a broken tool: the row gates.
    expect(envelope["ok"]).toBe(false);
  });

  it("emits the row in the same §3 wire shape as every other check", async () => {
    const { envelope } = await runDoctorJson({ HAYVEN_NATIVE_BIN: makeStaleBinary() });
    const row = checkByName(envelope, "native_check_ignored");
    expect(row).toBeDefined();
    // §3-exact rows: {name, ok, detail}, snake_case name, no internal fields.
    expect(Object.keys(row!).sort()).toEqual(["detail", "name", "ok"]);
    expect(row!["name"]).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    expect(typeof row!["ok"]).toBe("boolean");
    expect(typeof row!["detail"]).toBe("string");
  });

  it("classifies a runs-but-fails binary as ERROR, not STALE_BINARY", async () => {
    const { code, envelope } = await runDoctorJson({ HAYVEN_NATIVE_BIN: makeBrokenBinary() });
    expect(code).toBe(0);
    const detail = checkByName(envelope, "native_check_ignored")?.["detail"] as string;
    expect(detail).toContain("ERROR");
    expect(detail).not.toContain("STALE_BINARY");
  });
});

// ---------------------------------------------------------------------------
// OK path against the REAL binary, when this checkout provides one. The same
// skipIf posture as fix_f: absent binary skips rather than fails, because a
// fresh clone without `cargo build` is a supported state for the TS suite.
// ---------------------------------------------------------------------------

const realBinary = locateCheckIgnoredBinary();

describe("doctor --json with the real native binary", () => {
  it.skipIf(realBinary === null)("reports native_check_ignored ok:true", async () => {
    const { code, envelope } = await runDoctorJson({});
    expect(code).toBe(0);
    const row = checkByName(envelope, "native_check_ignored");
    expect(row?.["ok"]).toBe(true);
    expect(row?.["detail"]).toContain("OK");
  });

  it.skipIf(realBinary === null)("probeCheckIgnored agrees: state ok", () => {
    expect(probeCheckIgnored(realBinary!)).toEqual({ state: "ok" });
  });
});

// ---------------------------------------------------------------------------
// The gate's own one-time warning, stale-binary flavour: names the path, says
// ALL reads are refused, points at doctor. This is the in-process half of the
// fix — the message a daemon log actually shows when the packer goes dark.
// ---------------------------------------------------------------------------

describe("the fail-closed warning for a stale binary", () => {
  const ORIGINAL = process.env["HAYVEN_NATIVE_BIN"];
  const originalError = console.error;
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env["HAYVEN_NATIVE_BIN"];
    else process.env["HAYVEN_NATIVE_BIN"] = ORIGINAL;
    console.error = originalError;
    resetWalkerExclusionCache();
  });
  beforeEach(() => {
    resetWalkerExclusionCache();
  });

  function captureWarnings(fn: () => void): string[] {
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      fn();
    } finally {
      console.error = originalError;
    }
    return captured;
  }

  it("names the binary, the total refusal, and hayven doctor — exactly once", () => {
    const stale = makeStaleBinary();
    const repo = tmpRoot("repo");
    process.env["HAYVEN_NATIVE_BIN"] = stale;
    resetWalkerExclusionCache();

    const warnings = captureWarnings(() => {
      // Fails closed, twice — but warns once.
      expect(isPathExcludedByWalker(repo, "src/a.ts")).toBe(true);
      expect(isPathExcludedByWalker(repo, "other/b.ts")).toBe(true);
    });

    expect(warnings.length).toBe(1);
    const msg = warnings[0]!;
    expect(msg).toContain(stale); // WHICH binary is old
    expect(msg).toContain("check-ignored");
    expect(msg).toContain("ALL"); // blast radius, stated plainly
    expect(msg).toContain("REFUSED");
    expect(msg).toContain("hayven doctor"); // where to reproduce the verdict
  });

  it("a non-skew failure still gets the generic warning, not the stale one", () => {
    const broken = makeBrokenBinary();
    const repo = tmpRoot("repo2");
    process.env["HAYVEN_NATIVE_BIN"] = broken;
    resetWalkerExclusionCache();

    const warnings = captureWarnings(() => {
      expect(isPathExcludedByWalker(repo, "src/a.ts")).toBe(true);
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]!).toContain("cannot evaluate .gitignore");
    expect(warnings[0]!).not.toContain("does not support");
  });
});
