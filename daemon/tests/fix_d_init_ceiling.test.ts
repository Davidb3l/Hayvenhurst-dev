/**
 * The two guard sites that had ZERO coverage, plus the new first-ingest ceiling.
 *
 * Mutation-testing found both survivors: deleting the `isRegistrableRoot` block
 * in `cli/init.ts` survived the whole suite (nothing called `runInit`), and so
 * did deleting the client-side guard in `cli/_shared.ts` (nothing exercised
 * `hotAddToRunningDaemon`). The init guard is the ONLY thing between
 * `hayven init` in `$HOME` and a full-home first ingest, because the
 * `registerProject` throw further down is deliberately swallowed.
 *
 * The ceiling is the fix for the real lesson of the incident: the guard is a
 * two-item denylist, and `~/Library`, `~/Documents`, `/Users` and `/Volumes`
 * all pass it. An unbounded walk with no ceiling is the actual bug; home was
 * merely the instance that happened to have a guard.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hotAddToRunningDaemon } from "../src/cli/_shared.ts";
import { ceilingVerdict, DEFAULT_MAX_INIT_FILES, parseMaxFiles, runInit } from "../src/cli/init.ts";
import { countIndexableFiles } from "../src/util/paths.ts";

let home: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-init-home-")));
  process.env["HAYVEN_HOME"] = home;
  // The GLOBAL config dir — the thing that makes a bare `.hayven` check answer
  // "yes, a project" when the cwd happens to be home.
  mkdirSync(join(home, ".hayven"), { recursive: true });
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  try {
    for (const e of readdirSync(home)) chmodSync(join(home, e), 0o700);
  } catch {
    /* best effort — only the read-only fixture below needs this */
  }
  rmSync(home, { recursive: true, force: true });
});

/** Run `runInit` capturing its streams. Never lets output leak into the report. */
async function captureInit(flags: Record<string, string | boolean>): Promise<{
  code: number | null;
  err: string;
  threw: string | null;
}> {
  const err: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  (process.stderr as { write: unknown }).write = (s: unknown) => (err.push(String(s)), true);
  (process.stdout as { write: unknown }).write = () => true;
  try {
    const code = await runInit({ positionals: [], flags });
    return { code, err: err.join(""), threw: null };
  } catch (e) {
    return { code: null, err: err.join(""), threw: (e as Error).message };
  } finally {
    (process.stderr as { write: unknown }).write = origErr;
    (process.stdout as { write: unknown }).write = origOut;
  }
}

describe("runInit refuses the home dir", () => {
  it("refuses $HOME with the home-guard message, before creating anything", async () => {
    const res = await captureInit({ cwd: home });
    expect(res.code).toBe(1);
    // Assert the MESSAGE, not just the exit code. With the guard deleted, init
    // falls through to the `.hayven/ already exists` check — which is TRUE in
    // home, because that is the global config dir — and also returns 1. The
    // exit code alone cannot tell the two apart.
    expect(res.err).toMatch(/refusing to initialize/i);
    // Nothing was built inside the global dir.
    expect(readdirSync(join(home, ".hayven"))).toEqual([]);
  });

  it("positive control: a real project gets PAST the guard", async () => {
    // Identical call shape, differing only in that the cwd is not home. It
    // stops at the next check instead — proving the guard is what stopped the
    // home case, not something earlier and unrelated.
    const proj = join(home, "proj");
    mkdirSync(join(proj, ".hayven"), { recursive: true });
    const res = await captureInit({ cwd: proj });
    expect(res.err).not.toMatch(/refusing to initialize/i);
    expect(res.err).toMatch(/already exists/i);
  });
});

describe("first-ingest file ceiling", () => {
  /**
   * A project-shaped dir holding `n` source files and no `.hayven/`, made
   * READ-ONLY.
   *
   * The read-only bit is a MUTATION-TESTING SAFETY BELT, not decoration. Every
   * fixture here is handed to `runInit`, and if the guard under test is
   * reverted, init runs to completion: it would create `.hayven/`, run a real
   * first ingest, and then hot-add the fixture to whatever daemon answers on
   * the default port — mutating real state from a test run. Read-only makes the
   * reverted path die at its first mkdir instead.
   */
  function bigRepo(name: string, n: number): string {
    const root = join(home, name);
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(join(root, `f${i}.ts`), "export const x = 1;\n");
    chmodSync(root, 0o500);
    return root;
  }

  it("PRECONDITION: the fixture is over the ceiling and an under-ceiling dir is not", () => {
    const root = bigRepo("counted", 30);
    const over = countIndexableFiles(root, 5);
    expect(over).toEqual({ count: 30, exceeded: true, exact: true });
    // The positive control for the counter itself: same tree, higher ceiling.
    expect(countIndexableFiles(root, 100).exceeded).toBe(false);
  });

  it("aborts with the count, the ceiling and the override flag", async () => {
    const root = bigRepo("toobig", 30);
    const res = await captureInit({ cwd: root, "max-files": "5" });
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/--max-files ceiling/);
    expect(res.err).toContain("30 files"); // the ACTUAL count, not just "too many"
    expect(res.err).toContain("--max-files=off"); // the explicit override
    // Aborted BEFORE creating anything — that is the whole point.
    expect(readdirSync(root).some((f) => f === ".hayven")).toBe(false);
  });

  it("`--max-files=off` really does bypass the ceiling", async () => {
    // The positive control for the wiring. The fixture is made READ-ONLY so
    // init fails at its first mkdir instead of running a real first ingest —
    // a successful init would hot-add the fixture to whatever daemon is
    // listening on the default port, i.e. mutate real state.
    const root = bigRepo("bypass", 30);
    expect(() => mkdirSync(join(root, ".probe"))).toThrow(); // precondition

    const res = await captureInit({ cwd: root, "max-files": "off" });

    expect(res.err).not.toMatch(/--max-files ceiling/);
    // It got past the ceiling and died on the read-only mkdir instead.
    expect(res.threw ?? "").toMatch(/EACCES|EPERM/);
    chmodSync(root, 0o700);
  });

  it("rejects a malformed --max-files instead of silently using the default", async () => {
    // A typo must not quietly re-arm the unbounded walk.
    const root = bigRepo("typo", 3);
    const res = await captureInit({ cwd: root, "max-files": "1O000" });
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/--max-files must be a positive integer/);
  });
});

describe("parseMaxFiles", () => {
  it("defaults, disables, parses and rejects", () => {
    expect(parseMaxFiles(undefined)).toBe(DEFAULT_MAX_INIT_FILES);
    expect(parseMaxFiles("off")).toBeNull();
    expect(parseMaxFiles("none")).toBeNull();
    expect(parseMaxFiles("0")).toBeNull();
    // Normalized AFTER parsing, not just on the literal "0": a ceiling of zero
    // would reject every directory on earth with a nonsensical message.
    expect(parseMaxFiles("00")).toBeNull();
    expect(parseMaxFiles("250000")).toBe(250000);
    expect(parseMaxFiles(true)).toBeInstanceOf(Error); // bare `--max-files`
    expect(parseMaxFiles("-5")).toBeInstanceOf(Error);
    expect(parseMaxFiles("1e6")).toBeInstanceOf(Error);
  });
});

describe("ceilingVerdict fails CLOSED", () => {
  it("refuses a scan that could not finish, even when it is under the ceiling", () => {
    // `exceeded: false` on an inexact scan means "did not PROVE it is over",
    // not "is under" — `count` is only a lower bound. Waving this through is
    // how a cold ~/Library or a network mount slips past the ceiling entirely.
    const v = ceilingVerdict("/some/root", { count: 20_000, exceeded: false, exact: false }, 50_000);
    expect(v).not.toBeNull();
    expect(v).toMatch(/did not finish/);
    // No "--max-files=<n>" suggestion: any number we named would be a lower
    // bound, so the re-run would fail identically.
    expect(v).not.toMatch(/--max-files=20000/);
  });

  it("proceeds only on a COMPLETE scan that is under the ceiling", () => {
    expect(ceilingVerdict("/some/root", { count: 20_000, exceeded: false, exact: true }, 50_000)).toBeNull();
  });

  it("names the exact count and a usable override when the scan completed", () => {
    const v = ceilingVerdict("/some/root", { count: 91_234, exceeded: true, exact: true }, 50_000);
    expect(v).toMatch(/91,234 files/);
    expect(v).toMatch(/--max-files=91234/); // re-running with this actually works
  });
});

describe("countIndexableFiles bounds", () => {
  it("skips the dirs the native walker skips, and hidden entries", () => {
    const root = join(home, "skips");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "a.js"), "");
    writeFileSync(join(root, ".git", "HEAD"), "");
    writeFileSync(join(root, ".gitignore"), "");
    writeFileSync(join(root, "src", "a.ts"), "");
    writeFileSync(join(root, "b.ts"), "");
    expect(countIndexableFiles(root, 1000).count).toBe(2);
  });

  it("stops at its own hard cap rather than becoming the unbounded walk", () => {
    // The counter must be bounded too, or it is just the same runaway scan one
    // step earlier. Past the cap it reports a LOWER BOUND, and the caller says
    // "more than N" instead of inventing a number.
    const root = join(home, "huge");
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(root, `f${i}.ts`), "");
    const res = countIndexableFiles(root, 2, { scanCap: 10 });
    expect(res).toEqual({ count: 10, exceeded: true, exact: false });
  });

  it("does not follow symlinked directories", () => {
    // Pins the BEHAVIOR (a `~/x -> ~` style link must not make the scan
    // non-terminating), not the `isSymbolicLink()` line — `readdirSync`
    // dirents already carry lstat semantics, so that line is belt-and-braces
    // and its individual mutant survives. This test still catches a switch to
    // a symlink-following walk.
    const root = join(home, "looped");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "a.ts"), "");
    require("node:fs").symlinkSync(root, join(root, "self"));
    expect(countIndexableFiles(root, 1000)).toEqual({ count: 1, exceeded: false, exact: true });
  });
});

describe("hotAddToRunningDaemon client-side guard", () => {
  // A port nothing listens on. Load-bearing: with the guard deleted this call
  // POSTs to whatever answers, and a real daemon on the default port would
  // then be told to serve a throwaway fixture — mutating real state from a
  // mutation run.
  const DEAD_PORT = 7915;
  const base = `http://127.0.0.1:${DEAD_PORT}`;

  it("PRECONDITION: nothing is listening on the fixture port", async () => {
    let answered = false;
    try {
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      answered = true;
    } catch {
      /* expected: connection refused */
    }
    expect(answered).toBe(false);
  });

  it("refuses to ask a daemon to serve $HOME", async () => {
    const res = await hotAddToRunningDaemon(home, base);
    expect(res.kind).toBe("error");
    expect((res as { message: string }).message).toMatch(/refusing to serve/i);
  });

  it("positive control: a real project reaches the network instead", async () => {
    // Differs from the case above ONLY in the root. `no-daemon` proves the
    // guard did not fire and the request was actually attempted — which is
    // exactly what the $HOME case must NOT do.
    const proj = join(home, "proj");
    mkdirSync(join(proj, ".hayven"), { recursive: true });
    expect((await hotAddToRunningDaemon(proj, base)).kind).toBe("no-daemon");
  });
});
