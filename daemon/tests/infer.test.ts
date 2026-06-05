// `hayven-native infer` spawn helper (ARCHITECTURE.md §18.1 / §18.4).
//
// Coverage, all with a STUB spawn (no native binary, no model):
//   (a) success — prompt → stdin (EOF), STDOUT completion returned, args correct;
//   (b) timeout — a child that never exits is KILLED and reported as not-ok;
//   (c) non-zero exit — surfaces the stderr tail, ok:false.
import { describe, expect, test } from "bun:test";

import { runInfer, type InferChildLike, type InferSpawnFn } from "../src/native/infer.ts";

interface Captured {
  cmd: string[];
  stdinWrites: string[];
  stdinEnded: boolean;
  killed: string[];
}

/** Build a stub spawn whose child emits the given stdout/stderr + exit code. */
function makeSpawn(
  cfg: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    /** When true the child never exits on its own (forces the timeout path). */
    hang?: boolean;
    /**
     * When set, emit stdout as these raw byte chunks (one enqueue each) instead
     * of one UTF-8 blob — exercises multi-chunk assembly, including a multibyte
     * codepoint split across a chunk boundary.
     */
    stdoutChunks?: Uint8Array[];
  },
  captured: Captured,
): InferSpawnFn {
  const enc = new TextEncoder();
  const streamOf = (s: string, chunks?: Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (chunks) {
          for (const ch of chunks) c.enqueue(ch);
        } else if (s.length > 0) {
          c.enqueue(enc.encode(s));
        }
        c.close();
      },
    });

  return (opts) => {
    captured.cmd = opts.cmd;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((res) => {
      resolveExit = res;
    });
    if (!cfg.hang) resolveExit(cfg.exitCode ?? 0);

    const child: InferChildLike = {
      stdin: {
        write(d) {
          captured.stdinWrites.push(typeof d === "string" ? d : new TextDecoder().decode(d));
        },
        end() {
          captured.stdinEnded = true;
        },
      },
      stdout: streamOf(cfg.stdout ?? "", cfg.stdoutChunks),
      stderr: streamOf(cfg.stderr ?? ""),
      exited,
      kill(sig) {
        captured.killed.push(String(sig ?? "SIGTERM"));
        // A killed hung child now exits (mirrors a real SIGTERM).
        resolveExit(143);
      },
    };
    return child;
  };
}

function newCaptured(): Captured {
  return { cmd: [], stdinWrites: [], stdinEnded: false, killed: [] };
}

describe("runInfer", () => {
  test("(a) success: writes prompt to stdin, returns trimmed STDOUT, correct args", async () => {
    const captured = newCaptured();
    const res = await runInfer("the prompt", {
      binary: "/fake/hayven-native",
      modelDir: "/home/.hayven/models/gemma4_e2b",
      maxTokens: 64,
      temp: 0.0,
      spawn: makeSpawn({ stdout: "YES they both touch the token contract.\n" }, captured),
    });

    expect(res.ok).toBe(true);
    expect(res.completion).toBe("YES they both touch the token contract.");
    expect(captured.stdinWrites.join("")).toBe("the prompt");
    expect(captured.stdinEnded).toBe(true);
    expect(captured.cmd).toEqual([
      "/fake/hayven-native",
      "infer",
      "--model",
      "/home/.hayven/models/gemma4_e2b",
      "--max-tokens",
      "64",
      "--temp",
      "0",
    ]);
  });

  test("(b) timeout: a hung child is killed and reported not-ok", async () => {
    const captured = newCaptured();
    const res = await runInfer("p", {
      binary: "/fake/hayven-native",
      modelDir: "/m.gguf",
      timeoutMs: 20,
      spawn: makeSpawn({ stdout: "ignored", hang: true }, captured),
    });

    expect(res.ok).toBe(false);
    expect(res.completion).toBe("");
    expect(res.error).toContain("timed out");
    expect(captured.killed.length).toBeGreaterThan(0);
  });

  test("(c) non-zero exit: surfaces stderr tail, ok:false", async () => {
    const captured = newCaptured();
    const res = await runInfer("p", {
      binary: "/fake/hayven-native",
      modelDir: "/m.gguf",
      spawn: makeSpawn({ stderr: "model load failed: bad gguf\n", exitCode: 1 }, captured),
    });

    expect(res.ok).toBe(false);
    expect(res.completion).toBe("");
    expect(res.error).toContain("exited 1");
    expect(res.error).toContain("bad gguf");
  });

  test("multi-chunk stdout is assembled, even when a UTF-8 codepoint splits a chunk", async () => {
    // "café ✓" — split the bytes of 'é' (0xC3 0xA9) and '✓' (0xE2 0x9C 0x93)
    // across chunk boundaries. The streaming TextDecoder must stitch them back
    // together rather than emitting replacement chars.
    const full = new TextEncoder().encode("café ✓ done");
    // Boundaries chosen to land mid-codepoint: after 0xC3, and after 0xE2 0x9C.
    const split = (bytes: Uint8Array): Uint8Array[] => {
      const eAt = 3; // 'c','a','f' then 0xC3|0xA9 for 'é' → cut after 0xC3
      const checkStart = bytes.indexOf(0xe2);
      return [
        bytes.slice(0, eAt + 1), // …0xC3
        bytes.slice(eAt + 1, checkStart + 2), // 0xA9…0xE2 0x9C
        bytes.slice(checkStart + 2), // 0x93…rest
      ];
    };
    const captured = newCaptured();
    const res = await runInfer("p", {
      binary: "/fake/hayven-native",
      modelDir: "/m",
      spawn: makeSpawn({ stdoutChunks: split(full) }, captured),
    });
    expect(res.ok).toBe(true);
    expect(res.completion).toBe("café ✓ done");
  });

  test("exit 0 with empty stdout yields ok:true and an empty completion", async () => {
    // The native binary may legitimately produce an empty completion (e.g.
    // --max-tokens 0); that is a clean success, not an error. The caller
    // (parseVerdict) maps "" to a heuristic fallback, but runInfer itself
    // reports ok:true so the contract (exit 0 ⇒ ok) holds.
    const captured = newCaptured();
    const res = await runInfer("p", {
      binary: "/fake/hayven-native",
      modelDir: "/m",
      spawn: makeSpawn({ stdout: "", exitCode: 0 }, captured),
    });
    expect(res.ok).toBe(true);
    expect(res.completion).toBe("");
    expect(captured.stdinEnded).toBe(true);
  });

  test("an external AbortSignal mid-flight kills the child and reports aborted", async () => {
    const captured = newCaptured();
    const ctrl = new AbortController();
    // A hung child; abort shortly after spawn.
    const p = runInfer("p", {
      binary: "/fake/hayven-native",
      modelDir: "/m",
      timeoutMs: 10_000, // long, so the abort (not the timeout) is what fires
      signal: ctrl.signal,
      spawn: makeSpawn({ stdout: "ignored", hang: true }, captured),
    });
    queueMicrotask(() => ctrl.abort());
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("aborted");
    expect(captured.killed.length).toBeGreaterThan(0);
  });

  test("a spawn that throws is caught and reported, never propagated", async () => {
    const res = await runInfer("p", {
      binary: "/fake/hayven-native",
      modelDir: "/m.gguf",
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("spawn failed");
  });
});
