/**
 * The global-home comparison primitives behind the sandbox-escape fix.
 *
 * Split out of `leak_registry_sandbox.test.ts` on purpose: that file is the
 * REGRESSION proof and must stay runnable against the unfixed code, so it may
 * not import symbols the fix introduced. This one may, because it only tests
 * the helpers themselves.
 *
 * Two invariants matter more than the rest:
 *   - CANONICAL comparison. `/tmp` is a symlink to `/private/tmp` on macOS, so
 *     one directory has two spellings and a naive `===` would refuse every
 *     legitimate hot-add on this platform.
 *   - "unknown" is not "mismatch". An old daemon reports no home at all, and a
 *     dead port reports nothing either. Both must fall through and allow the
 *     hot-add, or upgrading the CLI breaks registration against daemons that are
 *     already running.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareGlobalHomes, probeDaemonGlobalHome } from "../src/cli/_shared.ts";

let reportedHome: string | "omit" = "omit";
let callerHome: string;
let otherHome: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let realHayvenHome: string | undefined;

beforeAll(() => {
  otherHome = realpathSync(mkdtempSync(join(tmpdir(), "hayven-leak-cmp-other-")));
  server = Bun.serve({
    port: 0,
    fetch: () => {
      const body: Record<string, unknown> = { ok: true, version: "9.9.9", root: "/x" };
      if (reportedHome !== "omit") body["global_home"] = reportedHome;
      return Response.json(body);
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(otherHome, { recursive: true, force: true });
});

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  callerHome = realpathSync(mkdtempSync(join(tmpdir(), "hayven-leak-cmp-home-")));
  process.env["HAYVEN_HOME"] = callerHome;
  mkdirSync(join(callerHome, ".hayven"), { recursive: true });
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  rmSync(callerHome, { recursive: true, force: true });
});

describe("compareGlobalHomes", () => {
  it("resolves symlinks and trailing slashes before comparing", () => {
    const link = join(callerHome, "link");
    symlinkSync(callerHome, link);
    expect(compareGlobalHomes(`${link}/`).kind).toBe("match");
    expect(compareGlobalHomes(callerHome).kind).toBe("match");
    expect(compareGlobalHomes(`${callerHome}/`).kind).toBe("match");
  });

  it("treats a missing or non-string report as unknown, never as a mismatch", () => {
    expect(compareGlobalHomes(undefined).kind).toBe("unknown");
    expect(compareGlobalHomes(null).kind).toBe("unknown");
    expect(compareGlobalHomes("").kind).toBe("unknown");
    expect(compareGlobalHomes(42).kind).toBe("unknown");
  });

  it("reports a genuinely different home as a mismatch, naming both sides", () => {
    const check = compareGlobalHomes(otherHome);
    expect(check.kind).toBe("mismatch");
    expect(check).toMatchObject({ ours: realpathSync(callerHome), theirs: realpathSync(otherHome) });
  });

  it("is unknown when OUR own home cannot be resolved", () => {
    // `hayvenHomeDir()` throws on a relative override. The hot-add path is best
    // effort and must never throw, so an unusable override degrades to "no
    // opinion" rather than taking the command down.
    process.env["HAYVEN_HOME"] = "relative/not/absolute";
    expect(compareGlobalHomes(otherHome).kind).toBe("unknown");
  });
});

describe("probeDaemonGlobalHome", () => {
  it("reports unknown when nothing is listening, so a dead port never blocks a hot-add", async () => {
    // Assert the precondition rather than assuming it. If something ever binds
    // 7917 this test would otherwise stop exercising the dead-port path while
    // still passing, which is the worst of both outcomes.
    const dead = "http://127.0.0.1:7917";
    let listening = true;
    try {
      await fetch(`${dead}/api/health`, { signal: AbortSignal.timeout(1_000) });
    } catch {
      listening = false;
    }
    expect(listening).toBe(false);
    expect((await probeDaemonGlobalHome(dead)).kind).toBe("unknown");
  });

  it("reports unknown for an OLD daemon that omits the field", async () => {
    reportedHome = "omit";
    expect((await probeDaemonGlobalHome(base)).kind).toBe("unknown");
  });

  it("reads the field off a live daemon, both ways", async () => {
    reportedHome = otherHome;
    expect((await probeDaemonGlobalHome(base)).kind).toBe("mismatch");
    reportedHome = callerHome;
    expect((await probeDaemonGlobalHome(base)).kind).toBe("match");
  });
});
