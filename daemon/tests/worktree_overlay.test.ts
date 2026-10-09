// Per-worktree overlay indexes (HAYV-13) — END-TO-END through the real CLI and
// native parser, in throwaway git repos.
//
// The bug this guards: a Sirius worker edits inside a detached `git worktree`,
// and a graph read from there walked up to the MAIN checkout's `.hayven` (or,
// for a worktree outside the repo, found no project at all). Brand-new files in
// the worktree mapped to nothing, so `affected-tests --changed src/newmod.ts`
// selected no tests for a file that plainly has one.
//
// Every invocation is a SUBPROCESS of `src/cli.ts`, because the lazy overlay
// refresh lives in `main`'s dispatch, not in any single command. Each child gets
// a sandboxed `$HAYVEN_HOME` (never `$HOME`: Bun caches `os.homedir()`) and a
// dead `$HAYVEN_PORT`, so `init`'s best-effort hot-add cannot reach a real
// daemon. Binary-gated like the other native suites.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/db/queries.ts";
import { MAX_WORKTREE_OVERLAYS, overlayId } from "../src/worktree/registry.ts";

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  for (const c of [
    join(import.meta.dir, "../../native/target/release/hayven-native"),
    join(import.meta.dir, "../../native/target/debug/hayven-native"),
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}
const bin = findBinary();
const maybe = bin === null ? describe.skip : describe;

const CLI = join(import.meta.dir, "../src/cli.ts");
const DEAD_PORT = "7915";
const SLOW = 120_000;

let home: string;
let scratch: string[] = [];

function tmp(prefix: string): string {
  // realpath so assertions compare the same spelling the CLI canonicalizes to
  // (`/var` → `/private/var` on macOS).
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(d);
  return d;
}

function git(cwd: string, args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function hv(cwd: string, ...args: string[]): Run {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, HAYVEN_HOME: home, HAYVEN_PORT: DEAD_PORT, HAYVEN_NATIVE_BIN: bin ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

function json<T>(r: Run): T {
  if (r.code !== 0) throw new Error(`exit ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout) as T;
}

function queryIds(cwd: string, term: string, ...extra: string[]): string[] {
  return json<{ hits: Array<{ id: string }> }>(hv(cwd, "query", term, "--json", ...extra)).hits.map((h) => h.id);
}

function write(root: string, rel: string, body: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const NEWMOD = "export function brandNewThing() {\n  return 2;\n}\n";
const NEWMOD_TEST =
  'import { brandNewThing } from "./newmod";\nimport { test } from "bun:test";\ntest("n", () => { brandNewThing(); });\n';

/** A committed TS repo with one function + its test, initialized and ingested. */
function makeRepo(): string {
  const repo = tmp("hv-wt-main-");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  write(repo, "src/a.ts", "export function existingFn() {\n  return 1;\n}\n");
  write(
    repo,
    "src/a.test.ts",
    'import { existingFn } from "./a";\nimport { test } from "bun:test";\ntest("a", () => { existingFn(); });\n',
  );
  // Sirius keeps its worktrees under an IGNORED `.sirius/`, which is exactly
  // the layout that exposed the native scope bug (see worktree/overlay.ts).
  write(repo, ".gitignore", ".sirius/\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  const init = hv(repo, "init", "--yes");
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);
  return repo;
}

function addWorktree(repo: string, path: string): string {
  git(repo, ["worktree", "add", "-q", "--detach", path]);
  return realpathSync(path);
}

function branchDirs(repo: string): string[] {
  try {
    return readdirSync(join(repo, ".hayven", "branches")).sort();
  } catch {
    return [];
  }
}

maybe("worktree overlays (E2E, native binary)", () => {
  beforeEach(() => {
    scratch = [];
    home = tmp("hv-wt-home-");
  });
  afterEach(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  test(
    "a registered worktree sees its own NEW files; the main checkout does not",
    () => {
      const repo = makeRepo();
      const lruBefore = branchDirs(repo);
      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));
      const added = json<{ path: string; id: string; added: boolean }>(hv(repo, "worktree", "add", wt, "--json"));
      expect(added.path).toBe(wt);
      expect(added.added).toBe(true);
      expect(existsSync(join(repo, ".hayven/worktrees", added.id, "index.sqlite"))).toBe(true);

      write(wt, "src/newmod.ts", NEWMOD);
      write(wt, "src/newmod.test.ts", NEWMOD_TEST);

      // affected-tests from INSIDE the worktree selects the new file's test.
      const at = json<{ tests: Array<{ file: string }> }>(
        hv(wt, "affected-tests", "--changed", "src/newmod.ts", "--json"),
      );
      expect(at.tests.map((t) => t.file)).toContain("src/newmod.test.ts");

      // refs and query find the new function too.
      expect(queryIds(wt, "brandNewThing")).toContain("src/newmod/brandNewThing");
      const refs = json<{ callers: Array<{ id: string }>; importers: Array<{ id: string }> }>(
        hv(wt, "refs", "src/newmod/brandNewThing", "--json"),
      );
      expect([...refs.callers, ...refs.importers].map((r) => r.id)).toContain("src/newmod.test");
      // Pre-existing code is still there (the overlay is a full copy).
      expect(queryIds(wt, "existingFn")).toContain("src/a/existingFn");

      // From the MAIN checkout, neither exists.
      expect(queryIds(repo, "brandNewThing")).toEqual([]);
      expect(hv(repo, "refs", "src/newmod/brandNewThing", "--json").code).toBe(1);
      const mainAt = json<{ tests: Array<{ file: string }> }>(
        hv(repo, "affected-tests", "--changed", "src/newmod.ts", "--json"),
      );
      expect(mainAt.tests.map((t) => t.file)).not.toContain("src/newmod.test.ts");

      // Overlay work never touches the per-branch LRU set.
      expect(branchDirs(repo)).toEqual(lruBefore);
    },
    SLOW,
  );

  test(
    "edits in the worktree show up on the next read, with no explicit reindex",
    () => {
      const repo = makeRepo();
      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));
      expect(hv(repo, "worktree", "add", wt).code).toBe(0);

      // Modify a TRACKED file.
      write(wt, "src/a.ts", "export function existingFn() {\n  return 1;\n}\nexport function secondThing() {\n  return 3;\n}\n");
      expect(queryIds(wt, "secondThing")).toContain("src/a/secondThing");

      // Edit the SAME already-dirty file again: `git status` output is unchanged,
      // so only the dirty-file mtime in the fingerprint can notice this.
      write(wt, "src/a.ts", "export function existingFn() {\n  return 1;\n}\nexport function thirdThing() {\n  return 4;\n}\n");
      expect(queryIds(wt, "thirdThing")).toContain("src/a/thirdThing");
      expect(queryIds(wt, "secondThing")).not.toContain("src/a/secondThing");

      // REVERT it: the file drops out of `git diff`, so only the remembered
      // dirty set brings it back to the committed version.
      git(wt, ["checkout", "--", "src/a.ts"]);
      expect(queryIds(wt, "thirdThing")).not.toContain("src/a/thirdThing");
      expect(queryIds(wt, "existingFn")).toContain("src/a/existingFn");

      // A worker reset to a NEW base tip (Sirius does this every iteration).
      write(repo, "src/b.ts", "export function committedOnMain() {\n  return 5;\n}\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "main moves"]);
      git(wt, ["checkout", "-q", "--detach", git(repo, ["rev-parse", "HEAD"]).trim()]);
      expect(queryIds(wt, "committedOnMain")).toContain("src/b/committedOnMain");

      const list = json<{ worktrees: Array<{ path: string; freshness: string }> }>(hv(repo, "worktree", "list", "--json"));
      expect(list.worktrees).toEqual([expect.objectContaining({ path: wt, freshness: "fresh" })]);
      write(wt, "src/c.ts", "export const c = 1;\n");
      const stale = json<{ worktrees: Array<{ freshness: string }> }>(hv(repo, "worktree", "list", "--json"));
      expect(stale.worktrees[0]?.freshness).toBe("stale");

      // A refresh that died mid-way leaves the in-progress marker set. That must
      // read as BROKEN (never fresh), and the next read must repair it.
      expect(queryIds(wt, "committedOnMain")).toContain("src/b/committedOnMain");
      const overlay = new Db(join(repo, ".hayven/worktrees", overlayId(wt), "index.sqlite"));
      overlay.beginIngest();
      overlay.close();
      const broken = json<{ worktrees: Array<{ freshness: string }> }>(hv(repo, "worktree", "list", "--json"));
      expect(broken.worktrees[0]?.freshness).toBe("broken");
      expect(queryIds(wt, "committedOnMain")).toContain("src/b/committedOnMain");
      const repaired = json<{ worktrees: Array<{ freshness: string }> }>(hv(repo, "worktree", "list", "--json"));
      expect(repaired.worktrees[0]?.freshness).toBe("fresh");
    },
    SLOW,
  );

  test(
    "remove deletes the overlay; prune drops one whose worktree dir is gone; the LRU set is untouched",
    () => {
      const repo = makeRepo();
      const lruBefore = branchDirs(repo);
      const w1 = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));
      const w2 = addWorktree(repo, join(repo, ".sirius/worktrees/w2"));
      expect(hv(repo, "worktree", "add", w1).code).toBe(0);
      expect(hv(repo, "worktree", "add", w2).code).toBe(0);
      const d1 = join(repo, ".hayven/worktrees", overlayId(w1));
      const d2 = join(repo, ".hayven/worktrees", overlayId(w2));
      expect(existsSync(d1) && existsSync(d2)).toBe(true);

      const rm = hv(repo, "worktree", "remove", w1);
      expect(rm.code).toBe(0);
      expect(existsSync(d1)).toBe(false);

      rmSync(w2, { recursive: true, force: true });
      const pruned = json<{ removed: Array<{ path: string }> }>(hv(repo, "worktree", "prune", "--json"));
      expect(pruned.removed.map((r) => r.path)).toEqual([w2]);
      expect(existsSync(d2)).toBe(false);

      const reg = JSON.parse(readFileSync(join(repo, ".hayven/worktrees.json"), "utf8")) as { worktrees: unknown[] };
      expect(reg.worktrees).toEqual([]);
      expect(branchDirs(repo)).toEqual(lruBefore);

      // Removing something that is not registered is an error, not a no-op.
      expect(hv(repo, "worktree", "remove", w1).code).toBe(1);
    },
    SLOW,
  );

  test(
    "a worktree OUTSIDE the repo works once registered, from its cwd and via --root",
    () => {
      const repo = makeRepo();
      const outside = tmp("hv-wt-out-");
      const wt = addWorktree(repo, join(outside, "w-out"));
      write(wt, "src/newmod.ts", NEWMOD);
      write(wt, "src/newmod.test.ts", NEWMOD_TEST);

      // Before registration there is no project here at all (unchanged behavior).
      expect(hv(wt, "query", "brandNewThing").code).toBe(1);

      // Registering works from INSIDE the unregistered worktree too.
      expect(hv(wt, "worktree", "add", ".").code).toBe(0);
      expect(queryIds(wt, "brandNewThing")).toContain("src/newmod/brandNewThing");

      // `--root` points a read at the worktree from anywhere.
      expect(queryIds(repo, "brandNewThing", "--root", wt)).toContain("src/newmod/brandNewThing");
      expect(queryIds(repo, "brandNewThing")).toEqual([]);
      const at = json<{ tests: Array<{ file: string }> }>(
        hv(outside, "affected-tests", "--changed", "src/newmod.ts", "--json", "--root", wt),
      );
      expect(at.tests.map((t) => t.file)).toContain("src/newmod.test.ts");
      // A bare `--root` is a usage error, never a silent "use the cwd".
      expect(hv(repo, "query", "x", "--root").code).toBe(2);
    },
    SLOW,
  );

  test(
    "an UNREGISTERED worktree still reads the main index, exactly as before",
    () => {
      const repo = makeRepo();
      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w9"));
      write(wt, "src/newmod.ts", NEWMOD);

      const fromWt = hv(wt, "query", "existingFn", "--json");
      const fromMain = hv(repo, "query", "existingFn", "--json");
      expect(fromWt.code).toBe(0);
      expect(fromWt.stdout).toBe(fromMain.stdout);
      expect(queryIds(wt, "brandNewThing")).toEqual([]);
      // Nothing overlay-related was created as a side effect.
      expect(existsSync(join(repo, ".hayven/worktrees"))).toBe(false);
      expect(existsSync(join(repo, ".hayven/worktrees.json"))).toBe(false);
    },
    SLOW,
  );

  test(
    "add refuses a non-worktree path, the main checkout, and a worktree of another repo",
    () => {
      const repo = makeRepo();
      const plain = tmp("hv-wt-plain-");
      const r1 = hv(repo, "worktree", "add", plain);
      expect(r1.code).toBe(1);
      expect(r1.stderr).toContain("not inside a git working tree");

      const r2 = hv(repo, "worktree", "add", repo);
      expect(r2.code).toBe(1);
      expect(r2.stderr).toContain("main checkout");

      const other = tmp("hv-wt-other-");
      git(other, ["init", "-q", "-b", "main"]);
      git(other, ["config", "user.email", "t@t.t"]);
      git(other, ["config", "user.name", "t"]);
      write(other, "x.ts", "export const x = 1;\n");
      git(other, ["add", "-A"]);
      git(other, ["commit", "-q", "-m", "x"]);
      const foreign = addWorktree(other, join(tmp("hv-wt-foreign-"), "fw"));
      const r3 = hv(repo, "worktree", "add", foreign);
      expect(r3.code).toBe(1);
      expect(r3.stderr).toContain("different repository");

      expect(existsSync(join(repo, ".hayven/worktrees.json"))).toBe(false);
    },
    SLOW,
  );

  test(
    `the ${MAX_WORKTREE_OVERLAYS + 1}th overlay is refused, naming \`hayven worktree prune\``,
    () => {
      const repo = makeRepo();
      // Fill the registry to the cap with entries whose worktrees do not exist:
      // the cap counts registrations, and prune is what reclaims dead ones.
      const filler = Array.from({ length: MAX_WORKTREE_OVERLAYS }, (_, i) => {
        const path = join(repo, `.sirius/worktrees/gone-${i}`);
        return { path, id: overlayId(path), created_at: new Date().toISOString(), seed_head: null };
      });
      writeFileSync(join(repo, ".hayven/worktrees.json"), JSON.stringify({ version: 1, worktrees: filler }));

      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w17"));
      const refused = hv(repo, "worktree", "add", wt);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("hayven worktree prune");
      expect(existsSync(join(repo, ".hayven/worktrees", overlayId(wt)))).toBe(false);

      // Prune reclaims the dead registrations, after which it fits.
      const pruned = json<{ removed: unknown[] }>(hv(repo, "worktree", "prune", "--json"));
      expect(pruned.removed.length).toBe(MAX_WORKTREE_OVERLAYS);
      expect(hv(repo, "worktree", "add", wt).code).toBe(0);
    },
    SLOW,
  );
});
