/**
 * Supervises `hayven-native` as a child process and exposes its NDJSON stream
 * as an async iterator of typed {@link NativeRecord}s.
 *
 * Responsibilities:
 *  - Spawn with the correct CLI arguments.
 *  - Buffer stdout line-by-line.
 *  - Capture stderr to logs (and surface last N lines on non-zero exit).
 *  - Enforce a timeout.
 *  - Clean termination on SIGINT.
 */
import type { Logger } from "../util/log.ts";
import {
  assertVersionCompatible,
  NdjsonLineReader,
  type NativeRecord,
  parseLine,
} from "./protocol.ts";

/** A writable child stdin (Bun's FileSink). Subset we use for `--files-stdin`. */
interface StdinSinkLike {
  write(data: string | Uint8Array): void;
  end(): void | Promise<unknown>;
}

/** Subset of the Bun.spawn shape we care about (avoids a hard `bun` import). */
interface SpawnLike {
  /** Present only when spawned with `stdin: "pipe"` (incremental re-ingest). */
  stdin?: StdinSinkLike;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | string): void;
}

type SpawnFn = (opts: {
  cmd: string[];
  stdin?: "ignore" | "pipe" | "inherit";
  stdout?: "ignore" | "pipe" | "inherit";
  stderr?: "ignore" | "pipe" | "inherit";
}) => SpawnLike;

export interface ParseOptions {
  /** Absolute path to the `hayven-native` binary. */
  binary: string;
  /** Repo root (passed as `--root`). */
  root: string;
  /** Languages to parse. */
  languages: string[];
  /** Worker parallelism (0 = let native pick). */
  jobs: number;
  /** Logger for stderr line capture and warnings. */
  logger?: Logger;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Optional injected spawn function (for tests). */
  spawn?: SpawnFn;
  /** Incremental ingest: when present, native bypasses the gitignore
   *  walker and parses only these repo-relative paths. ARCHITECTURE.md §16.3. */
  files?: string[];
}

export interface ParseRun {
  /** Async iterator of all records the native binary emitted. */
  records: AsyncIterable<NativeRecord>;
  /** Wait for the child process to exit and resolve with its exit code. */
  wait(): Promise<number>;
  /** Send SIGTERM, then SIGKILL after a short delay. */
  kill(): Promise<void>;
  /** Last N captured stderr lines. */
  recentStderr(): string[];
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const STDERR_RING_SIZE = 200;

/** Start a `parse` invocation. */
export function startParse(opts: ParseOptions): ParseRun {
  const args = [
    "parse",
    "--root",
    opts.root,
    "--langs",
    opts.languages.join(","),
  ];
  if (opts.jobs > 0) {
    args.push("--jobs", String(opts.jobs));
  }
  // BL-2: the incremental file list is passed NEWLINE-delimited on the
  // child's stdin (`--files-stdin`), NOT as a comma-delimited `--files <csv>`
  // CLI arg. A real repo path can contain a comma; the old csv transport split
  // it into bogus tokens and the file was never re-ingested. Paths may contain
  // any byte except '\n'. (Contract mirrored verbatim in the native agent's
  // `hayven-native parse --files-stdin` reader.)
  const incremental = opts.files !== undefined && opts.files.length > 0;
  if (incremental) {
    args.push("--files-stdin");
  }

  const spawnFn: SpawnFn = opts.spawn ?? (Bun.spawn as unknown as SpawnFn);
  const child = spawnFn({
    cmd: [opts.binary, ...args],
    // Pipe stdin only when we have a file list to stream; otherwise the child
    // never reads stdin and we leave it ignored as before.
    stdin: incremental ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (incremental) {
    // Write the newline-delimited list, then close so the child sees EOF and
    // stops reading. A path can legitimately contain a comma but never a '\n'.
    const sink = child.stdin;
    if (sink) {
      try {
        sink.write(opts.files!.join("\n"));
        void sink.end();
      } catch (err) {
        opts.logger?.warn("failed to write incremental file list to native stdin", {
          error: (err as Error).message,
        });
      }
    } else {
      opts.logger?.warn("native child has no stdin sink; incremental file list dropped");
    }
  }

  const stderrRing: string[] = [];
  const stderrReader = new NdjsonLineReader();
  const stdoutReader = new NdjsonLineReader();

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    opts.logger?.warn("native parse timed out — killing child", { timeoutMs });
    void killChild(child);
  }, timeoutMs);

  // Drain stderr in the background.
  void (async () => {
    try {
      const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          stderrReader.push(value);
          for (const line of stderrReader.drain()) {
            stderrRing.push(line);
            if (stderrRing.length > STDERR_RING_SIZE) stderrRing.shift();
            opts.logger?.debug("native.stderr", { line });
          }
        }
      }
      stderrReader.flush();
      for (const line of stderrReader.drain()) {
        stderrRing.push(line);
        if (stderrRing.length > STDERR_RING_SIZE) stderrRing.shift();
      }
    } catch (err) {
      opts.logger?.warn("error reading native stderr", { error: (err as Error).message });
    }
  })();

  // Forward SIGINT to the child.
  const onSigint = (): void => {
    opts.logger?.info("SIGINT received — terminating native child");
    void killChild(child);
  };
  process.once("SIGINT", onSigint);

  let handshakeDone = false;
  const checkHandshake = (rec: NativeRecord): void => {
    if (handshakeDone) return;
    if (rec.type === "version") {
      assertVersionCompatible(rec, opts.logger);
      handshakeDone = true;
    } else {
      // §16.4 says `version` MUST be first. The 0.0.1 binary emits `start`
      // first instead; tolerate it so dev mode with an old binary still
      // works during the rollout, but log a warning. Subsequent records
      // are not gated.
      opts.logger?.warn("native subprocess emitted no version handshake; ignoring §16.4 check", {
        firstRecord: rec.type,
      });
      handshakeDone = true;
    }
  };

  // Parse one line, run the handshake gate, and return the record (or null
  // if the line was unparseable). A VersionSkewError from the handshake is
  // deliberately NOT caught here — it must propagate out of the generator
  // and abort the run (§16.4). Only NDJSON parse failures are swallowed.
  function parseAndGate(line: string): NativeRecord | null {
    let rec: NativeRecord;
    try {
      rec = parseLine(line);
    } catch (err) {
      opts.logger?.warn("invalid NDJSON record from native", {
        error: (err as Error).message,
        line,
      });
      return null;
    }
    checkHandshake(rec); // throws VersionSkewError on major mismatch
    return rec;
  }

  async function* recordIter(): AsyncIterable<NativeRecord> {
    try {
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          stdoutReader.push(value);
          for (const line of stdoutReader.drain()) {
            const rec = parseAndGate(line);
            if (rec !== null) yield rec;
          }
        }
      }
      stdoutReader.flush();
      for (const line of stdoutReader.drain()) {
        const rec = parseAndGate(line);
        if (rec !== null) yield rec;
      }
    } finally {
      clearTimeout(timer);
      process.off("SIGINT", onSigint);
    }
  }

  return {
    records: recordIter(),
    wait: async () => {
      const code = await child.exited;
      clearTimeout(timer);
      process.off("SIGINT", onSigint);
      return code;
    },
    kill: () => killChild(child),
    recentStderr: () => [...stderrRing],
  };
}

async function killChild(child: { kill(signal?: number | string): void; exited: Promise<number> }): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  // Give it ~2s to die gracefully, then SIGKILL.
  const sigkillTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, 2000);
  try {
    await child.exited;
  } finally {
    clearTimeout(sigkillTimer);
  }
}

/** Build a human-readable error from a failed native run. */
export function describeFailure(exitCode: number, recentStderr: string[]): string {
  const tail = recentStderr.slice(-20).join("\n");
  return `hayven-native exited with code ${exitCode}.\nLast stderr lines:\n${tail || "(no stderr)"}`;
}
