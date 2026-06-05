/**
 * Structured logger for the daemon.
 *
 * Writes JSON lines to `~/.hayven/logs/daemon.log` and, when stdout is a TTY,
 * also pretty-prints colored output. No external deps — uses ANSI escapes
 * manually to keep the dependency footprint tight.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { globalLogsDir } from "./paths.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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
  fileInitialized: boolean;
}

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

function emit(state: InternalState, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    scope: state.scope,
    msg,
    ...(fields ?? {}),
  };

  if (state.toFile) {
    ensureLogDir(state.filePath, state);
    if (state.toFile) {
      try {
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
    const fieldsPart =
      fields && Object.keys(fields).length > 0 ? ` ${ANSI.dim}${JSON.stringify(fields)}${ANSI.reset}` : "";
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
    fileInitialized: false,
  };
  return makeLogger(state);
}

/** Lazy module-level logger, instantiated on first use. */
let _root: Logger | undefined;
export function rootLogger(): Logger {
  if (!_root) _root = createLogger();
  return _root;
}
