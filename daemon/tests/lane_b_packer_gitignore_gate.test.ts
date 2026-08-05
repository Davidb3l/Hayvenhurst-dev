/**
 * LANE B / KNOWN_ISSUES #4 — the packer could read a GITIGNORED source file.
 *
 * `isDeniedRepoPath` and `isIndexerAdmissible` mirror the Rust walker's
 * hidden-path, always-pruned-dir and extension rules, plus a credential
 * denylist. Neither evaluates `.gitignore`. So a gitignored file that is
 * non-hidden, outside every pruned directory, and carries a source extension —
 * a generated `src/gen/keys.ts`, a committed-then-ignored
 * `src/config.local.ts` — could be named explicitly and read into a context
 * pack bound for a model, even though the walker keeps it out of the graph
 * entirely. The packer was strictly MORE permissive than the indexer on the one
 * path that feeds a prompt.
 *
 * The closure is `hayven-native check-ignored`, the Rust `ignore` crate answering
 * over NDJSON. These tests drive `resolveWithinRepo` /
 * `buildContextPackForChange` DIRECTLY, never through the MCP wire: the wire
 * rejects absolute paths and containment failures of its own and would
 * short-circuit the guard under test, which is exactly how a previous fix in
 * this area passed with itself deleted.
 *
 * Over-blocking is as real a bug as under-blocking here — this ships to a public
 * release — so most of this file is negative controls.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContextPackForChange, resolveWithinRepo } from "../src/db/context_pack.ts";
import {
  isPathExcludedByWalker,
  resetWalkerExclusionCache,
  walkerExclusionSpawnCount,
} from "../src/native/ignore.ts";
import { Db } from "../src/db/queries.ts";
import type { NodeKind } from "../src/graph/types.ts";

const CANARY = "CANARY-LANE-B-GITIGNORED";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `hayven-laneb-${tag}-`));
  dirs.push(root);
  return root;
}

/** `WalkBuilder::require_git` defaults to TRUE: outside a git repo the walker
 *  ignores `.gitignore` entirely. A fixture without this tests the wrong
 *  branch — and would pass with the whole gate deleted. */
function makeGitRepo(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
}

function write(root: string, rel: string, body: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** A repo whose `.gitignore` hides real, source-extension, non-hidden files. */
function makeRepo(): { root: string; db: Db } {
  const root = tmpRoot("gitignore");
  makeGitRepo(root);
  writeFileSync(join(root, ".gitignore"), "src/gen/\nconfig.local.ts\n*.secret.ts\n");

  write(root, "src/a.ts", "export function fa(): number {\n  return 1;\n}\n");
  // The residual class: ordinary source names, real payloads, all gitignored.
  write(root, "src/gen/keys.ts", `export const API_KEY = "${CANARY}";\n`);
  write(root, "src/config.local.ts", `export const DB_PASSWORD = "${CANARY}";\n`);
  write(root, "src/tokens.secret.ts", `export const T = "${CANARY}";\n`);

  const db = new Db(":memory:");
  db.migrate();
  db.upsertNode({
    id: "src/a.ts::fa",
    name: "fa",
    qualified_name: "src/a.ts::fa",
    kind: "function" as NodeKind,
    language: "typescript",
    file: "src/a.ts",
    range: [1, 3],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
  return { root, db };
}

/** Every spelling a client can send for the same gitignored file. */
const IGNORED_SPELLINGS = [
  "src/gen/keys.ts",
  "./src/gen/keys.ts",
  "src/../src/gen/keys.ts",
  "src/config.local.ts",
  "src/tokens.secret.ts",
];

beforeEach(() => {
  // Verdicts are cached per (root, directory) for a few seconds; a fresh cache
  // per test keeps one test's fixture from answering another's question.
  resetWalkerExclusionCache();
});

describe("#4 — a gitignored source file is refused", () => {
  it("resolveWithinRepo refuses every spelling", () => {
    const { root, db } = makeRepo();
    for (const rel of IGNORED_SPELLINGS) {
      expect({ rel, resolved: resolveWithinRepo(root, rel) }).toEqual({ rel, resolved: null });
    }
    db.close();
  });

  it("an ABSOLUTE spelling is refused too", () => {
    const { root, db } = makeRepo();
    expect(resolveWithinRepo(root, join(root, "src", "gen", "keys.ts"))).toBeNull();
    db.close();
  });

  it("the packer returns nothing and no canary escapes", () => {
    const { root, db } = makeRepo();
    for (const rel of IGNORED_SPELLINGS) {
      const pack = buildContextPackForChange(db, root, rel, [{ startLine: 1, endLine: 100 }]);
      // Grep the WHOLE serialized pack, not just the return shape.
      expect(JSON.stringify(pack)).not.toContain(CANARY);
      expect(pack).toBeNull();
    }
    db.close();
  });

  it("a gitignored DIRECTORY hides files that name no pattern themselves", () => {
    // `src/gen/` is the rule; `keys.ts` matches nothing on its own. A
    // basename-only implementation would let this through.
    const { root, db } = makeRepo();
    write(root, "src/gen/deeper/nested/tokens.ts", `export const T = "${CANARY}";\n`);
    expect(resolveWithinRepo(root, "src/gen/deeper/nested/tokens.ts")).toBeNull();
    db.close();
  });

  it("a NOT-YET-CREATED file inside a gitignored directory is refused", () => {
    // The gate deliberately does NOT skip paths that do not exist. Restoring an
    // existence guard (which looks like the safe framing) lets this through,
    // and every other test in this file would still pass — so this is the
    // assertion that makes the choice testable at all.
    const { root, db } = makeRepo();
    expect(resolveWithinRepo(root, "src/gen/not-written-yet.ts")).toBeNull();
    db.close();
  });
});

describe("#4 — the negative controls (over-blocking is the other bug)", () => {
  it("ordinary first-party source still resolves and still packs", () => {
    const { root, db } = makeRepo();
    expect(resolveWithinRepo(root, "src/a.ts")).not.toBeNull();
    expect(
      buildContextPackForChange(db, root, "src/a.ts", [{ startLine: 1, endLine: 3 }]),
    ).not.toBeNull();
    db.close();
  });

  it("a brand-new file that does not exist yet is NOT refused", () => {
    // A file the client is about to create is absent, not ignored, and
    // `context_for_change` exists to serve exactly that case. The oracle
    // answers by PATH (like `git check-ignore`), so this works without an
    // existence gate.
    const { root, db } = makeRepo();
    expect(resolveWithinRepo(root, "src/not-created-yet.ts")).not.toBeNull();
    db.close();
  });

  it("a nested !negation re-admits the file, as git resolves it", () => {
    // The semantics that make hand-rolling this in TypeScript a bad idea.
    const root = tmpRoot("negation");
    makeGitRepo(root);
    writeFileSync(join(root, ".gitignore"), "*.gen.ts\n");
    write(root, "src/a.gen.ts", "export const a = 1;\n");
    write(root, "src/keep/.gitignore", "!*.gen.ts\n");
    write(root, "src/keep/b.gen.ts", "export const b = 1;\n");

    expect(resolveWithinRepo(root, "src/a.gen.ts")).toBeNull();
    expect(resolveWithinRepo(root, "src/keep/b.gen.ts")).not.toBeNull();
  });

  it("outside a git repo a .gitignore is inert, matching require_git(true)", () => {
    // The walker applies git-sourced rules only inside a repo. Being STRICTER
    // than the walk is the same class of bug pointing the other way.
    const root = tmpRoot("nogit");
    writeFileSync(join(root, ".gitignore"), "src/gen/\n");
    write(root, "src/gen/keys.ts", "export const k = 1;\n");
    expect(resolveWithinRepo(root, "src/gen/keys.ts")).not.toBeNull();
  });

  it("a plain .ignore file applies even without git", () => {
    const root = tmpRoot("plainignore");
    writeFileSync(join(root, ".ignore"), "src/gen/\n");
    write(root, "src/gen/keys.ts", "export const k = 1;\n");
    expect(resolveWithinRepo(root, "src/gen/keys.ts")).toBeNull();
  });

  it("the CONDITIONAL walker prunes are still not mirrored", () => {
    // `--include-vendored` / `--include-fixtures` make these real indexed
    // nodes, so refusing to pack them would break the packer for no gain.
    const root = tmpRoot("conditional");
    makeGitRepo(root);
    for (const ok of ["src/vendor/dep.ts", "test/fixtures/app/index.ts", "examples/demo.ts"]) {
      write(root, ok, "export const x = 1;\n");
      expect({ ok, resolved: resolveWithinRepo(root, ok) !== null }).toEqual({
        ok,
        resolved: true,
      });
    }
  });

  it("this very repository's own tracked source still resolves", () => {
    // The realest negative control available: a large, genuinely git-tracked
    // repo with a real multi-rule `.gitignore` (and a global one, and whatever
    // the developer's `core.excludesFile` says). If this gate is over-broad,
    // hayven stops working on its own codebase.
    const repo = join(import.meta.dir, "..", "..");
    for (const rel of [
      "daemon/src/db/context_pack.ts",
      "daemon/src/native/ignore.ts",
      "daemon/src/daemon/routes/viewer.ts",
      "native/src/ignore_query.rs",
      "native/src/parse/scope.rs",
    ]) {
      expect({ rel, resolved: resolveWithinRepo(repo, rel) !== null }).toEqual({
        rel,
        resolved: true,
      });
    }
  });
});

describe("#4 — failure posture is CLOSED", () => {
  const ORIGINAL = process.env["HAYVEN_NATIVE_BIN"];
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env["HAYVEN_NATIVE_BIN"];
    else process.env["HAYVEN_NATIVE_BIN"] = ORIGINAL;
    resetWalkerExclusionCache();
  });

  /** Point the locator at a stand-in binary, since `$HAYVEN_NATIVE_BIN` is the
   *  first candidate `tryLocateNativeBinary` tries. */
  function withBinary<T>(path: string, fn: () => T): T {
    process.env["HAYVEN_NATIVE_BIN"] = path;
    resetWalkerExclusionCache();
    try {
      return fn();
    } finally {
      if (ORIGINAL === undefined) delete process.env["HAYVEN_NATIVE_BIN"];
      else process.env["HAYVEN_NATIVE_BIN"] = ORIGINAL;
      resetWalkerExclusionCache();
    }
  }

  it("an OLD binary without the subcommand refuses a legitimate file", () => {
    // Version skew is the realistic failure: clap exits 2 on an unknown
    // subcommand. Treating that as "not ignored" would silently reinstate the
    // hole on exactly the machines where the binary is stale.
    const { root, db } = makeRepo();
    const shim = tmpRoot("oldbin");
    const bin = join(shim, "hayven-native");
    writeFileSync(bin, "#!/bin/sh\nexit 2\n");
    chmodSync(bin, 0o755);

    withBinary(bin, () => {
      expect(resolveWithinRepo(root, "src/a.ts")).toBeNull();
    });
    // …and the same file resolves again once the real binary is back.
    resetWalkerExclusionCache();
    expect(resolveWithinRepo(root, "src/a.ts")).not.toBeNull();
    db.close();
  });

  it("an unrunnable binary refuses a legitimate file", () => {
    const { root, db } = makeRepo();
    const shim = tmpRoot("badbin");
    const bin = join(shim, "hayven-native");
    writeFileSync(bin, "not an executable\n");
    chmodSync(bin, 0o644);

    withBinary(bin, () => {
      expect(resolveWithinRepo(root, "src/a.ts")).toBeNull();
    });
    db.close();
  });

  it("a binary that emits a short/garbled response refuses", () => {
    const { root, db } = makeRepo();
    const shim = tmpRoot("liarbin");
    const bin = join(shim, "hayven-native");
    // Well-formed JSON, wrong arity — a response we cannot line up with the
    // request is not an answer.
    writeFileSync(bin, '#!/bin/sh\necho \'{"ignored":[]}\'\n');
    chmodSync(bin, 0o755);

    withBinary(bin, () => {
      expect(resolveWithinRepo(root, "src/a.ts")).toBeNull();
    });
    db.close();
  });
});

describe("#4 — the synchronous constraint: one spawn per DIRECTORY", () => {
  it("a sibling's verdict comes back in the same round-trip", () => {
    // The packer runs inside the stdio MCP server and cannot await a
    // subprocess per file read. The native op answers the whole directory, so
    // asking about one file must answer for its siblings with NO second spawn.
    // Counting spawns is the only honest way to assert this: a per-file query
    // populates the same cache key and would look identical by cache size.
    const { root, db } = makeRepo();
    resetWalkerExclusionCache();
    expect(walkerExclusionSpawnCount()).toBe(0);

    expect(isPathExcludedByWalker(root, "src/a.ts")).toBe(false);
    expect(walkerExclusionSpawnCount()).toBe(1);

    // Siblings in the SAME directory — answered from the first response.
    expect(isPathExcludedByWalker(root, "src/config.local.ts")).toBe(true);
    expect(isPathExcludedByWalker(root, "src/tokens.secret.ts")).toBe(true);
    expect(walkerExclusionSpawnCount()).toBe(1);

    // A different directory is a genuinely new question.
    expect(isPathExcludedByWalker(root, "src/gen/keys.ts")).toBe(true);
    expect(walkerExclusionSpawnCount()).toBe(2);
    db.close();
  });

  it("a whole context pack costs a handful of spawns, not one per read", () => {
    // The end-to-end shape of the constraint: an assembled pack touches the
    // target plus its neighbours, and must not pay a round-trip per file.
    const { root, db } = makeRepo();
    for (const rel of ["src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]) {
      write(root, rel, "export const x = 1;\n");
    }
    resetWalkerExclusionCache();
    for (const rel of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]) {
      expect(resolveWithinRepo(root, rel)).not.toBeNull();
    }
    expect(walkerExclusionSpawnCount()).toBe(1);
    db.close();
  });
});
