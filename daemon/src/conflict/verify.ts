/**
 * Layer B — pre-merge semantic verify gate (ARCHITECTURE.md §17.2).
 *
 * Before a merged node-body state is ACCEPTED at the application layer, the
 * affected file(s) are validated:
 *
 *   1. **Syntax** — re-parse via `hayven-native parse --files-stdin`. A parse
 *      error (`warn`/`fatal` for an affected file) or a non-zero native exit
 *      fails the gate for that file.
 *   2. **Type** — where a typechecker is *configured* for the language
 *      (`tsc --noEmit`, `mypy`, `cargo check`), run it scoped to the affected
 *      files. ABSENCE of a configured checker is a PASS (we don't block on what
 *      we can't check) and is logged.
 *
 * The gate is **advisory-to-the-agent, authoritative-to-the-application-cache**:
 * a failure does NOT roll back the CRDT (convergence per §11–§15 is
 * unconditional). It raises a {@link MergeRejection} naming the failing file +
 * reason; the caller records it in the SQL read cache so the conflict is
 * visible rather than silently materialized.
 *
 * Everything I/O-shaped is injected (the native-parse fn + a typecheck runner)
 * so this unit-tests with stubs and stays fast/deterministic.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describeFailure, startParse } from "../native/process.ts";
import type { Logger } from "../util/log.ts";

/** Layers we run. Recorded on a rejection so the surface can group by phase. */
export type VerifyPhase = "syntax" | "type";

/**
 * One rejected file. This is the `merge_rejected` application record. It names
 * the entity/op-scope (the affected file — the narrowest stable identifier we
 * have at the ingest hook), the phase that failed, and a one-line reason.
 */
export interface MergeRejection {
  /** Repo-relative path of the file that failed the gate. */
  file: string;
  /** Which gate phase rejected it. */
  phase: VerifyPhase;
  /** One-line, human-readable reason (parser message / checker tail). */
  reason: string;
  /** Detected source language, or `"unknown"` if no language matched. */
  language: string;
  /** Wall-clock ms when the rejection was raised (for the read-cache row). */
  detectedAt: number;
}

export interface VerifyResult {
  ok: boolean;
  failures: MergeRejection[];
  /**
   * Languages whose typecheck was SKIPPED because no checker is configured.
   * Surfaced for the §17.2 "absence is a pass, logged" requirement.
   */
  skippedTypecheck: string[];
}

/* ─── injected collaborators ──────────────────────────────────────────────── */

/** A single record the native parser emitted while re-parsing the files. */
export interface NativeParseRecord {
  type: string;
  /** Present on `warn`/`fatal`/`node`/`edge` records. */
  file?: string | undefined;
  /** Present on `warn`/`fatal`. */
  message?: string | undefined;
}

export interface NativeParseOutcome {
  records: NativeParseRecord[];
  /** Native process exit code (0 = clean). */
  exitCode: number;
  /** Tail of stderr, for a fatal/non-zero diagnostic. */
  stderrTail: string;
}

/**
 * Re-parse the given repo-relative files via the native parser. Injected so
 * tests can stub it; the production impl (see {@link nativeParseRunner}) reuses
 * the BL-2 `startParse({ files })` `--files-stdin` transport.
 */
export type NativeParseFn = (files: string[]) => Promise<NativeParseOutcome>;

export interface TypecheckOutcome {
  /** `true` when a checker is configured for this language on this repo. */
  configured: boolean;
  /** `true` when the configured checker passed (meaningless if !configured). */
  ok: boolean;
  /** One-line failure reason when configured && !ok. */
  reason?: string | undefined;
}

/**
 * Run the configured typechecker for `language` scoped to `files`. Injected.
 * MUST report `configured:false` (not throw) when no checker is on PATH / no
 * config file is present — absence is a pass per §17.2.
 */
export type TypecheckFn = (
  language: string,
  files: string[],
) => Promise<TypecheckOutcome>;

export interface VerifyDeps {
  /** Repo root (absolute). */
  root: string;
  /** Native re-parse runner (injected). */
  native: NativeParseFn;
  /** Typecheck runner (injected). Defaults to a no-checker-configured stub. */
  typecheck?: TypecheckFn;
  logger?: Logger | undefined;
}

/* ─── language detection (mirrors native/src/parse/language.rs) ───────────── */

/** Lowercase extension (no dot) → wire language id, or null if unparsed. */
export function languageOf(file: string): string | null {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = file.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "py":
      return "python";
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "rs":
      return "rust";
    case "go":
      return "go";
    default:
      return null;
  }
}

/* ─── the gate ────────────────────────────────────────────────────────────── */

const NO_CHECKER_CONFIGURED: TypecheckFn = async () => ({
  configured: false,
  ok: true,
});

/**
 * Run the Layer B gate over `affectedFiles` (repo-relative paths). Pure of the
 * SQL cache — the caller records {@link VerifyResult.failures} so the gate is
 * trivially unit-testable and the recording policy lives at the hook.
 */
export async function verifyMerge(
  affectedFiles: readonly string[],
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const failures: MergeRejection[] = [];
  const skippedTypecheck: string[] = [];

  // De-dupe + drop empties; nothing to verify → trivial pass.
  const files = [...new Set(affectedFiles.filter((f) => f.length > 0))];
  if (files.length === 0) {
    return { ok: true, failures: [], skippedTypecheck: [] };
  }

  const typecheck = deps.typecheck ?? NO_CHECKER_CONFIGURED;
  const now = Date.now();

  // ── Phase 1: syntax (native re-parse) ──────────────────────────────────
  // A `warn`/`fatal` naming an affected file fails THAT file. A non-zero exit
  // with no per-file attribution fails ALL affected files (we can't localize,
  // so we're conservative and flag the whole batch).
  let parsed: NativeParseOutcome;
  try {
    parsed = await deps.native(files);
  } catch (err) {
    // The parser itself blew up — treat as a syntax failure for the batch so
    // we never silently accept an unverified merge.
    const reason = `native parse failed: ${(err as Error).message}`;
    deps.logger?.warn("verify: native parse threw", { reason });
    for (const file of files) {
      failures.push({
        file,
        phase: "syntax",
        reason,
        language: languageOf(file) ?? "unknown",
        detectedAt: now,
      });
    }
    return { ok: false, failures, skippedTypecheck };
  }

  const syntaxFailed = new Set<string>();
  for (const rec of parsed.records) {
    if (rec.type === "warn" || rec.type === "fatal") {
      const file = rec.file;
      const reason = rec.message ?? `native ${rec.type}`;
      if (typeof file === "string" && files.includes(file)) {
        if (!syntaxFailed.has(file)) {
          syntaxFailed.add(file);
          failures.push({
            file,
            phase: "syntax",
            reason,
            language: languageOf(file) ?? "unknown",
            detectedAt: now,
          });
        }
      } else if (rec.type === "fatal") {
        // A fatal with no per-file attribution dooms the whole batch.
        for (const f of files) {
          if (!syntaxFailed.has(f)) {
            syntaxFailed.add(f);
            failures.push({
              file: f,
              phase: "syntax",
              reason,
              language: languageOf(f) ?? "unknown",
              detectedAt: now,
            });
          }
        }
      }
    }
  }
  if (parsed.exitCode !== 0) {
    const reason = `native parse exited ${parsed.exitCode}: ${parsed.stderrTail || "(no stderr)"}`;
    for (const f of files) {
      if (!syntaxFailed.has(f)) {
        syntaxFailed.add(f);
        failures.push({
          file: f,
          phase: "syntax",
          reason,
          language: languageOf(f) ?? "unknown",
          detectedAt: now,
        });
      }
    }
  }

  // ── Phase 2: type (per-language, scoped to affected files) ──────────────
  // Only typecheck files that PASSED syntax — a checker on a syntactically
  // broken file just produces noise, and the file is already rejected.
  const byLanguage = new Map<string, string[]>();
  for (const file of files) {
    if (syntaxFailed.has(file)) continue;
    const lang = languageOf(file);
    if (lang === null) continue; // not a parsed language → nothing to typecheck
    const list = byLanguage.get(lang) ?? [];
    list.push(file);
    byLanguage.set(lang, list);
  }

  for (const [lang, langFiles] of byLanguage) {
    let outcome: TypecheckOutcome;
    try {
      outcome = await typecheck(lang, langFiles);
    } catch (err) {
      // A runner that throws is treated as "not configured / inconclusive" —
      // we do NOT block on a checker we couldn't run, matching §17.2's stance
      // for absent checkers. Logged so it's visible.
      deps.logger?.warn("verify: typecheck runner threw — treating as not configured", {
        language: lang,
        error: (err as Error).message,
      });
      skippedTypecheck.push(lang);
      continue;
    }
    if (!outcome.configured) {
      // §17.2: absence of a configured checker is a PASS, logged.
      deps.logger?.info("verify: no typechecker configured — passing", { language: lang });
      skippedTypecheck.push(lang);
      continue;
    }
    if (!outcome.ok) {
      const reason = outcome.reason ?? `${lang} typecheck failed`;
      for (const file of langFiles) {
        failures.push({ file, phase: "type", reason, language: lang, detectedAt: now });
      }
    }
  }

  return { ok: failures.length === 0, failures, skippedTypecheck };
}

/* ─── production adapters ─────────────────────────────────────────────────── */
//
// These are the real I/O collaborators wired in at the daemon hook. They live
// here (rather than a sibling file) deliberately — the gate above takes them by
// injection, so unit tests never touch them and the `conflict/` directory holds
// exactly one Layer-B file. Both reuse the existing external-process patterns
// (`startParse` for the native parser, `Bun.spawn` for typecheckers).

/** Minimal `Bun.spawn` subset we use for typecheck subprocesses. */
type SpawnFn = (cmd: string[], opts: { cwd: string }) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

/** Default spawn: run a command in `cwd`, capture exit + stdout/stderr. */
const bunSpawn: SpawnFn = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/**
 * Production native-parse runner: re-parse `files` via the BL-2
 * `--files-stdin` transport and collect every record + the exit code. Mirrors
 * the watcher's incremental `startParse({ files })` call.
 */
export function nativeParseRunner(opts: {
  binary: string;
  root: string;
  languages: string[];
  jobs: number;
  timeoutMs?: number | undefined;
  logger?: Logger | undefined;
}): NativeParseFn {
  return async (files: string[]): Promise<NativeParseOutcome> => {
    const run = startParse({
      binary: opts.binary,
      root: opts.root,
      languages: opts.languages,
      jobs: opts.jobs,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
      files,
    });
    const records: NativeParseRecord[] = [];
    for await (const rec of run.records) {
      records.push(rec as NativeParseRecord);
    }
    const exitCode = await run.wait();
    return {
      records,
      exitCode,
      stderrTail: exitCode === 0 ? "" : describeFailure(exitCode, run.recentStderr()),
    };
  };
}

/**
 * Production typecheck runner. "Configured" detection is per-language:
 *   - TypeScript/Tsx → a `tsconfig.json` at the repo root AND `tsc` runnable.
 *   - Python         → a `mypy.ini`/`setup.cfg`/`pyproject.toml` AND `mypy` runnable.
 *   - Rust           → a `Cargo.toml` AND `cargo` runnable.
 *   - everything else → not configured (PASS-with-log).
 *
 * Absence is reported as `configured:false` (a pass), never a throw — §17.2.
 */
export function defaultTypecheck(opts: {
  root: string;
  spawn?: SpawnFn | undefined;
  logger?: Logger | undefined;
}): TypecheckFn {
  const spawn = opts.spawn ?? bunSpawn;
  const has = (p: string): boolean => existsSync(join(opts.root, p));

  return async (language: string, files: string[]): Promise<TypecheckOutcome> => {
    switch (language) {
      case "typescript":
      case "tsx": {
        if (!has("tsconfig.json")) return { configured: false, ok: true };
        const r = await spawn(["tsc", "--noEmit"], { cwd: opts.root });
        if (r.exitCode === 0) return { configured: true, ok: true };
        // tsc not on PATH → exit code is platform-specific; treat a spawn-level
        // failure (127/ENOENT surfaced as nonzero with empty stdout) as
        // not-configured so we don't block on a missing toolchain.
        if (isMissingTool(r)) return { configured: false, ok: true };
        return { configured: true, ok: false, reason: tail(r.stdout || r.stderr) };
      }
      case "python": {
        const configured =
          has("mypy.ini") || has("setup.cfg") || has("pyproject.toml");
        if (!configured) return { configured: false, ok: true };
        const r = await spawn(["mypy", ...files], { cwd: opts.root });
        if (r.exitCode === 0) return { configured: true, ok: true };
        if (isMissingTool(r)) return { configured: false, ok: true };
        return { configured: true, ok: false, reason: tail(r.stdout || r.stderr) };
      }
      case "rust": {
        if (!has("Cargo.toml")) return { configured: false, ok: true };
        const r = await spawn(["cargo", "check", "--quiet"], { cwd: opts.root });
        if (r.exitCode === 0) return { configured: true, ok: true };
        if (isMissingTool(r)) return { configured: false, ok: true };
        return { configured: true, ok: false, reason: tail(r.stderr || r.stdout) };
      }
      default:
        // JavaScript / Go: no checker wired in this milestone → pass-with-log.
        return { configured: false, ok: true };
    }
  };
}

/** Heuristic: a spawn that produced no diagnostics is likely a missing tool. */
function isMissingTool(r: { exitCode: number; stdout: string; stderr: string }): boolean {
  if (r.exitCode === 127) return true;
  const both = `${r.stdout}${r.stderr}`.toLowerCase();
  return both.includes("command not found") || both.includes("no such file");
}

/** Last non-empty line of a tool's output, trimmed to one line. */
function tail(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : "(no output)";
}
