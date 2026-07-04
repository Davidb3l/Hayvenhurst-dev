/**
 * Regression guard for the daemon ↔ branch-index split (the `affected-tests`
 * silent-break bug).
 *
 * The bug: `daemon/src/cli/daemon.ts` opened the LEGACY `.hayven/index.sqlite`
 * verbatim (`new Db(paths.sqliteFile)`), while `init`/reindex and the daemonless
 * read path (`openProjectDb` → `resolveReadIndex`) write/read the PER-BRANCH
 * index `.hayven/branches/<key>/index.sqlite`. So trace-coverage POSTs handled
 * by the daemon (which writes through `deps.db`) landed in the legacy index,
 * while graph NODES lived in the branch index — and a daemonless
 * `affectedTests` read (branch index) saw ZERO coverage.
 *
 * The fix: the daemon now opens `resolveWriteIndex(paths, config).path`, which
 * mirrors `resolveReadIndex`'s branch resolution, so coverage + nodes co-locate.
 *
 * Test approach — chosen for determinism, NOT a full HTTP daemon:
 *  (1) UNIT identity: assert the path `daemon.ts` would open
 *      (`resolveWriteIndex(...).path`) EQUALS the path the daemonless read path
 *      resolves (`resolveReadIndex(...).path`) for the SAME project+branch. This
 *      is the precise invariant the fix restores; before the fix the daemon
 *      ignored both and used `paths.sqliteFile`, so this is the load-bearing
 *      assertion. No native binary / no HTTP server → fully deterministic.
 *  (2) CO-LOCATION e2e: open the daemon's WRITE index, seed nodes + drive
 *      coverage in through the SAME `db.insertTestCoverage` call the
 *      `/api/traces/observations` route uses (`traces.ts`), close it, then run a
 *      daemonless `affectedTests` read against the READ-resolved index and assert
 *      it SEES that coverage (observed tier non-empty). Because (1) proves the two
 *      paths resolve to the same file, this read goes through the same DB the
 *      daemon wrote — exactly the production path, minus the HTTP shell.
 *
 * A temp GIT repo with `.hayven/branches/<key>/` present makes per-branch
 * indexing ACTIVE (no native binary needed — we create the branch index file
 * ourselves and migrate it), so the resolvers pick the branch index, not the
 * legacy fallback.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import {
  branchKey,
  branchSqlitePath,
  resolveReadIndex,
  resolveWriteIndex,
} from "../src/db/branch_index.ts";
import { Db } from "../src/db/queries.ts";
import { affectedTests } from "../src/db/affected_tests.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

/** Minimal git repo with a `.hayven/` so per-branch indexing applies. */
function git(repo: string, args: string[]): void {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

/** Seed a node whose bare `name` == `qualified_name` so a coverage row by name
 *  resolves unambiguously to this id (same pattern as affected_tests.test.ts). */
function seedNode(db: Db, id: string, name: string, file: string, language = "typescript"): void {
  db.upsertNode({
    id,
    name,
    qualified_name: name,
    kind: "function",
    language,
    file,
    range: [1, 10],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

describe("daemon branch-index coverage co-location", () => {
  let repo: string;
  let paths: ReturnType<typeof hayvenPathsFor>;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "hayven-daemon-branch-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    // A `.hayven/` makes this an initialized project for the path resolvers.
    mkdirSync(join(repo, ".hayven"), { recursive: true });
    paths = hayvenPathsFor(repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("daemon WRITE index == daemonless READ index for the same project+branch", () => {
    // Sanity: we are on a real branch, so per-branch indexing is active.
    expect(branchKey(repo)).toBe("main");

    // Create the branch index the way `init`/reindex would (resolveWriteIndex
    // creates the dir; we materialize the file by migrating a Db there).
    const write = resolveWriteIndex(paths, DEFAULT_CONFIG);
    expect(write.branchKey).toBe("main");
    expect(write.path).toBe(branchSqlitePath(paths, "main"));
    {
      const seed = new Db(write.path);
      seed.migrate();
      seed.close();
    }

    // THE INVARIANT the fix restores: the daemon opens resolveWriteIndex(...).path;
    // the daemonless read path opens resolveReadIndex(...).path. They must match.
    const read = resolveReadIndex(paths, DEFAULT_CONFIG);
    expect(read.path).toBe(write.path);
    // And critically NOT the legacy index (the pre-fix daemon target).
    expect(write.path).not.toBe(paths.sqliteFile);
  });

  test("coverage written to the daemon index is SEEN by a daemonless affectedTests read", () => {
    // 1) The daemon's index (resolveWriteIndex). Seed nodes + drive coverage
    //    through the SAME db.insertTestCoverage the traces route uses.
    const write = resolveWriteIndex(paths, DEFAULT_CONFIG);
    {
      const db = new Db(write.path);
      db.migrate();
      seedNode(db, "src/sym", "symFn", "src/sym.ts");
      seedNode(db, "tests/test_covers", "test_covers", "tests/test_covers.py", "python");
      // Exactly what daemon/src/daemon/routes/traces.ts calls on a coverage POST.
      db.insertTestCoverage([{ test: "test_covers", entity: "symFn", weight: 6, source: "py" }]);
      db.close();
    }

    // 2) The daemonless read path (resolveReadIndex) — what `hayven affected-tests`
    //    opens via openProjectDb. With the fix it is the SAME file as (1).
    const read = resolveReadIndex(paths, DEFAULT_CONFIG);
    expect(read.path).toBe(write.path);

    const db = new Db(read.path, { readonly: true });
    try {
      const res = affectedTests(db, "src/sym");
      // The precise per-test coverage path fired → coverage is co-located, NOT
      // stranded in a separate legacy index (the bug would yield 0 tests here).
      expect(res.precise).toBe(true);
      expect(res.tests.length).toBeGreaterThan(0);
      const covers = res.tests.find((t) => t.id === "tests/test_covers");
      expect(covers).toBeDefined();
      expect(covers!.evidence).toBe("trace");
      expect(covers!.confidence).toBe("observed");
    } finally {
      db.close();
    }
  });

  test("outside per-branch caching the daemon still targets the legacy index (no-git path unchanged)", () => {
    // Disable per-branch indexing → resolveWriteIndex must return the legacy file,
    // identical to the pre-feature behavior, so this fix is a no-op there.
    const noBranchConfig = {
      ...DEFAULT_CONFIG,
      index: { ...DEFAULT_CONFIG.index, perBranch: false },
    };
    const write = resolveWriteIndex(paths, noBranchConfig);
    expect(write.branchKey).toBeNull();
    expect(write.path).toBe(paths.sqliteFile);
    // Matches the read path too.
    expect(resolveReadIndex(paths, noBranchConfig).path).toBe(paths.sqliteFile);
  });
});
