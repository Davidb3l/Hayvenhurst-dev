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

import { loadConfig } from "../src/config/load.ts";
import { DIRTY_RECORD_CAP, LAST_INGEST_DIRTY_KEY } from "../src/db/ingest_dirty.ts";
import { Db } from "../src/db/queries.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { overlayTestHooks, refreshOverlay } from "../src/worktree/overlay.ts";
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

function hvEnv(cwd: string, env: Record<string, string>, ...args: string[]): Run {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, HAYVEN_HOME: home, HAYVEN_PORT: DEAD_PORT, HAYVEN_NATIVE_BIN: bin ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/**
 * sha256 of main's legacy index and every per-branch index DATA file (main +
 * `-wal`), keyed by path, plus the branch dir names. `-shm` is excluded: it is
 * SQLite's shared-memory wal-index, rewritten by any connection that merely
 * OPENS a WAL database (the seed's checkpoint does), and holds no data.
 */
function mainIndexFingerprint(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (p: string): void => {
    if (p.endsWith("-shm")) return;
    if (existsSync(p)) out[p] = new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");
  };
  add(join(repo, ".hayven/index.sqlite"));
  out["branchDirs"] = branchDirs(repo).join(",");
  for (const d of branchDirs(repo)) {
    for (const f of readdirSync(join(repo, ".hayven/branches", d))) add(join(repo, ".hayven/branches", d, f));
  }
  return out;
}

/**
 * Create an EMPTY worktree registry, which is what turns on the per-ingest
 * dirty-file record (`db/ingest_dirty.ts`). Tests that exercise the seed's
 * record path call this before main's ingest.
 */
function enableDirtyRecord(repo: string): void {
  const f = join(repo, ".hayven/worktrees.json");
  if (!existsSync(f)) writeFileSync(f, JSON.stringify({ version: 1, worktrees: [] }));
}

function mainStat(repo: string, key: string): string | null {
  const dbPath = existsSync(join(repo, ".hayven/branches/main/index.sqlite"))
    ? join(repo, ".hayven/branches/main/index.sqlite")
    : join(repo, ".hayven/index.sqlite");
  const db = new Db(dbPath, { readonly: true });
  try {
    return db.getStat(key);
  } finally {
    db.close();
  }
}

/** A `git` shim dir: logs every invocation to `<dir>/log`, then runs `body` or the real git. */
function gitShim(body = ""): { dir: string; log: string } {
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("git not found");
  const dir = tmp("hv-wt-gitshim-");
  const log = join(dir, "log");
  writeFileSync(join(dir, "git"), `#!/bin/sh\necho "$*" >> "${log}"\n${body}\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  return { dir, log };
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

      // The worker COMMITS on its detached head...
      write(wt, "src/w.ts", "export function workerOnlyFn() {\n  return 9;\n}\n");
      git(wt, ["add", "-A"]);
      git(wt, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "worker"]);
      expect(queryIds(wt, "workerOnlyFn")).toContain("src/w/workerOnlyFn");
      // ...then is reset to a NEW base tip that does not contain that commit
      // (Sirius does this every iteration). The old head's symbols must go.
      write(repo, "src/b.ts", "export function committedOnMain() {\n  return 5;\n}\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", "main moves"]);
      git(wt, ["checkout", "-q", "--detach", git(repo, ["rev-parse", "HEAD"]).trim()]);
      expect(queryIds(wt, "committedOnMain")).toContain("src/b/committedOnMain");
      expect(queryIds(wt, "workerOnlyFn")).toEqual([]);

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
    `the ${MAX_WORKTREE_OVERLAYS + 1}th LIVE overlay is refused, naming \`hayven worktree prune\``,
    () => {
      const repo = makeRepo();
      // Sixteen REAL worktrees, registered straight into the registry (building
      // sixteen overlays would only slow the test; the cap counts registrations).
      const live = Array.from({ length: MAX_WORKTREE_OVERLAYS }, (_, i) => {
        const path = addWorktree(repo, join(repo, `.sirius/worktrees/live-${i}`));
        return { path, id: overlayId(path), created_at: new Date().toISOString(), seed_head: null };
      });
      writeFileSync(join(repo, ".hayven/worktrees.json"), JSON.stringify({ version: 1, worktrees: live }));

      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w17"));
      const refused = hv(repo, "worktree", "add", wt);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("hayven worktree prune");
      expect(existsSync(join(repo, ".hayven/worktrees", overlayId(wt)))).toBe(false);
      // Nothing live was pruned to make room.
      const reg = JSON.parse(readFileSync(join(repo, ".hayven/worktrees.json"), "utf8")) as { worktrees: unknown[] };
      expect(reg.worktrees.length).toBe(MAX_WORKTREE_OVERLAYS);
    },
    SLOW,
  );

  test(
    "at the cap, add first prunes DEAD registrations, then succeeds",
    () => {
      const repo = makeRepo();
      const dead = Array.from({ length: MAX_WORKTREE_OVERLAYS }, (_, i) => {
        const path = join(repo, `.sirius/worktrees/gone-${i}`);
        return { path, id: overlayId(path), created_at: new Date().toISOString(), seed_head: null };
      });
      writeFileSync(join(repo, ".hayven/worktrees.json"), JSON.stringify({ version: 1, worktrees: dead }));
      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w17"));
      const r = hv(repo, "worktree", "add", wt);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain(`pruned ${MAX_WORKTREE_OVERLAYS} overlay(s)`);
      const reg = JSON.parse(readFileSync(join(repo, ".hayven/worktrees.json"), "utf8")) as {
        worktrees: Array<{ path: string }>;
      };
      expect(reg.worktrees.map((e) => e.path)).toEqual([wt]);
    },
    SLOW,
  );

  test(
    "prune keeps entries when git cannot run (no positive evidence)",
    () => {
      const repo = makeRepo();
      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));
      expect(hv(repo, "worktree", "add", wt).code).toBe(0);
      // A PATH with no `git` on it: every git probe fails to spawn.
      const noGit = tmp("hv-wt-nogit-");
      const r = hvEnv(repo, { PATH: noGit }, "worktree", "prune", "--json");
      expect(json<{ removed: unknown[] }>(r).removed).toEqual([]);
      expect(existsSync(join(repo, ".hayven/worktrees", overlayId(wt), "index.sqlite"))).toBe(true);
      // A git that RUNS but fails (not "not a git repository") is no evidence either.
      const failing = tmp("hv-wt-badgit-");
      writeFileSync(join(failing, "git"), "#!/bin/sh\necho 'fatal: transient failure' >&2\nexit 1\n", { mode: 0o755 });
      const r2 = hvEnv(repo, { PATH: `${failing}:${process.env["PATH"] ?? ""}` }, "worktree", "prune", "--json");
      expect(json<{ removed: unknown[] }>(r2).removed).toEqual([]);
      // Real evidence still prunes.
      rmSync(wt, { recursive: true, force: true });
      expect(json<{ removed: unknown[] }>(hv(repo, "worktree", "prune", "--json")).removed.length).toBe(1);
    },
    SLOW,
  );

  test(
    "add refuses a worktree when the project is itself a linked worktree (unusable registration)",
    () => {
      const origin = tmp("hv-wt-origin-");
      git(origin, ["init", "-q", "-b", "main"]);
      git(origin, ["config", "user.email", "t@t.t"]);
      git(origin, ["config", "user.name", "t"]);
      write(origin, "src/a.ts", "export function existingFn() {\n  return 1;\n}\n");
      write(origin, ".gitignore", ".sirius/\n");
      git(origin, ["add", "-A"]);
      git(origin, ["commit", "-q", "-m", "base"]);
      // The hayven PROJECT lives in a linked worktree, not the main checkout.
      const project = addWorktree(origin, join(tmp("hv-wt-proj-"), "p"));
      expect(hv(project, "init", "--yes").code).toBe(0);
      const sibling = addWorktree(origin, join(tmp("hv-wt-sib-"), "s"));
      const r = hv(project, "worktree", "add", sibling);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("main checkout");
      expect(existsSync(join(project, ".hayven/worktrees.json"))).toBe(false);
    },
    SLOW,
  );

  test(
    "main's uncommitted edits never reach an overlay, even after `git stash`; main's index is untouched",
    () => {
      const repo = makeRepo();
      // Main edits a file and indexes the edit.
      write(repo, "src/a.ts", "export function existingFn() {\n  return 1;\n}\nexport function mainScratchFn() {\n  return 7;\n}\n");
      enableDirtyRecord(repo);
      expect(hv(repo, "ingest").code).toBe(0);
      expect(queryIds(repo, "mainScratchFn")).toContain("src/a/mainScratchFn");

      // Dirty main: a fresh overlay must not carry the edit.
      const w1 = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));
      const before = mainIndexFingerprint(repo);
      expect(hv(repo, "worktree", "add", w1).code).toBe(0);
      expect(queryIds(w1, "mainScratchFn")).toEqual([]);
      expect(queryIds(w1, "existingFn")).toContain("src/a/existingFn");
      // Overlay work leaves main's index and branch caches byte-identical.
      expect(mainIndexFingerprint(repo)).toEqual(before);

      // The stash repro: main is now CLEAN, but its index still holds the edit.
      git(repo, ["stash", "-q"]);
      expect(queryIds(repo, "mainScratchFn")).toContain("src/a/mainScratchFn");
      const w2 = addWorktree(repo, join(repo, ".sirius/worktrees/w2"));
      expect(hv(repo, "worktree", "add", w2).code).toBe(0);
      expect(queryIds(w2, "mainScratchFn")).toEqual([]);
      expect(queryIds(w2, "existingFn")).toContain("src/a/existingFn");
    },
    SLOW,
  );

  test(
    "a seed killed before its first reconcile never reads as fresh and never serves main's edits",
    async () => {
      const repo = makeRepo();
      write(repo, "src/a.ts", "export function existingFn() {\n  return 1;\n}\nexport function mainScratchFn() {\n  return 7;\n}\n");
      enableDirtyRecord(repo);
      expect(hv(repo, "ingest").code).toBe(0);
      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));

      // A `git` that parks on the post-seed `diff --name-status`, so we can kill
      // the CLI in the window between the seed's rename and its re-parse.
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("git not found");
      const shim = tmp("hv-wt-shim-");
      const sentinel = join(shim, "parked");
      writeFileSync(
        join(shim, "git"),
        `#!/bin/sh\ncase "$*" in *"diff --name-status"*) echo $$ > "${sentinel}"; exec sleep 60;; esac\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 },
      );
      const child = Bun.spawn([process.execPath, CLI, "worktree", "add", wt], {
        cwd: repo,
        env: {
          ...process.env,
          HAYVEN_HOME: home,
          HAYVEN_PORT: DEAD_PORT,
          HAYVEN_NATIVE_BIN: bin ?? "",
          PATH: `${shim}:${process.env["PATH"] ?? ""}`,
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      const deadline = Date.now() + 30_000;
      while (!existsSync(sentinel) && Date.now() < deadline) await Bun.sleep(50);
      expect(existsSync(sentinel)).toBe(true);
      const overlay = join(repo, ".hayven/worktrees", overlayId(wt), "index.sqlite");
      expect(existsSync(overlay)).toBe(true); // the seed is in place
      child.kill(9);
      await child.exited;
      try {
        process.kill(Number(readFileSync(sentinel, "utf8").trim()), 9);
      } catch {
        // already gone
      }

      const list = json<{ worktrees: Array<{ freshness: string }> }>(hv(repo, "worktree", "list", "--json"));
      expect(list.worktrees[0]?.freshness).not.toBe("fresh");
      expect(queryIds(wt, "mainScratchFn")).toEqual([]);
      expect(queryIds(wt, "existingFn")).toContain("src/a/existingFn");
      const after = json<{ worktrees: Array<{ freshness: string }> }>(hv(repo, "worktree", "list", "--json"));
      expect(after.worktrees[0]?.freshness).toBe("fresh");
    },
    SLOW,
  );

  test(
    "delete + rename in the worktree; an ownerless refresh lock does not stall reads; no-op refresh skips re-resolution",
    () => {
      const repo = makeRepo();
      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));
      expect(hv(repo, "worktree", "add", wt).code).toBe(0);

      // A clean, unchanged worktree: nothing to re-parse, so no resolver pass.
      const noop = json<{ reresolved: boolean; reparsed: number; deleted: number }>(hv(wt, "ingest", "--json"));
      expect(noop.reparsed).toBe(0);
      expect(noop.deleted).toBe(0);
      expect(noop.reresolved).toBe(false);

      git(wt, ["mv", "src/a.ts", "src/a2.ts"]);
      git(wt, ["rm", "-q", "src/a.test.ts"]);
      const ids = queryIds(wt, "existingFn");
      expect(ids).toContain("src/a2/existingFn");
      expect(ids).not.toContain("src/a/existingFn");
      expect(queryIds(wt, "a.test")).not.toContain("src/a.test");
      const changed = json<{ reresolved: boolean }>(hv(wt, "ingest", "--json"));
      expect(changed.reresolved).toBe(true);

      // A refresh lock left EMPTY by a process killed between open and write.
      writeFileSync(join(repo, ".hayven/worktrees", overlayId(wt), "refresh.lock"), "");
      write(wt, "src/late.ts", "export function lateFn() {\n  return 1;\n}\n");
      const t0 = Date.now();
      expect(queryIds(wt, "lateFn")).toContain("src/late/lateFn");
      expect(Date.now() - t0).toBeLessThan(30_000);
    },
    SLOW,
  );

  test(
    "a seed copied while main was mid-ingest is abandoned for a full parse, never amended",
    async () => {
      const repo = makeRepo();
      enableDirtyRecord(repo);
      expect(hv(repo, "ingest", "--full").code).toBe(0);
      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));
      const entry = { path: wt, id: overlayId(wt), created_at: new Date().toISOString(), seed_head: null };
      writeFileSync(join(repo, ".hayven/worktrees.json"), JSON.stringify({ version: 1, worktrees: [entry] }));

      // Make the COPY look exactly like one taken while a daemon ingest was
      // half-way through: main's own in-flight marker, and a file's rows gone.
      overlayTestHooks.afterSeedCopy = (tmpPath) => {
        const db = new Db(tmpPath);
        try {
          db.setStat("ingest_in_progress", JSON.stringify([{ t: "424242:main:ingest", at: Date.now() }]));
          db.deleteNodesByFile("src/a.ts");
        } finally {
          db.close();
        }
      };
      let result;
      try {
        result = await refreshOverlay(
          { paths: hayvenPathsFor(repo), config: loadConfig(repo).config, entry },
          { binary: bin ?? undefined },
        );
      } finally {
        delete overlayTestHooks.afterSeedCopy;
      }
      expect(result.seeded).toBe(false);
      expect(result.action).toBe("full");
      const overlay = new Db(join(repo, ".hayven/worktrees", entry.id, "index.sqlite"), { readonly: true });
      try {
        expect(overlay.nodeIdsForFile("src/a.ts")).toContain("src/a/existingFn");
        expect(overlay.checkIndexIntegrity().ok).toBe(true);
      } finally {
        overlay.close();
      }

      // "Pending seed" is accepted ONLY with the seed's own marker. The same
      // flag beside a FOREIGN in-progress marker means a partial graph: it must
      // be rebuilt, not amended.
      const forged = new Db(join(repo, ".hayven/worktrees", entry.id, "index.sqlite"));
      try {
        forged.setStat("overlay_seed_pending", "1");
        forged.setStat("overlay_fingerprint", "");
        forged.setStat("ingest_in_progress", JSON.stringify([{ t: "424242:main:ingest", at: Date.now() }]));
        forged.deleteNodesByFile("src/a.ts");
      } finally {
        forged.close();
      }
      expect(queryIds(wt, "existingFn")).toContain("src/a/existingFn");
    },
    SLOW,
  );

  test(
    "without a worktree registry, ingest runs no extra `git status`; with one it records source paths only",
    () => {
      const repo = makeRepo();
      const shim = gitShim();
      const env = { PATH: `${shim.dir}:${process.env["PATH"] ?? ""}` };
      write(repo, "src/a.ts", "export function existingFn() {\n  return 2;\n}\n");
      expect(hvEnv(repo, env, "ingest").code).toBe(0);
      const before = existsSync(shim.log) ? readFileSync(shim.log, "utf8") : "";
      expect(before.split("\n").filter((l) => / status /.test(` ${l} `))).toEqual([]);
      expect(mainStat(repo, LAST_INGEST_DIRTY_KEY)).toBeNull();

      enableDirtyRecord(repo);
      write(repo, "notes.md", "# not source\n");
      write(repo, "src/untracked.ts", "export const u = 1;\n");
      expect(hvEnv(repo, env, "ingest").code).toBe(0);
      expect(readFileSync(shim.log, "utf8")).toContain("status");
      expect(JSON.parse(mainStat(repo, LAST_INGEST_DIRTY_KEY) ?? "null")).toEqual(["src/a.ts", "src/untracked.ts"]);
    },
    SLOW,
  );

  test(
    "a slow or failing `git status` marks the record unknown (2s budget), and the next seed parses in full",
    () => {
      const repo = makeRepo();
      enableDirtyRecord(repo);
      write(repo, "src/a.ts", "export function existingFn() {\n  return 2;\n}\n");
      expect(hv(repo, "ingest").code).toBe(0);
      expect(JSON.parse(mainStat(repo, LAST_INGEST_DIRTY_KEY) ?? "null")).toEqual(["src/a.ts"]);

      const slow = gitShim(`case "$*" in *" status "*) exec sleep 8;; esac`);
      write(repo, "src/a.ts", "export function existingFn() {\n  return 3;\n}\n");
      const t0 = Date.now();
      expect(hvEnv(repo, { PATH: `${slow.dir}:${process.env["PATH"] ?? ""}` }, "ingest").code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(6_000);
      // Not deleted: marked unknown, sticky across incremental ingests.
      expect(mainStat(repo, LAST_INGEST_DIRTY_KEY)).toBe("unknown");
      expect(hv(repo, "ingest").code).toBe(0);
      expect(mainStat(repo, LAST_INGEST_DIRTY_KEY)).toBe("unknown");

      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));
      const added = json<{ seeded: boolean; action: string }>(hv(repo, "worktree", "add", wt, "--json"));
      expect(added.seeded).toBe(false);
      expect(added.action).toBe("full");
    },
    SLOW,
  );

  test(
    `more than ${DIRTY_RECORD_CAP} dirty source files records overflow, and the seed parses in full`,
    () => {
      const repo = makeRepo();
      enableDirtyRecord(repo);
      for (let i = 0; i <= DIRTY_RECORD_CAP; i++) write(repo, `src/gen/f${i}.ts`, `export const v${i} = ${i};\n`);
      expect(hv(repo, "ingest", "--full").code).toBe(0);
      expect(mainStat(repo, LAST_INGEST_DIRTY_KEY)).toBe("overflow");
      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));
      const added = json<{ seeded: boolean; action: string }>(hv(repo, "worktree", "add", wt, "--json"));
      expect(added.seeded).toBe(false);
      expect(added.action).toBe("full");
      expect(queryIds(wt, "v7")).toEqual([]); // main's untracked files never reach the overlay
    },
    SLOW,
  );

  test(
    "with no record yet, overlays are fully parsed (main's edits excluded) and the note prints once",
    () => {
      const repo = makeRepo();
      // Main indexed an edit, then stashed it, all BEFORE any registry existed.
      write(repo, "src/a.ts", "export function existingFn() {\n  return 1;\n}\nexport function mainScratchFn() {\n  return 7;\n}\n");
      expect(hv(repo, "ingest").code).toBe(0);
      git(repo, ["stash", "-q"]);
      const w1 = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));
      const w2 = addWorktree(repo, join(repo, ".sirius/worktrees/w2"));
      const r1 = hv(repo, "worktree", "add", w1, "--json");
      const r2 = hv(repo, "worktree", "add", w2, "--json");
      expect(json<{ action: string }>(r1).action).toBe("full");
      expect(r1.stderr).toContain("no record of which files were uncommitted");
      expect(r2.stderr).not.toContain("no record of which files were uncommitted");
      expect(queryIds(w1, "mainScratchFn")).toEqual([]);
      expect(queryIds(w2, "existingFn")).toContain("src/a/existingFn");
    },
    SLOW,
  );

  test(
    "worktree list says freshness is unknown, not gone, when git cannot run",
    () => {
      const repo = makeRepo();
      const wt = addWorktree(repo, join(repo, ".sirius/worktrees/w1"));
      expect(hv(repo, "worktree", "add", wt).code).toBe(0);
      const noGit = { PATH: tmp("hv-wt-nogit-") };
      const listed = json<{ worktrees: Array<{ freshness: string }> }>(hvEnv(repo, noGit, "worktree", "list", "--json"));
      expect(listed.worktrees[0]?.freshness).toBe("unknown");
      const text = hvEnv(repo, noGit, "worktree", "list");
      expect(text.stdout).not.toContain("hayven worktree prune");
      expect(text.stdout).toContain("unknown");
    },
    SLOW,
  );
});
