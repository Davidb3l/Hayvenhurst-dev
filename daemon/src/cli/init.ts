/**
 * `hayven init` — create `.hayven/` in the current project.
 *
 * Steps (per PRD section 15 / Week 1):
 *   1. Detect repo root.
 *   2. Create directory tree.
 *   3. Write default config.json.
 *   4. Initialize SQLite + schema.
 *   5. Copy the skill template (if present) into each agent's skills dir —
 *      `.claude/skills/` (Claude Code) and `.agents/skills/` (cross-vendor:
 *      OpenAI Codex native, Gemini CLI alias) — as the open `SKILL.md` standard.
 *   6. Trigger a first ingest (delegates to ingest.ts).
 *   7. Print a summary.
 *
 * If `.hayven/` exists already, refuse with a friendly message.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { DEFAULT_CONFIG } from "../config/defaults.ts";
import { loadConfig, writeConfig } from "../config/load.ts";
import { isRegistrableRoot, registerProject } from "../daemon/registry.ts";
import { hotAddToRunningDaemon } from "./_shared.ts";
import { Db } from "../db/queries.ts";
import {
  countIndexableFiles,
  detectRepoRoot,
  hayvenPathsFor,
  rootConfirmDecision,
  type BoundedFileCount,
} from "../util/paths.ts";
import type { ParsedArgs } from "../cli.ts";
import { runIngest } from "./ingest.ts";

/**
 * Default `--max-files` ceiling for a first ingest.
 *
 * Sized to be far above any single repo an agent realistically navigates
 * (Hayvenhurst's own bench corpus tops out in the low thousands; the largest
 * mainstream OSS monorepos are tens of thousands) and far BELOW the trees that
 * caused the incident — a Mac home dir or `~/Library` runs to hundreds of
 * thousands of files. A genuinely huge single repo trips it, which is the
 * intended trade: a loud, one-flag-overridable refusal beats six hours of
 * silent 98%-CPU indexing.
 */
export const DEFAULT_MAX_INIT_FILES = 50_000;

/**
 * Parse `--max-files`: a positive integer ceiling, `null` for "no ceiling"
 * (`off`/`none`/`0`), or an `Error` describing a bad value. Never silently
 * falls back to the default on a typo — `--max-files=1O000` (letter O) must not
 * quietly re-arm the unbounded walk.
 */
export function parseMaxFiles(flag: string | boolean | undefined): number | null | Error {
  if (flag === undefined) return DEFAULT_MAX_INIT_FILES;
  if (flag === true) return new Error("--max-files needs a value, e.g. --max-files=200000 or --max-files=off");
  const raw = String(flag).trim().toLowerCase();
  if (raw === "off" || raw === "none" || raw === "0") return null;
  if (!/^[0-9]+$/.test(raw)) {
    return new Error(`--max-files must be a positive integer, "off" or "none" (got ${JSON.stringify(String(flag))})`);
  }
  const n = Number(raw);
  // Normalize AFTER parsing, not just on the literal "0": `--max-files=00` is
  // still zero, and a ceiling of zero would reject every directory on earth
  // with a nonsensical "contains 1 files, above the ceiling of 0".
  return n === 0 ? null : n;
}

/**
 * The refusal message for a pre-flight scan, or `null` to proceed.
 *
 * FAILS CLOSED on an incomplete scan. `exact: false` means the counter hit its
 * own cap or time budget, so `count` is a LOWER BOUND and `exceeded: false`
 * means "did not prove it is over", not "is under". A ceiling that waves
 * through the case it could not measure is not a ceiling — and a tree too slow
 * to finish counting (a cold `~/Library`, a network mount) is exactly the one
 * worth refusing.
 *
 * Separate from {@link runInit} so the verdict is testable without a filesystem
 * big or slow enough to hit the counter's own bounds.
 */
export function ceilingVerdict(root: string, scan: BoundedFileCount, ceiling: number): string | null {
  if (!scan.exceeded && scan.exact) return null;
  const found = scan.exact
    ? `${scan.count.toLocaleString()} files`
    : `at least ${scan.count.toLocaleString()} files (the count did not finish)`;
  // Naming `ceiling * 10` would be useless when the scan stopped AT that cap:
  // the re-run counts higher and fails identically. Only suggest a number when
  // we actually know one.
  const raise = scan.exact
    ? `  hayven init --max-files=${scan.count}   # accept this tree's ${scan.count.toLocaleString()} files\n`
    : "";
  return (
    `error: refusing to initialize ${root} — it contains ${found},\n` +
    `at or above the --max-files ceiling of ${ceiling.toLocaleString()}.\n\n` +
    "The first ingest walks and parses every one of them. A count this large\n" +
    "almost always means this root is not a single project — a home dir,\n" +
    "/Users, ~/Library, or a mounted volume. Indexing one of those pegs a\n" +
    "core for hours and writes a multi-hundred-MB index.\n\n" +
    "If it really is one project, re-run with an explicit ceiling:\n" +
    raise +
    "  hayven init --max-files=off   # no ceiling at all\n"
  );
}

export async function runInit(args: ParsedArgs): Promise<number> {
  const cwd = (typeof args.flags["cwd"] === "string" ? args.flags["cwd"] : undefined) ?? process.cwd();
  const { root, reason } = detectRepoRoot(cwd);

  // Reject `$HOME` BEFORE creating anything. The `registerProject` call in
  // step 5d is deliberately best-effort (a registry failure must not fail an
  // otherwise-good init), so its throw is swallowed — meaning without this
  // check, `hayven init` in the home dir would build the project tree and then
  // run step 6's first ingest across the user's ENTIRE home directory.
  if (!isRegistrableRoot(root)) {
    process.stderr.write(
      `error: refusing to initialize ${root} as a project — \`~/.hayven\` is the\n` +
        "global config dir, not a project marker. cd into a repository first.\n",
    );
    return 1;
  }

  const paths = hayvenPathsFor(root);

  if (existsSync(paths.hayvenDir)) {
    process.stderr.write(
      `error: .hayven/ already exists at ${paths.hayvenDir}\n` +
        "Use `hayven reindex` to rebuild the index, or `rm -rf .hayven/` to start fresh.\n",
    );
    return 1;
  }

  // Bound the work BEFORE creating anything.
  //
  // `isRegistrableRoot` above is a two-item denylist: it blocks `$HOME` and
  // `/`, and nothing else. `~/Library`, `~/Documents`, `/Users`, `/Volumes`
  // and `/System` all pass it today, and `hayven init` in any of them creates
  // the project and then walks it — `~/Library/Python/site-packages` is the
  // tree that produced most of the incident's 195 GB. The lesson of that
  // incident was not "home is special", it was "an unbounded walk with no
  // ceiling and no warning". So: count first, and refuse loudly.
  const ceiling = parseMaxFiles(args.flags["max-files"]);
  if (ceiling instanceof Error) {
    process.stderr.write(`error: ${ceiling.message}\n`);
    return 1;
  }
  if (ceiling !== null) {
    const verdict = ceilingVerdict(root, countIndexableFiles(root, ceiling), ceiling);
    if (verdict !== null) {
      process.stderr.write(verdict);
      return 1;
    }
  }

  if (reason === "cwd-fallback") {
    process.stderr.write(
      "warning: no .git/ directory found above the current directory; using cwd as project root.\n",
    );
  }

  // BL-15: when the root was matched via a `.git` strictly ABOVE the cwd
  // (e.g. a monorepo umbrella at `~/work` while the user is in `~/work/foo`),
  // confirm before creating `.hayven` at the umbrella instead of here. The
  // resolution itself is unchanged (nearest `.git` wins, matching `git`); this
  // only catches the case where the user almost certainly meant the subdir.
  // Skippable for non-interactive/automation use: `--yes`/`-y`, or any time
  // stdin is not a TTY (so tests and pipelines never hang).
  const confirm = rootConfirmDecision({ root, reason }, cwd);
  if (confirm.needsConfirm) {
    const skip =
      args.flags["yes"] === true ||
      args.flags["yes"] === "true" ||
      args.flags["y"] === true ||
      !process.stdin.isTTY;
    if (skip) {
      process.stdout.write(confirm.message + (process.stdin.isTTY ? "y\n" : "(assuming yes; non-interactive)\n"));
    } else {
      process.stdout.write(confirm.message);
      const answer = (await readLine()).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        process.stderr.write(
          "Aborted. Re-run from the directory you want as the project root, or pass `--yes` to accept.\n",
        );
        return 1;
      }
    }
  }

  // 2. Directory tree.
  for (const dir of [
    paths.hayvenDir,
    paths.nodesDir,
    paths.tracesDir,
    paths.claimsDir,
    paths.crdtDir,
    paths.peersDir,
    paths.crashesDir,
    paths.logsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // 3. Default config.json.
  writeConfig(paths.configFile, DEFAULT_CONFIG);

  // 4. SQLite schema.
  //
  // `migrate()` refuses an index written by a NEWER hayven (`SchemaTooNewError`
  // from db/migrations.ts) rather than migrating it DOWN and discarding the
  // newer schema's tables. That refusal is deliberate — surface it as a clean
  // error, not a stack trace. Same shape as the `--max-files` ceiling above:
  // stop before doing damage, and say exactly what to do about it.
  const db = new Db(paths.sqliteFile);
  let migration;
  try {
    migration = db.migrate();
  } catch (err) {
    db.close(); // release the handle before bailing — no double close below
    process.stderr.write(
      `error: ${(err as Error).message}\n` +
        // We already created the tree above, so a bare retry would hit
        // "`.hayven/` already exists" and look like a different problem.
        `Remove the partially created ${paths.hayvenDir} before retrying.\n`,
    );
    return 1;
  }
  db.close();

  // 5. Skill copy (graceful). Resolve the skill SOURCE from beside the binary
  // (release tarball) or the source checkout — NOT from the user's project root,
  // which has no `skill/` dir. See resolveSkillSource() in util/paths.ts.
  const skillSrc = paths.skillSrc;
  // The skill is the open cross-vendor `SKILL.md` standard (agentskills.io —
  // required frontmatter `name`+`description`), so ONE file reaches every major
  // agent if we drop it in each tool's discovery dir. Each skill is a DIRECTORY —
  // `<base>/<name>/SKILL.md`; a flat `<base>/<name>.md` is NOT discovered (it
  // falls back to legacy-command behavior) so it never auto-triggers. Install the
  // byte-identical file into both:
  //   - `.claude/skills/`  → Claude Code (paths.skillDir).
  //   - `.agents/skills/`  → the cross-vendor convention: OpenAI Codex reads it
  //                          natively, and Gemini CLI aliases it (also `.gemini/`).
  const skillBaseDirs = [paths.skillDir, join(root, ".agents", "skills")];
  const skillInstalled: string[] = [];
  if (existsSync(skillSrc)) {
    for (const base of skillBaseDirs) {
      const dest = join(base, "hayvenhurst");
      mkdirSync(dest, { recursive: true });
      copyFileSync(skillSrc, join(dest, "SKILL.md"));
      skillInstalled.push(relative(root, join(dest, "SKILL.md")));
    }
  }
  const skillCopied = skillInstalled.length > 0;

  // 5b. Keep `hayven`'s generated artifacts out of the user's commits. The
  // index/traces/claims live under `.hayven/`, and we install the skill into
  // `.claude/skills/` — neither should be committed just because someone ran
  // `hayven init`. Idempotently add them to the project `.gitignore` (only when
  // this is a git repo or a `.gitignore` already exists, so we don't create a
  // spurious one in a non-git tree).
  const gitignoreAdded = ensureGitignoreEntries(root, [
    ".hayven/",
    ".claude/skills/",
    ".agents/skills/",
  ]);

  // 5c. Ambient "agent reflex" — many agents don't load Claude Code skills, so
  // an instruction file (CLAUDE.md / AGENTS.md) is the fallback that nudges any
  // agent to reach for `hayven` over grep. Append idempotently to whichever
  // exist; if NEITHER exists, create AGENTS.md (the tool-agnostic convention).
  const reflexTargets: string[] = [];
  const claudeMd = join(root, "CLAUDE.md");
  const agentsMd = join(root, "AGENTS.md");
  const haveClaude = existsSync(claudeMd);
  const haveAgents = existsSync(agentsMd);
  if (haveClaude && ensureReflexBlock(claudeMd)) reflexTargets.push("CLAUDE.md");
  if (haveAgents && ensureReflexBlock(agentsMd)) reflexTargets.push("AGENTS.md");
  if (!haveClaude && !haveAgents && ensureReflexBlock(agentsMd)) reflexTargets.push("AGENTS.md");

  // 5d. Register this project in the multi-project registry
  // (`~/.hayven/projects.json`) so a single running daemon can serve it
  // alongside other repos — selectable in the viewer's project switcher and via
  // `?project=<alias>`. Idempotent by root; best-effort (a registry write
  // failure must never fail an otherwise-successful init).
  let registeredAlias: string | null = null;
  try {
    registeredAlias = registerProject(root).alias;
  } catch {
    /* non-fatal — the registry is a convenience, not required to use the project */
  }

  process.stdout.write(`Initialized Hayvenhurst project at ${paths.hayvenDir}\n`);
  process.stdout.write(`  schema_version: ${migration.toVersion}  (fts: ${migration.appliedFts ? "yes" : "no"})\n`);
  process.stdout.write(`  config:         ${paths.configFile}\n`);
  process.stdout.write(`  skill:          ${skillCopied ? "installed at " + skillInstalled.join(", ") : "(not yet present — re-run init or copy manually after the skill is written)"}\n`);
  if (gitignoreAdded.length > 0) {
    process.stdout.write(`  .gitignore:     added ${gitignoreAdded.join(", ")}\n`);
  }
  if (reflexTargets.length > 0) {
    process.stdout.write(`  reflex:         appended to ${reflexTargets.join(", ")}\n`);
  }
  if (registeredAlias) {
    process.stdout.write(`  project:        registered as "${registeredAlias}" for multi-repo serving\n`);
  }

  // 6. First ingest. Best-effort: if native binary is missing, surface the
  // error but do not fail the init — the user can run `hayven ingest` later.
  process.stdout.write("\nRunning first ingest...\n");
  // Thread the SAME cwd init resolved into the ingest, so `init --cwd <dir>`
  // ingests <dir>'s project rather than re-deriving the root from process.cwd().
  const ingestCode = await runIngest({ positionals: [], flags: { full: true, cwd } });
  if (ingestCode !== 0) {
    process.stderr.write(
      "\nFirst ingest did not complete cleanly. This is OK — fix the issue above\n" +
        "and re-run `hayven ingest` when ready.\n",
    );
    return 0;
  }

  // If a daemon is already running, hot-add this freshly-initialized repo so it
  // appears in the switcher/routing WITHOUT a restart (the canonical "installed
  // Hayven in a 2nd repo, see it live" flow). Best-effort — never fails init.
  if (registeredAlias) {
    try {
      const cfg = loadConfig(root).config;
      const hot = await hotAddToRunningDaemon(root, `http://${cfg.daemon_host}:${cfg.daemon_port}`);
      if (hot.kind === "added") {
        process.stdout.write("  daemon:         added live to the running daemon (no restart needed)\n");
      }
    } catch {
      /* best-effort — a hot-add failure must never fail an otherwise-good init */
    }
  }

  process.stdout.write(
    "\nNext steps:\n" +
      "  hayven daemon start              # serve the viewer + API on localhost:7777\n" +
      "  hayven query <terms>             # search the indexed graph\n" +
      "  hayven view                      # open the Astro viewer in your browser\n",
  );
  return 0;
}

/**
 * Idempotently ensure `entries` are present in `<root>/.gitignore`. Appends a
 * single marked block for any that are missing (line-exact match against the
 * existing file). Returns the entries actually added (empty if all present or
 * if there's no reason to manage a `.gitignore` here). Never throws — a failure
 * to write `.gitignore` must not fail `init`.
 */
export function ensureGitignoreEntries(root: string, entries: string[]): string[] {
  const gitignorePath = join(root, ".gitignore");
  const exists = existsSync(gitignorePath);
  // Only manage a `.gitignore` for an actual git repo, or one that already has a
  // `.gitignore` — don't create a spurious file in a non-git tree.
  if (!exists && !existsSync(join(root, ".git"))) return [];

  try {
    const current = exists ? readFileSync(gitignorePath, "utf8") : "";
    const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const missing = entries.filter((e) => !present.has(e.trim()));
    if (missing.length === 0) return [];

    const block =
      (current.length > 0 && !current.endsWith("\n") ? "\n" : "") +
      "\n# Hayvenhurst (added by `hayven init`) — generated index + installed skill\n" +
      missing.join("\n") +
      "\n";
    if (exists) appendFileSync(gitignorePath, block);
    else writeFileSync(gitignorePath, block.replace(/^\n/, ""));
    return missing;
  } catch {
    return [];
  }
}

/** Sentinel marker that opens the reflex block; presence means "already added". */
const REFLEX_SENTINEL = "<!-- hayvenhurst:reflex -->";

/** The ambient agent-reflex block appended to CLAUDE.md / AGENTS.md. */
const REFLEX_BLOCK =
  `${REFLEX_SENTINEL}\n` +
  "## Code navigation: prefer `hayven` over grep\n" +
  "\n" +
  "This repo is indexed by Hayvenhurst. To find code, reach for `hayven` FIRST:\n" +
  "- `hayven query \"<natural language or identifier>\"` — semantic/identifier search over the code graph (faster and higher-signal than grep; never returns empty on a real query).\n" +
  "- `hayven neighbors <id>` — callers/callees of a node (follow the call graph instead of guessing).\n" +
  "- `hayven view` — open the browser graph.\n" +
  "Fall back to grep only when hayven has no answer. Run `hayven reindex` after large changes if results look stale.\n" +
  "<!-- /hayvenhurst:reflex -->\n";

/**
 * Idempotently append the ambient hayven "agent reflex" block to `filePath`
 * (a CLAUDE.md / AGENTS.md). If the file already contains the sentinel marker,
 * does nothing. If the file does not exist, it is created with the block.
 *
 * Returns true if the block was written (created or appended), false otherwise
 * (already present, or a write failure). Never throws — a write failure must
 * not fail `init`, exactly like `ensureGitignoreEntries`.
 */
export function ensureReflexBlock(filePath: string): boolean {
  try {
    const exists = existsSync(filePath);
    const current = exists ? readFileSync(filePath, "utf8") : "";
    if (current.includes(REFLEX_SENTINEL)) return false;

    if (!exists) {
      writeFileSync(filePath, REFLEX_BLOCK);
      return true;
    }
    // Append with a separating blank line so we don't glue onto prior content.
    const sep = current.length === 0 ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    appendFileSync(filePath, sep + REFLEX_BLOCK);
    return true;
  } catch {
    return false;
  }
}

/** Read a single line from stdin (for the BL-15 interactive root confirm). */
function readLine(): Promise<string> {
  return new Promise((resolvePromise) => {
    const onData = (chunk: Buffer | string) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolvePromise(chunk.toString());
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}
