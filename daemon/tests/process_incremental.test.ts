// BL-2: incremental re-ingest passes the file list NEWLINE-delimited on the
// child's stdin (`--files-stdin`), NOT as a comma-delimited `--files <csv>`
// arg. A real repo path can contain a comma; the old csv transport split
// `a,b.py` into two bogus tokens and the file was never re-ingested.
import { describe, expect, test } from "bun:test";

import { startParse } from "../src/native/process.ts";

interface CapturedSpawn {
  cmd: string[];
  stdinMode: string | undefined;
  stdinWrites: string[];
  stdinEnded: boolean;
}

function makeSpawn(captured: CapturedSpawn[]) {
  const enc = new TextEncoder();
  return (opts: { cmd: string[]; stdin?: string }) => {
    const rec: CapturedSpawn = {
      cmd: opts.cmd,
      stdinMode: opts.stdin,
      stdinWrites: [],
      stdinEnded: false,
    };
    captured.push(rec);
    const child = {
      stdin: {
        write(data: string | Uint8Array) {
          rec.stdinWrites.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        },
        end() {
          rec.stdinEnded = true;
        },
      },
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(JSON.stringify({ type: "version", major: 0, minor: 1, patch: 0, protocol: 2 }) + "\n"));
          c.enqueue(enc.encode(JSON.stringify({ type: "done", files_done: 1, nodes: 0, edges: 0, elapsed_ms: 1 }) + "\n"));
          c.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      exited: Promise.resolve(0),
      kill() {},
    };
    return child as never;
  };
}

const baseOpts = {
  binary: "/fake/hayven-native",
  root: "/repo",
  languages: ["python"],
  jobs: 0,
};

describe("incremental parse --files-stdin transport", () => {
  test("a path containing a comma is one stdin line, not a CSV arg", async () => {
    const captured: CapturedSpawn[] = [];
    const run = startParse({
      ...baseOpts,
      files: ["a,b.py", "src/normal.ts", "dir/with space.go"],
      spawn: makeSpawn(captured),
    });
    for await (const _rec of run.records) {
      /* drain */
    }
    expect(captured).toHaveLength(1);
    const c = captured[0]!;

    // No `--files` CSV arg anywhere.
    expect(c.cmd).not.toContain("--files");
    // The stdin flag IS present.
    expect(c.cmd).toContain("--files-stdin");
    // stdin was piped, written, and closed.
    expect(c.stdinMode).toBe("pipe");
    expect(c.stdinEnded).toBe(true);

    // The list arrives newline-delimited; `a,b.py` is a SINGLE line.
    const written = c.stdinWrites.join("");
    const lines = written.split("\n");
    expect(lines).toEqual(["a,b.py", "src/normal.ts", "dir/with space.go"]);
    expect(lines).toContain("a,b.py");
    expect(lines).not.toContain("a"); // the comma was NOT a delimiter
  });

  test("a full (non-incremental) parse leaves stdin ignored and adds no file flags", async () => {
    const captured: CapturedSpawn[] = [];
    const run = startParse({ ...baseOpts, spawn: makeSpawn(captured) });
    for await (const _rec of run.records) {
      /* drain */
    }
    const c = captured[0]!;
    expect(c.cmd).not.toContain("--files");
    expect(c.cmd).not.toContain("--files-stdin");
    expect(c.stdinMode).toBe("ignore");
    expect(c.stdinWrites).toHaveLength(0);
  });

  test("includeVendored controls the --include-vendored flag (default off)", async () => {
    const drain = async (opts: Parameters<typeof startParse>[0]): Promise<string[]> => {
      const captured: CapturedSpawn[] = [];
      const run = startParse({ ...opts, spawn: makeSpawn(captured) });
      for await (const _rec of run.records) {
        /* drain */
      }
      return captured[0]!.cmd;
    };
    // Default (omitted) + explicit false → no flag (first-party only).
    expect(await drain(baseOpts)).not.toContain("--include-vendored");
    expect(await drain({ ...baseOpts, includeVendored: false })).not.toContain("--include-vendored");
    // Opt-in → the flag is present.
    expect(await drain({ ...baseOpts, includeVendored: true })).toContain("--include-vendored");
  });

  test("includeFixtures controls the --include-fixtures flag (default off)", async () => {
    const drain = async (opts: Parameters<typeof startParse>[0]): Promise<string[]> => {
      const captured: CapturedSpawn[] = [];
      const run = startParse({ ...opts, spawn: makeSpawn(captured) });
      for await (const _rec of run.records) {
        /* drain */
      }
      return captured[0]!.cmd;
    };
    // Default (omitted) + explicit false → no flag (fixtures/examples/benchmarks skipped).
    expect(await drain(baseOpts)).not.toContain("--include-fixtures");
    expect(await drain({ ...baseOpts, includeFixtures: false })).not.toContain("--include-fixtures");
    // Opt-in → the flag is present; independent of includeVendored.
    expect(await drain({ ...baseOpts, includeFixtures: true })).toContain("--include-fixtures");
    expect(await drain({ ...baseOpts, includeFixtures: true })).not.toContain("--include-vendored");
  });
});
