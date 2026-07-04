/**
 * `hayven branches` CLI — list + prune of per-branch index caches.
 *
 * Builds a temp project with a couple of real (migrated) per-branch index
 * sqlite files seeded with KNOWN node/coverage counts, makes one the active
 * branch via a hand-written `.git/HEAD`, and drives `runBranches` capturing
 * stdout. Mirrors the fixture style of `branch_index.test.ts` (hand-written
 * HEAD + `branchSqlitePath`) and the migrate-a-tiny-Db pattern the other db
 * tests use.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBranches } from "../src/cli/branches.ts";
import { branchSqlitePath } from "../src/db/branch_index.ts";
import { Db } from "../src/db/queries.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

/** Capture process.stdout/stderr writes for the duration of `fn`. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    err += s;
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** Seed a migrated sqlite index with `nodeCount` nodes + `covCount` coverage rows. */
function seedIndex(path: string, nodeCount: number, covCount: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Db(path);
  try {
    db.migrate();
    for (let i = 0; i < nodeCount; i++) {
      db.handle.run(
        "INSERT INTO nodes (id, name, qualified_name, kind) VALUES (?, ?, ?, ?)",
        [`n${i}`, `n${i}`, `mod:n${i}`, "function"],
      );
    }
    for (let i = 0; i < covCount; i++) {
      db.handle.run(
        "INSERT INTO test_coverage (test, entity, weight, source) VALUES (?, ?, ?, ?)",
        [`t${i}`, `mod:n${i}`, 1, "test"],
      );
    }
  } finally {
    db.close();
  }
}

let projectCwd: string | undefined;
const origCwd = process.cwd();

afterEach(() => {
  process.chdir(origCwd);
  if (projectCwd) {
    rmSync(projectCwd, { recursive: true, force: true });
    projectCwd = undefined;
  }
});

/**
 * Build a temp project: a `.hayven/` dir (so `requireProject` succeeds), a
 * `.git/HEAD` on `active`, and two per-branch indexes — the active one (5 nodes
 * / 3 coverage) and a stale `other` one (2 nodes / 0 coverage). `chdir`s into it
 * so `requireProject()` resolves it. Returns the project root.
 */
function buildProject(opts: { legacy?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-branches-cli-"));
  const paths = hayvenPathsFor(root);
  mkdirSync(paths.hayvenDir, { recursive: true });
  // Active branch = `active`.
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/active\n");

  seedIndex(branchSqlitePath(paths, "active"), 5, 3);
  seedIndex(branchSqlitePath(paths, "other"), 2, 0);

  if (opts.legacy) {
    seedIndex(paths.sqliteFile, 9, 0);
  }

  process.chdir(root);
  projectCwd = root;
  return root;
}

describe("hayven branches (list)", () => {
  test("lists both branch caches with correct counts + the active marker", async () => {
    buildProject();
    const { code, out } = await capture(() => runBranches({ positionals: [], flags: {} }));
    expect(code).toBe(0);
    // Both branch keys present.
    expect(out).toContain("active");
    expect(out).toContain("other");
    // The active branch is marked.
    const activeLine = out.split("\n").find((l) => l.includes("active"))!;
    expect(activeLine).toContain("*");
    expect(activeLine).toContain("(active)");
    // Counts: active = 5 nodes / 3 coverage; other = 2 nodes / 0 coverage.
    expect(activeLine).toContain("5 node(s)");
    expect(activeLine).toContain("3 coverage row(s)");
    const otherLine = out.split("\n").find((l) => l.includes("`other`"))!;
    expect(otherLine).toContain("2 node(s)");
    expect(otherLine).toContain("0 coverage row(s)");
  });

  test("shows the legacy index labeled when present", async () => {
    buildProject({ legacy: true });
    const { code, out } = await capture(() => runBranches({ positionals: [], flags: {} }));
    expect(code).toBe(0);
    expect(out).toContain("(legacy)");
    const legacyLine = out.split("\n").find((l) => l.includes("(legacy)"))!;
    expect(legacyLine).toContain("9 node(s)");
  });

  test("--json emits the structured array shape", async () => {
    buildProject({ legacy: true });
    const { code, out } = await capture(() =>
      runBranches({ positionals: [], flags: { json: true } }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    const active = parsed.find((e) => e.key === "active")!;
    expect(active).toBeDefined();
    expect(active.active).toBe(true);
    expect(active.legacy).toBe(false);
    expect(active.nodes).toBe(5);
    expect(active.coverageRows).toBe(3);
    expect(typeof active.sizeBytes).toBe("number");
    expect((active.sizeBytes as number) > 0).toBe(true);
    expect(typeof active.mtimeMs).toBe("number");
    expect(typeof active.path).toBe("string");

    const legacy = parsed.find((e) => e.key === "(legacy)")!;
    expect(legacy.legacy).toBe(true);
    expect(legacy.active).toBe(false);
  });

  test("a corrupt branch index is listed gracefully (null counts), never crashes", async () => {
    const root = buildProject();
    const paths = hayvenPathsFor(root);
    // Clobber `other`'s index with garbage so it can't be opened/read.
    writeFileSync(branchSqlitePath(paths, "other"), "not a sqlite file");
    const { code, out } = await capture(() =>
      runBranches({ positionals: [], flags: { json: true } }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
    const other = parsed.find((e) => e.key === "other")!;
    expect(other).toBeDefined();
    expect(other.nodes).toBeNull();
    expect(other.coverageRows).toBeNull();
    // The healthy active branch still reports real counts.
    const active = parsed.find((e) => e.key === "active")!;
    expect(active.nodes).toBe(5);
  });
});

describe("hayven branches --prune", () => {
  test("--prune --keep 1 removes the non-active, non-kept branch; keeps active + legacy", async () => {
    const root = buildProject({ legacy: true });
    const paths = hayvenPathsFor(root);
    // Add a third non-active branch so keep=1 forces at least one removal of a
    // NON-active branch (active is never counted against keep).
    seedIndex(branchSqlitePath(paths, "third"), 1, 0);

    const { code, out } = await capture(() =>
      runBranches({ positionals: [], flags: { prune: true, keep: "1" } }),
    );
    expect(code).toBe(0);
    expect(out).toContain("Removed");

    // The active branch index survives.
    expect(existsSync(branchSqlitePath(paths, "active"))).toBe(true);
    // The legacy index is NEVER touched.
    expect(existsSync(paths.sqliteFile)).toBe(true);
    // keep=1 keeps exactly one non-active branch; the other was removed.
    const otherExists = existsSync(branchSqlitePath(paths, "other"));
    const thirdExists = existsSync(branchSqlitePath(paths, "third"));
    expect([otherExists, thirdExists].filter(Boolean).length).toBe(1);
  });

  test("--prune --keep 1 --json reports removals + bytes reclaimed, never the active/legacy", async () => {
    const root = buildProject({ legacy: true });
    const paths = hayvenPathsFor(root);
    seedIndex(branchSqlitePath(paths, "third"), 1, 0);

    const { code, out } = await capture(() =>
      runBranches({ positionals: [], flags: { prune: true, keep: "1", json: true } }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      pruned: Array<{ key: string }>;
      removedCount: number;
      bytesReclaimed: number;
      kept: string[];
    };
    expect(parsed.removedCount).toBeGreaterThanOrEqual(1);
    expect(parsed.bytesReclaimed).toBeGreaterThan(0);
    // Active branch is never pruned and is always kept.
    expect(parsed.kept).toContain("active");
    for (const r of parsed.pruned) {
      expect(r.key).not.toBe("active");
      expect(r.key).not.toBe("(legacy)");
    }
  });
});

describe("hayven branches (graceful edges)", () => {
  test("project with no branches dir prints a friendly message and exits 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "hayven-branches-cli-empty-"));
    const paths = hayvenPathsFor(root);
    mkdirSync(paths.hayvenDir, { recursive: true });
    // No .git, no branches dir, no legacy index.
    process.chdir(root);
    projectCwd = root;
    const { code, out } = await capture(() => runBranches({ positionals: [], flags: {} }));
    expect(code).toBe(0);
    expect(out).toContain("No per-branch index caches");
  });

  test("outside a project (no .hayven) returns 1 with a friendly error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-branches-cli-noproj-"));
    process.chdir(dir);
    projectCwd = dir;
    const { code, err } = await capture(() => runBranches({ positionals: [], flags: {} }));
    expect(code).toBe(1);
    expect(err).toContain("error:");
  });
});
