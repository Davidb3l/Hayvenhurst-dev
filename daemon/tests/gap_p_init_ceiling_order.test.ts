/**
 * P5 — `hayven init`'s ceiling must fire BEFORE anything is created.
 *
 * A ceiling that runs after `mkdirSync(.hayven)` or `new Db(...)` has already
 * paid for the damage it exists to prevent, AND it leaves a half-built project
 * behind: the obvious retry then reports "`.hayven/` already exists", which
 * names the wrong problem entirely. The refusal must also name the ACTUAL count
 * and the override, or the user's only move is to delete the tree and guess.
 *
 * `fix_d_init_ceiling.test.ts` covers the verdict function and the flag parser.
 * This file pins the ORDERING and the error text against the real `runInit`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MAX_INIT_FILES, refuseIfOverCeiling, runInit } from "../src/cli/init.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

let home: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-gapp-initorder-")));
  process.env["HAYVEN_HOME"] = home;
  mkdirSync(join(home, ".hayven"), { recursive: true });
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  try {
    for (const e of readdirSync(home)) chmodSync(join(home, e), 0o700);
  } catch {
    /* best effort */
  }
  rmSync(home, { recursive: true, force: true });
});

async function captureInit(flags: Record<string, string | boolean>): Promise<{ code: number | null; err: string }> {
  const err: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  (process.stderr as { write: unknown }).write = (s: unknown) => (err.push(String(s)), true);
  (process.stdout as { write: unknown }).write = () => true;
  try {
    return { code: await runInit({ positionals: [], flags }), err: err.join("") };
  } catch (e) {
    return { code: null, err: err.join("") + String((e as Error).message) };
  } finally {
    (process.stderr as { write: unknown }).write = origErr;
    (process.stdout as { write: unknown }).write = origOut;
  }
}

/**
 * A project-shaped dir holding `n` parseable source files and no `.hayven/`,
 * made READ-ONLY.
 *
 * The read-only bit is a MUTATION-TESTING SAFETY BELT, not decoration: if the
 * guard under test is reverted, `runInit` runs to completion — creating
 * `.hayven/`, running a real first ingest, and hot-adding the fixture to
 * whatever daemon answers on the default port, i.e. mutating real state from a
 * test run. Read-only makes the reverted path die at its first mkdir instead.
 */
function bigRepo(name: string, n: number): string {
  const root = join(home, name);
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(root, `f${i}.ts`), "export const x = 1;\n");
  chmodSync(root, 0o500);
  return root;
}

describe("the ceiling fires before anything is created", () => {
  it("leaves no .hayven/, no config, and no sqlite file behind", async () => {
    const root = bigRepo("ordered", 12);
    const paths = hayvenPathsFor(root);

    const res = await captureInit({ cwd: root, "max-files": "3" });

    expect(res.code).toBe(1);
    // Each asserted SEPARATELY: `.hayven/` alone would also be absent if init
    // had died on the read-only mkdir, but the config and the sqlite file are
    // written by later steps, so naming all three pins the ordering rather than
    // just "something went wrong".
    expect(existsSync(paths.hayvenDir)).toBe(false);
    expect(existsSync(paths.configFile)).toBe(false);
    expect(existsSync(paths.sqliteFile)).toBe(false);
    // And it did NOT leave the .gitignore / AGENTS.md side effects either.
    expect(readdirSync(root).filter((f) => !f.startsWith("f")).sort()).toEqual([]);
  });

  it("names the actual count, the ceiling, and both overrides", async () => {
    const root = bigRepo("named", 12);
    const res = await captureInit({ cwd: root, "max-files": "3" });

    expect(res.err).toContain("12 files"); // the ACTUAL count, not "too many"
    expect(res.err).toContain("ceiling of 3"); // the ceiling that was applied
    expect(res.err).toContain("--max-files=12"); // a value that actually works
    expect(res.err).toContain("--max-files=off"); // the escape hatch
    // The count is now stated in the units it is measured in, so a user who
    // compares it against `find . | wc -l` is not misled.
    expect(res.err).toMatch(/source files only, after \.gitignore/);
  });

  it("says ABOVE, not 'at or above', when the scan actually completed", async () => {
    // `exceeded` is a strict `count > ceiling`, so "at or above" was wrong for
    // every exact refusal the command printed. Only an INEXACT scan (a lower
    // bound) genuinely cannot tell the two apart.
    const root = bigRepo("wording", 12);
    const res = await captureInit({ cwd: root, "max-files": "3" });
    expect(res.err).toMatch(/\nabove the --max-files ceiling/);
    expect(res.err).not.toMatch(/at or above the --max-files ceiling/);
  });
});

describe("refuseIfOverCeiling — the one-call form other entry points can adopt", () => {
  it("refuses an over-ceiling tree and names the command it was given", () => {
    const root = bigRepo("shared", 12);
    const msg = refuseIfOverCeiling(root, 3, "hayven daemon register");
    expect(msg).not.toBeNull();
    expect(msg).toContain("hayven daemon register --max-files=off");
  });

  it("passes an under-ceiling tree, and a null ceiling disables it entirely", () => {
    const root = bigRepo("small", 2);
    expect(refuseIfOverCeiling(root, 100)).toBeNull();
    expect(refuseIfOverCeiling(root, null)).toBeNull();
    // Sanity: the default is a real positive ceiling, not accidentally 0/NaN.
    expect(DEFAULT_MAX_INIT_FILES).toBeGreaterThan(1_000);
  });
});
