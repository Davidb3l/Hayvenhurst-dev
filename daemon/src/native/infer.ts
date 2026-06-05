/**
 * `hayven-native infer` spawn helper — Layer C local inference transport
 * (ARCHITECTURE.md §18.1 / §18.4).
 *
 * Spawns the candle-backed `hayven-native infer` subcommand, writes the prompt
 * to the child's stdin (closed to signal EOF), and reads the UTF-8 completion
 * from stdout. A wall-clock timeout kills the child rather than letting the
 * claim path hang on the model.
 *
 * SUBPROCESS CONTRACT (the native agent implements this; we call it):
 *   `hayven-native infer --model <MODEL_DIR> [--max-tokens N] [--temp 0.0]`
 *   - prompt on STDIN to EOF;
 *   - the completion text on STDOUT (UTF-8, nothing else);
 *   - exit 0 ok; non-zero + stderr on error;
 *   - temp 0.0 = deterministic.
 *
 * Everything I/O-shaped (the spawn fn) is INJECTED so this unit-tests without
 * the native binary or a model present — mirrors `conflict/verify.ts`.
 */
import type { Logger } from "../util/log.ts";

/** A writable child stdin (Bun's FileSink). Subset we use to stream the prompt. */
interface StdinSinkLike {
  write(data: string | Uint8Array): void;
  end(): void | Promise<unknown>;
}

/** Subset of the `Bun.spawn` shape we depend on (avoids a hard `bun` import). */
export interface InferChildLike {
  stdin?: StdinSinkLike;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | string): void;
}

/** Injected spawn function. Production passes a thin `Bun.spawn` adapter. */
export type InferSpawnFn = (opts: {
  cmd: string[];
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
}) => InferChildLike;

export interface InferOptions {
  /** Absolute path to the `hayven-native` binary. */
  binary: string;
  /**
   * Value passed to `--model`: the model DIRECTORY (not the .gguf file). The
   * registry resolves it from the configured model id via
   * `modelDir(hayvenDir, id)` → `.hayven/models/<dirname>/`; `hayven-native
   * infer` loads `model.gguf` (+ `tokenizer.json`) from inside it.
   */
  modelDir: string;
  /** `--max-tokens` (omitted when undefined; native picks a default). */
  maxTokens?: number | undefined;
  /** `--temp` (omitted when undefined; 0.0 = deterministic). */
  temp?: number | undefined;
  /** Wall-clock timeout in ms before the child is killed. Default 2000. */
  timeoutMs?: number | undefined;
  /** Optional external abort (e.g. shutdown). Killing the child on abort. */
  signal?: AbortSignal | undefined;
  /** Injected spawn fn (tests). Defaults to a `Bun.spawn` adapter. */
  spawn?: InferSpawnFn | undefined;
  logger?: Logger | undefined;
}

export interface InferResult {
  /** `true` only on a clean exit-0 run that produced a completion. */
  ok: boolean;
  /** The trimmed STDOUT completion (empty string on error/timeout). */
  completion: string;
  /** One-line diagnostic when `!ok` (timeout / non-zero exit / spawn throw). */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 2000;
const SIGKILL_GRACE_MS = 2000;

/** Production spawn adapter over `Bun.spawn`. */
const bunInferSpawn: InferSpawnFn = (opts) =>
  Bun.spawn(opts.cmd, {
    stdin: opts.stdin,
    stdout: opts.stdout,
    stderr: opts.stderr,
  }) as unknown as InferChildLike;

/** Read an entire `ReadableStream<Uint8Array>` to a UTF-8 string. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

/** SIGTERM, then SIGKILL after a grace window. Never throws. */
async function killChild(child: InferChildLike): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const grace = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, SIGKILL_GRACE_MS);
  try {
    await child.exited;
  } finally {
    clearTimeout(grace);
  }
}

/**
 * Run one `infer` invocation. Resolves (never rejects) with a structured
 * result — the caller (LlmOracle) maps any `ok:false` to its heuristic
 * fallback, so the claim path is never blocked or thrown into.
 */
export async function runInfer(
  prompt: string,
  opts: InferOptions,
): Promise<InferResult> {
  const args = [opts.binary, "infer", "--model", opts.modelDir];
  if (opts.maxTokens !== undefined) args.push("--max-tokens", String(opts.maxTokens));
  if (opts.temp !== undefined) args.push("--temp", String(opts.temp));

  const spawnFn = opts.spawn ?? bunInferSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let child: InferChildLike;
  try {
    child = spawnFn({ cmd: args, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    const error = `infer spawn failed: ${(err as Error).message}`;
    opts.logger?.warn(error);
    return { ok: false, completion: "", error };
  }

  // Write the prompt and close stdin so the child sees EOF.
  try {
    const sink = child.stdin;
    if (sink) {
      sink.write(prompt);
      void sink.end();
    } else {
      opts.logger?.warn("infer child has no stdin sink; prompt dropped");
    }
  } catch (err) {
    opts.logger?.warn("failed to write prompt to infer stdin", {
      error: (err as Error).message,
    });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    opts.logger?.warn("infer timed out — killing child", { timeoutMs });
    void killChild(child);
  }, timeoutMs);

  const onAbort = (): void => {
    opts.logger?.info("infer aborted — killing child");
    void killChild(child);
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
      child.exited,
    ]);

    if (timedOut) {
      return { ok: false, completion: "", error: `infer timed out after ${timeoutMs}ms` };
    }
    if (opts.signal?.aborted) {
      return { ok: false, completion: "", error: "infer aborted" };
    }
    if (exitCode !== 0) {
      const tail = lastLine(stderr) || "(no stderr)";
      return {
        ok: false,
        completion: "",
        error: `infer exited ${exitCode}: ${tail}`,
      };
    }
    return { ok: true, completion: stdout.trim() };
  } catch (err) {
    return { ok: false, completion: "", error: `infer read failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}

/** Last non-empty, trimmed line of a stream — for a one-line error tail. */
function lastLine(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : "";
}
