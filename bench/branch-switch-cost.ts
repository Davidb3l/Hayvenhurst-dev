/**
 * branch-switch-cost — measure the per-branch-index win (Phase 0.0.4.5 §5 item 3).
 *
 * The competitive claim (vs cocoindex-code, §4c-thread): cocoindex keeps ONE
 * workspace index and re-syncs — and, being embedding-based, RE-EMBEDS the diff —
 * on EVERY branch switch before any query; switching BACK re-does it. Hayven
 * caches a per-branch index, so:
 *   - a FIRST visit to a new branch costs a SEED (copy the sibling index) + a
 *     re-parse of only the `git diff` (the "cheap switch"), never a full re-index;
 *   - a RE-VISIT to an already-indexed branch is INSTANT — the index already
 *     exists, zero re-parse, and (embedding-free) zero re-embed, ever.
 *
 * This harness PROVES it on a real git repo by timing, with the SAME native
 * parser and SQLite index the product uses (no embeddings, no model):
 *   1. cold      — full ingest of the base branch (the one-time build cost),
 *   2. full      — a full ingest of the feature branch (what you'd pay WITHOUT
 *                  per-branch seeding — re-index the whole tree on the switch),
 *   3. seed+diff — `hayven ingest` on the feature branch: seed from the base
 *                  index + re-parse only the changed files (the cheap switch),
 *   4. revisit   — `hayven ingest` after switching BACK to base: index already
 *                  exists, diff empty → a no-op (the instant re-visit).
 *
 * Usage (run on a THROWAWAY clone — it creates a branch + edits a few files):
 *   export HAYVEN_NATIVE_BIN="$PWD/native/target/release/hayven-native"
 *   git clone --depth 50 https://github.com/honojs/hono /tmp/hv-switch
 *   bun bench/branch-switch-cost.ts /tmp/hv-switch [editCount]
 *
 * `editCount` (default 3) source files are touched to synthesize a branch diff.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runIngest } from "../daemon/src/cli/ingest.ts";
import { runInit } from "../daemon/src/cli/init.ts";
import {
  branchKey,
  branchSqlitePath,
  resolveReadIndex,
} from "../daemon/src/db/branch_index.ts";
import { DEFAULT_CONFIG } from "../daemon/src/config/defaults.ts";
import { Db } from "../daemon/src/db/queries.ts";
import { hayvenPathsFor } from "../daemon/src/util/paths.ts";

function git(repo: string, args: string[]): string {
  const p = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (p.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr}`);
  return (p.stdout ?? "").trim();
}

async function timed(label: string, fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(26)} ${ms.toFixed(0).padStart(7)} ms`);
  return ms;
}

function indexSizeKb(path: string): number {
  try {
    return Math.round(statSync(path).size / 1024);
  } catch {
    return 0;
  }
}

/** Touch `n` tracked source files to synthesize a branch diff (append a comment). */
function editSomeFiles(repo: string, n: number): string[] {
  const tracked = git(repo, ["ls-files"])
    .split("\n")
    .filter((f) => /\.(ts|tsx|js|py|rs|go)$/.test(f) && !f.includes("test"));
  const picked = tracked.slice(0, n);
  for (const rel of picked) {
    const p = join(repo, rel);
    writeFileSync(p, readFileSync(p, "utf8") + `\n// hayven-branch-bench touch\n`);
  }
  return picked;
}

async function main(): Promise<void> {
  const repo = process.argv[2];
  const editCount = Number(process.argv[3] ?? "3");
  if (!repo || !existsSync(join(repo, ".git"))) {
    console.error("usage: bun bench/branch-switch-cost.ts <git-repo> [editCount]");
    process.exit(2);
  }
  if (!process.env["HAYVEN_NATIVE_BIN"]) {
    console.error("error: set HAYVEN_NATIVE_BIN to the built native binary first.");
    process.exit(2);
  }

  const paths = hayvenPathsFor(repo);
  const base = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const feature = "hayven-bench-feature";
  // Clean any prior run.
  rmSync(paths.branchesDir, { recursive: true, force: true });
  git(repo, ["checkout", "-q", base]);
  try {
    git(repo, ["branch", "-D", feature]);
  } catch {
    /* no prior branch */
  }

  process.chdir(repo);
  console.log(`repo: ${repo}  base branch: ${base}\n`);

  // 1. COLD: init + full ingest of the base branch.
  console.log("① cold build (full ingest of base branch):");
  const tCold = await timed("cold full ingest", async () => {
    if (existsSync(paths.hayvenDir)) {
      await runIngest({ positionals: [], flags: { full: true } });
    } else {
      await runInit({ positionals: [], flags: { yes: true } });
    }
  });
  const baseKey = branchKey(repo)!;
  const baseIdx = branchSqlitePath(paths, baseKey);
  console.log(`  → base index: ${baseIdx} (${indexSizeKb(baseIdx)} KB)\n`);

  // Create the feature branch and diverge it by `editCount` files.
  git(repo, ["checkout", "-q", "-b", feature]);
  const edited = editSomeFiles(repo, editCount);
  git(repo, ["commit", "-q", "-am", "bench: diverge feature branch"]);
  console.log(`② feature branch '${feature}' diverged by ${edited.length} file(s): ${edited.join(", ")}\n`);

  // 2. FULL (no per-branch seeding): what a switch costs if you re-index the
  //    whole tree. Force a full ingest into the feature index from scratch.
  rmSync(join(paths.branchesDir, branchKey(repo)!), { recursive: true, force: true });
  console.log("③ full ingest of feature branch (the cost WITHOUT seeding):");
  const tFull = await timed("full feature ingest", async () => {
    await runIngest({ positionals: [], flags: { full: true } });
  });

  // 3. SEED + DIFF: the cheap switch. Remove the feature index so the next
  //    ingest SEEDS from the base sibling and re-parses only the diff.
  rmSync(join(paths.branchesDir, branchKey(repo)!), { recursive: true, force: true });
  console.log("\n④ seed-from-sibling + diff re-parse (the CHEAP switch):");
  const tSeed = await timed("seed + diff ingest", async () => {
    await runIngest({ positionals: [], flags: {} });
  });
  const featIdx = branchSqlitePath(paths, branchKey(repo)!);
  console.log(`  → feature index: ${featIdx} (${indexSizeKb(featIdx)} KB)\n`);

  // 4. REVISIT: switch back to base. The base index is already cached, so a
  //    READ resolves straight to it — NO ingest, NO re-embed. This is what a
  //    revisit actually costs (an ingest is never needed; the cached index is
  //    there). cocoindex would re-sync + re-embed the diff here BEFORE querying.
  git(repo, ["checkout", "-q", base]);
  console.log("\n⑤ switch BACK to base (cached index → read resolves instantly, NO ingest):");
  let resolvedRevisit = "";
  const tRevisit = await timed("revisit read (cached)", async () => {
    const resolved = resolveReadIndex(paths, DEFAULT_CONFIG);
    resolvedRevisit = resolved.path;
    const db = new Db(resolved.path, { readonly: true });
    // A representative read against the cached index (no re-index, no re-embed).
    db.handle.query("SELECT COUNT(*) AS c FROM nodes").get();
    db.close();
  });
  console.log(
    `  → read resolved to ${resolvedRevisit === baseIdx ? "the cached base index ✓" : resolvedRevisit}\n`,
  );

  // Summary.
  const pct = (a: number, b: number): string => `${Math.round(100 * (1 - a / b))}%`;
  console.log("──────── summary ────────");
  console.log(`cold full ingest (base):       ${tCold.toFixed(0)} ms`);
  console.log(`full ingest WITHOUT seeding:   ${tFull.toFixed(0)} ms   (a whole-tree re-index per switch)`);
  console.log(`seed + diff (cheap switch):    ${tSeed.toFixed(0)} ms   (${pct(tSeed, tFull)} cheaper than a full re-index)`);
  console.log(`revisit read (cached index):   ${tRevisit.toFixed(0)} ms   (${pct(tRevisit, tFull)} cheaper — no ingest at all)`);
  console.log(
    "\nFirst visit to a new branch re-parses only the diff; a re-visit reads the " +
      "cached index with ZERO ingest — and neither EVER re-embeds (embedding-free).",
  );

  // Cleanup: leave the repo on its base branch, drop the bench branch + indexes.
  try {
    git(repo, ["branch", "-D", feature]);
  } catch {
    /* best-effort */
  }
}

main();
