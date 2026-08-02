/**
 * Structured logger for the daemon.
 *
 * Writes JSON lines to `~/.hayven/logs/daemon.log` and, when stdout is a TTY,
 * also pretty-prints colored output. No external deps — uses ANSI escapes
 * manually to keep the dependency footprint tight.
 *
 * TWO bounds keep a long-lived daemon's log from eating the disk (the runaway
 * ingest incident left a 576 MB unrotated `daemon.log`):
 *   - SIZE: {@link rotateLogFile} rotates at {@link LOG_MAX_BYTES} and keeps
 *     {@link LOG_KEEP_FILES} generations, so the on-disk total is bounded.
 *   - REPETITION: identical records (same level+scope+msg+fields) collapse to
 *     {@link LOG_DEDUP_THRESHOLD} per {@link LOG_DEDUP_WINDOW_MS}; the rest are
 *     counted and reported on the next emitted record. The bulk of that 576 MB
 *     was the SAME handful of `native parse warning` lines for vendored files
 *     that will never parse cleanly, so this is worth more than rotation alone.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { globalLogsDir } from "./paths.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Rotate a log once it exceeds this many bytes. */
export const LOG_MAX_BYTES = 32 * 1024 * 1024;
/** Rotated generations kept (`daemon.log.1` … `.N`); older ones are deleted. */
export const LOG_KEEP_FILES = 3;
/** Identical records inside this window collapse. */
export const LOG_DEDUP_WINDOW_MS = 60_000;
/** Identical records emitted per window before the rest are suppressed. */
export const LOG_DEDUP_THRESHOLD = 5;
/**
 * `statSync` on every single line would double the syscall cost of logging, so
 * the size check runs every Nth write. Worst-case overshoot is N lines past the
 * cap, which is bounded and irrelevant next to a 32 MB threshold.
 */
const ROTATE_CHECK_EVERY = 256;
/**
 * Cap on distinct dedup keys tracked at once. A pathological producer (a unique
 * message per line) must not turn the suppressor itself into the leak.
 *
 * Sized well above a realistic distinct-file count: at 4096 a repo with ~5,000
 * unparseable vendored files THRASHED — the ledger filled, got cleared, and
 * every line was written again, so suppression achieved exactly nothing on the
 * one workload it exists for.
 */
const DEDUP_MAX_KEYS = 32_768;

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: ANSI.dim,
  info: ANSI.cyan,
  warn: ANSI.yellow,
  error: ANSI.red,
};

export interface LoggerOptions {
  level?: LogLevel;
  /** When true, also write JSON lines to the daemon log file. */
  toFile?: boolean;
  /** When true, write a one-line pretty record to stderr. */
  toStderr?: boolean;
  /** Optional override of the log file path. */
  filePath?: string;
  /**
   * Collapse identical repeated records (default true). Set false only where a
   * caller genuinely needs every line — a test asserting on repeated output.
   */
  dedup?: boolean;
  /** Suppression window. Defaults to {@link LOG_DEDUP_WINDOW_MS}. */
  dedupWindowMs?: number;
  /** Rotate the log file past this size. Defaults to {@link LOG_MAX_BYTES}. */
  maxBytes?: number;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

interface InternalState {
  level: LogLevel;
  toFile: boolean;
  toStderr: boolean;
  filePath: string;
  scope: string;
  dedup: boolean;
  dedupWindowMs: number;
  maxBytes: number;
  fileInitialized: boolean;
}

/**
 * Per-FILE state, held at module scope on purpose: `child()` copies
 * {@link InternalState}, so a rotation counter living there would reset on every
 * child logger and never fire. Keyed by absolute log path.
 */
const fileCounters = new Map<string, { writesSinceCheck: number }>();

interface DedupEntry {
  windowStart: number;
  emitted: number;
  suppressed: number;
}

/** Process-wide dedup ledger, shared across every child logger. */
const dedupLedger = new Map<string, DedupEntry>();

function ensureLogDir(filePath: string, state: InternalState): void {
  if (state.fileInitialized) return;
  try {
    mkdirSync(globalLogsDir(), { recursive: true });
    state.fileInitialized = true;
  } catch {
    // Logging must never throw — fall back to stderr only.
    state.toFile = false;
  }
  void filePath;
}

/**
 * Rotate `filePath` when it exceeds `maxBytes`: `x.log.N-1` → `x.log.N`,
 * `x.log` → `x.log.1`, oldest dropped. Returns true if a rotation happened.
 *
 * Exported because the DETACHED daemon's `daemon.out.log` is opened once and its
 * fd handed to the child for that process's whole lifetime — it cannot be
 * rotated underneath the child, so the launcher rotates it at spawn time
 * instead. Never throws: a failure to rotate must not stop a daemon starting.
 */
export function rotateLogFile(
  filePath: string,
  maxBytes: number = LOG_MAX_BYTES,
  keep: number = LOG_KEEP_FILES,
): boolean {
  try {
    if (!existsSync(filePath)) return false;
    if (statSync(filePath).size < maxBytes) return false;
    // Drop the generation that is about to fall off the end, then shift the
    // rest up. Descending order so nothing is overwritten before it moves.
    rmSync(`${filePath}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      if (existsSync(from)) renameSync(from, `${filePath}.${i + 1}`);
    }
    renameSync(filePath, `${filePath}.1`);
    return true;
  } catch {
    // Rotation is hygiene, never a reason to fail a write or a start.
    return false;
  }
}

function maybeRotate(filePath: string, maxBytes: number): void {
  let counter = fileCounters.get(filePath);
  if (!counter) {
    counter = { writesSinceCheck: ROTATE_CHECK_EVERY }; // force a check on the first write
    fileCounters.set(filePath, counter);
  }
  if (++counter.writesSinceCheck < ROTATE_CHECK_EVERY) return;
  counter.writesSinceCheck = 0;
  rotateLogFile(filePath, maxBytes);
}

/**
 * Decide whether this record may be written. Returns `null` to SUPPRESS, or the
 * number of previously-suppressed repeats to attach to the record being emitted
 * (0 when there were none).
 */
function dedupeGate(key: string, now: number, windowMs: number): number | null {
  const entry = dedupLedger.get(key);
  if (entry === undefined || now - entry.windowStart >= windowMs) {
    const carried = entry?.suppressed ?? 0;
    if (dedupLedger.size >= DEDUP_MAX_KEYS) {
      // Evict expired keys first.
      for (const [k, v] of dedupLedger) {
        if (now - v.windowStart >= windowMs) dedupLedger.delete(k);
      }
      // Still full: drop the OLDEST half rather than `clear()`. Clearing
      // everything made the ledger thrash — each pass reset every counter, so a
      // producer just above the cap was never suppressed at all. Halving keeps
      // the most recent keys (the ones actively repeating) and costs one pass.
      if (dedupLedger.size >= DEDUP_MAX_KEYS) {
        const byAge = [...dedupLedger.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
        for (let i = 0; i < Math.floor(byAge.length / 2); i++) dedupLedger.delete(byAge[i]![0]);
      }
    }
    dedupLedger.set(key, { windowStart: now, emitted: 1, suppressed: 0 });
    return carried;
  }
  if (entry.emitted < LOG_DEDUP_THRESHOLD) {
    entry.emitted += 1;
    return 0;
  }
  entry.suppressed += 1;
  return null;
}


/**
 * The field subset that participates in the dedup key.
 *
 * Hashing the WHOLE field object defeated suppression completely: every line the
 * runaway-ingest loop emits carries a counter or a duration — `{dropped,
 * sinceMs}`, `{touched, cap}`, `{changed, deleted}` — so no two lines were ever
 * byte-identical and 10,000 of 10,000 overflow warnings were written. Rotation
 * then caps the disk, which turns that into an EVIDENCE-DESTRUCTION bug: the
 * loop's own churn rotates the diagnostic history away within minutes.
 *
 * So the key uses only STRING-valued fields — the identity-ish ones (`file`,
 * `alias`, `branchKey`, `error`) — and ignores numbers, booleans and nested
 * objects, which is where counters and timings live. Consequence, and it is the
 * intended trade: two occurrences of the same message about the same file
 * collapse even when their counts differ. The counts are not lost — the first
 * {@link LOG_DEDUP_THRESHOLD} of each window are written in full, and the next
 * emission carries `suppressed_repeats`.
 */
function dedupFieldsKey(fields?: Record<string, unknown>): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const key of Object.keys(fields).sort()) {
    const v = fields[key];
    if (typeof v === "string") parts.push(`${key}=${v}`);
  }
  return parts.join("\u001f");
}

function emit(state: InternalState, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;

  let suppressedRepeats = 0;
  if (state.dedup) {
    const fieldsKey = dedupFieldsKey(fields);
    // `\u0000` cannot occur in a level, scope or message, so it is an
    // unambiguous key separator (a plain space would let two different
    // records collide into one key).
    const gate = dedupeGate(
      [level, state.scope, msg, fieldsKey].join("\u0000"),
      Date.now(),
      state.dedupWindowMs,
    );
    if (gate === null) return; // identical line, over budget for this window
    suppressedRepeats = gate;
  }

  const record = {
    ts: new Date().toISOString(),
    level,
    scope: state.scope,
    msg,
    ...(fields ?? {}),
    // Present ONLY when identical lines were dropped, so a reader can tell
    // "quiet because nothing happened" from "quiet because we stopped repeating".
    ...(suppressedRepeats > 0 ? { suppressed_repeats: suppressedRepeats } : {}),
  };

  if (state.toFile) {
    ensureLogDir(state.filePath, state);
    if (state.toFile) {
      try {
        maybeRotate(state.filePath, state.maxBytes);
        appendFileSync(state.filePath, JSON.stringify(record) + "\n");
      } catch {
        // Swallow — don't recursively log a logging failure.
      }
    }
  }

  if (state.toStderr) {
    const color = LEVEL_COLOR[level];
    const tag = `${color}[${level}]${ANSI.reset}`;
    const scopePart = state.scope ? ` ${ANSI.dim}${state.scope}${ANSI.reset}` : "";
    const extra =
      suppressedRepeats > 0 ? { ...(fields ?? {}), suppressed_repeats: suppressedRepeats } : fields;
    const fieldsPart =
      extra && Object.keys(extra).length > 0 ? ` ${ANSI.dim}${JSON.stringify(extra)}${ANSI.reset}` : "";
    process.stderr.write(`${tag}${scopePart} ${msg}${fieldsPart}\n`);
  }
}

function makeLogger(state: InternalState): Logger {
  return {
    debug: (msg, fields) => emit(state, "debug", msg, fields),
    info: (msg, fields) => emit(state, "info", msg, fields),
    warn: (msg, fields) => emit(state, "warn", msg, fields),
    error: (msg, fields) => emit(state, "error", msg, fields),
    child: (scope: string) =>
      makeLogger({
        ...state,
        scope: state.scope ? `${state.scope}.${scope}` : scope,
      }),
  };
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = (process.env["HAYVEN_LOG_LEVEL"] as LogLevel | undefined) ?? opts.level ?? "info";
  const state: InternalState = {
    level,
    toFile: opts.toFile ?? true,
    toStderr: opts.toStderr ?? process.stderr.isTTY === true,
    filePath: opts.filePath ?? join(globalLogsDir(), "daemon.log"),
    scope: "",
    // Escape hatch for anyone debugging a suppressed line.
    dedup: (opts.dedup ?? true) && process.env["HAYVEN_LOG_NO_DEDUP"] !== "1",
    dedupWindowMs: opts.dedupWindowMs ?? LOG_DEDUP_WINDOW_MS,
    maxBytes: opts.maxBytes ?? LOG_MAX_BYTES,
    fileInitialized: false,
  };
  return makeLogger(state);
}

/** Test seam: forget every dedup window so one test's log lines cannot suppress
 *  another's. Not used by the daemon. */
export function resetLogDedupState(): void {
  dedupLedger.clear();
  fileCounters.clear();
}

/** Lazy module-level logger, instantiated on first use. */
let _root: Logger | undefined;
export function rootLogger(): Logger {
  if (!_root) _root = createLogger();
  return _root;
}
