/**
 * `$HOME` is never a project — enforced at every layer, not just the registry.
 *
 * The registry guard only stops a bad root from being PERSISTED. The damage in
 * the original incident (98% CPU, 195 GB read, a 593 MB index) came from
 * WALKING and INDEXING the home tree, and the daemonless commands do that
 * without ever touching the registry. These tests pin the other two layers:
 * `requireProject` (every daemonless command) and the SessionStart shell hook.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { requireProject } from "../src/cli/_shared.ts";
import { detectRepoRoot } from "../src/util/paths.ts";

let home: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  home = mkdtempSync(join(tmpdir(), "hayven-homeguard-"));
  process.env["HAYVEN_HOME"] = home;
  // The GLOBAL config dir — the thing that makes `[ -d .hayven ]` say "project".
  mkdirSync(join(home, ".hayven"), { recursive: true });
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  rmSync(home, { recursive: true, force: true });
});

describe("requireProject", () => {
  it("refuses the home dir even though ~/.hayven exists", () => {
    // Without the guard this SUCCEEDS: detectRepoRoot falls through to
    // cwd-fallback, paths.hayvenDir resolves to ~/.hayven, and existsSync
    // passes because that is the global config dir. Then `hayven ingest`,
    // `reindex`, `view`, `mcp`, `proxy` each walk the entire home tree.
    expect(() => requireProject(home)).toThrow(/Refusing to operate/i);
  });

  it("still resolves a real project under home", () => {
    const proj = join(home, "proj");
    mkdirSync(join(proj, ".hayven"), { recursive: true });
    expect(requireProject(proj).paths.repoRoot).toBe(proj);
  });

  it("gives the normal not-a-project error outside home", () => {
    const bare = mkdtempSync(join(tmpdir(), "hayven-bare-"));
    expect(() => requireProject(bare)).toThrow(/No \.hayven\/ directory found/i);
    rmSync(bare, { recursive: true, force: true });
  });
});

describe("detectRepoRoot guards both notions of home", () => {
  it("does not treat $HAYVEN_HOME's global .hayven as a project root", () => {
    const got = detectRepoRoot(home);
    expect(got.reason).toBe("cwd-fallback");
  });

  it("honors an injected homeDir over the ambient ones", () => {
    // NOTE what this does and does NOT prove. `{ homeDir }` REPLACES both
    // ambient arms, so it cannot distinguish `homedir()` from
    // `hayvenHomeDir()` — an earlier version of this test claimed to cover the
    // relocated-state case and mutation-testing showed it survived deleting
    // the `homedir()` arm entirely. The ambient arms are pinned in
    // "both ambient home arms" below, which needs a child process.
    const injected = mkdtempSync(join(tmpdir(), "hayven-injectedhome-"));
    mkdirSync(join(injected, ".hayven"), { recursive: true });
    expect(detectRepoRoot(injected, { homeDir: injected }).reason).not.toBe("hayven");
    rmSync(injected, { recursive: true, force: true });
  });
});

/**
 * Both AMBIENT arms of the home guard — `homedir()` and `hayvenHomeDir()` —
 * pinned separately, in `registry.ts` and in `paths.ts`.
 *
 * These need a CHILD PROCESS. Bun resolves `os.homedir()` once per process from
 * `$HOME` at startup, so an in-process test cannot move it; every other test in
 * this repo therefore sandboxes via `$HAYVEN_HOME` and exercises only that arm.
 * Mutation-testing confirmed the consequence: reducing `homes` to just
 * `hayvenHomeDir()` in EITHER file survived the entire suite. Passing
 * `{ homeDir }` does not help — it replaces both arms at once.
 *
 * A child gets `HOME` and `HAYVEN_HOME` pointed at two DIFFERENT fixture dirs,
 * so each arm is independently observable. Nothing real is touched.
 */
describe("both ambient home arms", () => {
  const registrySrc = join(dirname(import.meta.dir), "src", "daemon", "registry.ts");
  const pathsSrc = join(dirname(import.meta.dir), "src", "util", "paths.ts");

  const probe = (): Record<string, unknown> => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "hayven-arms-")));
    // `realHome` stands in for `homedir()`; `stateHome` for `hayvenHomeDir()`.
    // Both carry a `.hayven/` — that is the whole conflation: it is the GLOBAL
    // config dir, and any "am I in a project?" check reads it as a marker.
    const realHome = join(base, "real-home");
    const stateHome = join(base, "state-home");
    const repo = join(realHome, "proj");
    for (const d of [realHome, stateHome, repo]) mkdirSync(join(d, ".hayven"), { recursive: true });

    const script = join(base, "probe.ts");
    writeFileSync(
      script,
      `import { homedir } from "node:os";\n` +
        `import { isRegistrableRoot } from ${JSON.stringify(registrySrc)};\n` +
        `import { detectRepoRoot, hayvenHomeDir } from ${JSON.stringify(pathsSrc)};\n` +
        `const [realHome, stateHome, repo] = process.argv.slice(2);\n` +
        `console.log(JSON.stringify({\n` +
        `  seenHome: homedir(), seenStateHome: hayvenHomeDir(),\n` +
        `  realHomeRegistrable: isRegistrableRoot(realHome),\n` +
        `  stateHomeRegistrable: isRegistrableRoot(stateHome),\n` +
        `  repoRegistrable: isRegistrableRoot(repo),\n` +
        `  realHomeReason: detectRepoRoot(realHome).reason,\n` +
        `  stateHomeReason: detectRepoRoot(stateHome).reason,\n` +
        `  repoReason: detectRepoRoot(repo).reason,\n` +
        `}));\n`,
    );

    const res = Bun.spawnSync(["bun", script, realHome, stateHome, repo], {
      env: { ...process.env, HOME: realHome, HAYVEN_HOME: stateHome },
    });
    const stdout = new TextDecoder().decode(res.stdout);
    if (res.exitCode !== 0) {
      throw new Error(`probe failed (${res.exitCode}): ${new TextDecoder().decode(res.stderr)}`);
    }
    const out = { ...(JSON.parse(stdout) as Record<string, unknown>), realHome, stateHome, repo, base };
    rmSync(base, { recursive: true, force: true });
    return out;
  };

  it("PRECONDITION: the child really does see two DIFFERENT ambient homes", () => {
    // If these collapse to one path, every assertion below covers one arm twice
    // and the other not at all — exactly the vacuity being fixed here.
    const p = probe();
    expect(p["seenHome"]).toBe(p["realHome"]);
    expect(p["seenStateHome"]).toBe(p["stateHome"]);
    expect(p["seenHome"]).not.toBe(p["seenStateHome"]);
  });

  it("registry: refuses BOTH the real home and the relocated state home", () => {
    const p = probe();
    expect(p["realHomeRegistrable"]).toBe(false); // pins the homedir() arm
    expect(p["stateHomeRegistrable"]).toBe(false); // pins the hayvenHomeDir() arm
    expect(p["repoRegistrable"]).toBe(true); // positive control
  });

  it("detectRepoRoot: treats BOTH homes' .hayven as global config, not a project", () => {
    const p = probe();
    expect(p["realHomeReason"]).toBe("cwd-fallback"); // pins the homedir() arm
    expect(p["stateHomeReason"]).toBe("cwd-fallback"); // pins the hayvenHomeDir() arm
    expect(p["repoReason"]).toBe("hayven"); // positive control
  });
});

describe("ensure-daemon.sh", () => {
  const hook = join(dirname(import.meta.dir), "..", "plugin", "scripts", "ensure-daemon.sh");

  // A port nothing listens on. EVERY fixture must use it — including the
  // "bails" ones. The hook probes the configured port for a healthy daemon and
  // exits 0 BEFORE the home check when one answers. An earlier version of this
  // file gave the dead port only to the "it starts one" fixtures, so on any
  // developer machine with a real daemon on :7777 the two "bails" tests passed
  // for entirely the wrong reason: mutation-testing proved they still passed
  // with the home guard DELETED. Green on CI, vacuous exactly where it matters.
  const DEAD_PORT = 7913;

  /** Give `dir` a `.hayven/` whose configured port is guaranteed unanswered. */
  function fixture(dir: string): string {
    mkdirSync(join(dir, ".hayven"), { recursive: true });
    writeFileSync(join(dir, ".hayven", "config.json"), JSON.stringify({ daemon_port: DEAD_PORT }));
    return dir;
  }

  const makeProject = (): string => fixture(join(home, "proj"));

  /**
   * Run the hook with a stubbed PATH so it can never start a real daemon.
   *
   * `started` reads the hook's OWN announcement line, which it prints
   * synchronously once it reaches the start step. Do NOT assert on a sentinel
   * file written by the stub binary: the hook launches it via
   * `( nohup … & )`, so the write races the assertion.
   *
   * Absence of that line is only meaningful because every fixture uses
   * DEAD_PORT and the positive control below proves the line appears when the
   * hook does proceed.
   */
  function run(cwd: string, env: Record<string, string | undefined>) {
    const stub = mkdtempSync(join(tmpdir(), "hayven-stubbin-"));
    writeFileSync(join(stub, "hayven"), "#!/bin/sh\nexit 0\n");
    Bun.spawnSync(["chmod", "+x", join(stub, "hayven")]);
    const res = Bun.spawnSync(["/bin/sh", hook], {
      cwd,
      env: { PATH: `${stub}:/usr/bin:/bin`, ...env } as Record<string, string>,
    });
    rmSync(stub, { recursive: true, force: true });
    const stderr = new TextDecoder().decode(res.stderr);
    return { code: res.exitCode, stderr, started: /started it/i.test(stderr) };
  }

  it("PRECONDITION: nothing is listening on the fixture port", async () => {
    // If this fails, every assertion below is meaningless — the hook would exit
    // at the health probe and never reach the code under test.
    let answered = false;
    try {
      await fetch(`http://127.0.0.1:${DEAD_PORT}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      answered = true;
    } catch {
      /* expected: connection refused */
    }
    expect(answered).toBe(false);
  });

  it("bails in the home dir", () => {
    const res = run(fixture(home), { HOME: home });
    expect(res.code).toBe(0);
    expect(res.started).toBe(false);
  });

  it("acts in a real project", () => {
    // The positive control for every "bails" test: identical fixture, identical
    // port, differing ONLY in that the cwd is not home. If this stops starting,
    // the "bails" assertions have gone vacuous again.
    const res = run(makeProject(), { HOME: home });
    expect(res.started).toBe(true);
  });

  it("still works in a project when HOME is EMPTY", () => {
    // `cd ""` SUCCEEDS and stays put, so a naive `$(cd "$HOME" && pwd -P)`
    // returns the CURRENT dir — the equality then holds everywhere and the hook
    // silently disables itself in every project. Seen under launchd/systemd,
    // some CI runners, and slim containers.
    const res = run(makeProject(), { HOME: "" });
    expect(res.started).toBe(true);
  });

  it("still works in a project when HOME is UNSET, with no unbound-variable noise", () => {
    const res = run(makeProject(), { HOME: undefined });
    expect(res.stderr).not.toMatch(/unbound variable/i);
    expect(res.started).toBe(true);
  });

  it("bails in the home dir reached through a symlink", () => {
    const base = mkdtempSync(join(tmpdir(), "hayven-symhook-"));
    const real = join(base, "real");
    const link = join(base, "link");
    fixture(real);
    symlinkSync(real, link);
    // cwd is the symlink path; HOME is the real path. `pwd -P` resolves both.
    const res = run(link, { HOME: real });
    expect(res.started).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("install-hayven.sh suite_repo", () => {
  // The SAME `.hayven` conflation, in the SAME SessionStart hook family, on the
  // SAME automatic trigger: `[ -d .hayven ]` is TRUE in `$HOME` because that is
  // the global config dir. Today it only gates a stderr nudge, so the blast
  // radius is small — but it is one behavior change from being load-bearing
  // again, which is exactly how the original bug got there.
  const hook = join(dirname(import.meta.dir), "..", "plugin", "scripts", "install-hayven.sh");

  function check(cwd: string, homeEnv: string) {
    // A stub `hayven` on PATH so `--check` reports "already installed" and
    // reaches the suite nudge without downloading anything.
    const stub = mkdtempSync(join(tmpdir(), "hayven-stubbin-"));
    writeFileSync(join(stub, "hayven"), "#!/bin/sh\nexit 0\n");
    Bun.spawnSync(["chmod", "+x", join(stub, "hayven")]);
    const res = Bun.spawnSync(["/bin/sh", hook, "--check"], {
      cwd,
      env: { PATH: `${stub}:/usr/bin:/bin`, HOME: homeEnv } as Record<string, string>,
    });
    rmSync(stub, { recursive: true, force: true });
    const stderr = new TextDecoder().decode(res.stderr);
    return { code: res.exitCode, nudged: /fleet suite: missing/i.test(stderr), stderr };
  }

  it("does NOT treat the home dir as a suite repo", () => {
    const res = check(home, home);
    expect(res.code).toBe(0);
    expect(res.nudged).toBe(false);
  });

  it("positive control: a real project under home IS a suite repo", () => {
    // Identical invocation, differing only in cwd. Without this, the test above
    // would pass for an implementation where the nudge never fires at all.
    const proj = join(home, "proj");
    mkdirSync(join(proj, ".hayven"), { recursive: true });
    expect(check(proj, home).nudged).toBe(true);
  });

  it("still nudges in a project when HOME is EMPTY or UNSET", () => {
    // `cd ""` succeeds and stays put, so a naive `$(cd "$HOME" && pwd -P)`
    // returns the CURRENT dir and the equality holds everywhere — silently
    // disabling the nudge in every repo.
    const proj = join(home, "proj2");
    mkdirSync(join(proj, ".hayven"), { recursive: true });
    expect(check(proj, "").nudged).toBe(true);
    const res = Bun.spawnSync(["/bin/sh", hook, "--check"], {
      cwd: proj,
      env: { PATH: "/usr/bin:/bin" } as Record<string, string>,
    });
    expect(new TextDecoder().decode(res.stderr)).not.toMatch(/unbound variable/i);
  });
});
