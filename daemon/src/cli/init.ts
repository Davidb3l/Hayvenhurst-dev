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
import { registerProject } from "../daemon/registry.ts";
import { hotAddToRunningDaemon } from "./_shared.ts";
import { Db } from "../db/queries.ts";
import { detectRepoRoot, hayvenPathsFor, rootConfirmDecision } from "../util/paths.ts";
import type { ParsedArgs } from "../cli.ts";
import { runIngest } from "./ingest.ts";

export async function runInit(args: ParsedArgs): Promise<number> {
  const cwd = (typeof args.flags["cwd"] === "string" ? args.flags["cwd"] : undefined) ?? process.cwd();
  const { root, reason } = detectRepoRoot(cwd);
  const paths = hayvenPathsFor(root);

  if (existsSync(paths.hayvenDir)) {
    process.stderr.write(
      `error: .hayven/ already exists at ${paths.hayvenDir}\n` +
        "Use `hayven reindex` to rebuild the index, or `rm -rf .hayven/` to start fresh.\n",
    );
    return 1;
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
  const db = new Db(paths.sqliteFile);
  const migration = db.migrate();
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
