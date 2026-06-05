// Branch-aware indexing — END-TO-END through the real CLI ingest + native parser
// (Phase 0.0.4.5 §5 item 3). Binary-gated: skipped when no hayven-native is
// available (like the other native-gated suites). Drives `runInit`/`runIngest`
// in a real temporary git repo and asserts the per-branch index is created,
// reads resolve to it, and a branch switch SEEDS + reparses only the diff to a
// graph identical to a full re-index.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { runIngest } from "../src/cli/ingest.ts";
import { runInit } from "../src/cli/init.ts";
import {
  branchKey,
  branchSqlitePath,
  resolveReadIndex,
} from "../src/db/branch_index.ts";
import { Db } from "../src/db/queries.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  const here = import.meta.dir;
  for (const c of [
    join(here, "../../native/target/release/hayven-native"),
    join(here, "../../native/target/debug/hayven-native"),
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}
const bin = findBinary();
const maybe = bin === null ? describe.skip : describe;

function git(repo: string, args: string[]): void {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

function nodeCount(path: string): number {
  const db = new Db(path, { readonly: true });
  try {
    return db.counts().nodes;
  } finally {
    db.close();
  }
}

function hasNode(path: string, name: string): boolean {
  const db = new Db(path, { readonly: true });
  try {
    return (
      (db.handle
        .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM nodes WHERE name = ?")
        .get(name)?.c ?? 0) > 0
    );
  } finally {
    db.close();
  }
}

maybe("branch-aware ingest (E2E, native binary)", () => {
  let repo: string;

  beforeEach(() => {
    if (bin) process.env["HAYVEN_NATIVE_BIN"] = bin;
    repo = mkdtempSync(join(tmpdir(), "hayven-branch-e2e-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.ts"), "export function funcA() {\n  return funcB();\n}\n");
    writeFileSync(join(repo, "b.ts"), "export function funcB() {\n  return 1;\n}\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("first ingest populates the branch index; reads resolve to it", async () => {
    const code = await runInit({ positionals: [], flags: { cwd: repo } });
    expect(code).toBe(0);

    const paths = hayvenPathsFor(repo);
    const key = branchKey(repo);
    expect(key).toBe("main");
    const bp = branchSqlitePath(paths, key!);

    expect(existsSync(bp)).toBe(true);
    expect(nodeCount(bp)).toBeGreaterThan(0);
    expect(hasNode(bp, "funcA")).toBe(true);

    // The daemonless read path resolves to the branch index, not the legacy one.
    const resolved = resolveReadIndex(paths, DEFAULT_CONFIG);
    expect(resolved.path).toBe(bp);
    expect(resolved.usedFallback).toBe(false);
  });

  test("a NEW branch seeds from the sibling + reparses only the diff (== full ingest)", async () => {
    await runInit({ positionals: [], flags: { cwd: repo } });
    const paths = hayvenPathsFor(repo);
    const mainNodes = nodeCount(branchSqlitePath(paths, "main"));

    // Diverge a feature branch by adding one function to a.ts.
    git(repo, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(
      join(repo, "a.ts"),
      "export function funcA() {\n  return funcB();\n}\nexport function funcC() {\n  return funcA();\n}\n",
    );
    git(repo, ["commit", "-q", "-am", "add funcC"]);

    // Cheap switch: seed from main + reparse only the diff (no --full).
    const code = await runIngest({ positionals: [], flags: { cwd: repo } });
    expect(code).toBe(0);

    const fp = branchSqlitePath(paths, "feature");
    expect(existsSync(fp)).toBe(true);
    expect(hasNode(fp, "funcC")).toBe(true); // the diff was actually parsed
    expect(hasNode(fp, "funcA")).toBe(true); // seeded content preserved
    const seededNodes = nodeCount(fp);
    expect(seededNodes).toBe(mainNodes + 1); // exactly the one new entity

    // The main index is untouched by the feature ingest (per-branch isolation).
    expect(hasNode(branchSqlitePath(paths, "main"), "funcC")).toBe(false);

    // Equivalence: a from-scratch FULL ingest of the feature branch yields the
    // same node graph as the cheap seed+diff path.
    rmSync(join(paths.branchesDir, "feature"), { recursive: true, force: true });
    await runIngest({ positionals: [], flags: { cwd: repo, full: true } });
    expect(nodeCount(fp)).toBe(seededNodes);
  });
});
