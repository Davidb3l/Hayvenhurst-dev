// Version-skew handling on the parse path (§16.4). Mocks the spawn so no
// real binary is needed. Regression guard: a major-skewed binary used to be
// swallowed by the generic NDJSON catch and ingested anyway.
import { describe, expect, test } from "bun:test";

import { startParse } from "../src/native/process.ts";

interface FakeChild {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

function fakeChildEmitting(lines: string[]): FakeChild {
  const enc = new TextEncoder();
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(enc.encode(l + "\n"));
        c.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    exited: Promise.resolve(0),
    kill() {},
  };
}

function mockSpawn(lines: string[]) {
  return () => fakeChildEmitting(lines) as never;
}

const baseOpts = {
  binary: "/fake/hayven-native",
  root: "/repo",
  languages: ["python"],
  jobs: 0,
};

describe("parse-path version handshake", () => {
  test("aborts iteration on a major-version skew", async () => {
    const run = startParse({
      ...baseOpts,
      spawn: mockSpawn([
        JSON.stringify({ type: "version", major: 99, minor: 0, patch: 0, protocol: 2 }),
        JSON.stringify({ type: "node", file: "a.py", name: "f", kind: "function", qualified_name: "f", language: "python", range: [1, 2], ast_hash: "x" }),
      ]),
    });
    let threw = false;
    let yielded = 0;
    try {
      for await (const _rec of run.records) yielded += 1;
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("version skew");
    }
    expect(threw).toBe(true);
    // The node record after the bad version must NOT have been yielded.
    expect(yielded).toBe(0);
  });

  test("accepts a matching major and yields records", async () => {
    const run = startParse({
      ...baseOpts,
      spawn: mockSpawn([
        JSON.stringify({ type: "version", major: 0, minor: 1, patch: 0, protocol: 2 }),
        JSON.stringify({ type: "start", files_total: 1, version: "0.1.0" }),
        JSON.stringify({ type: "done", files_done: 1, nodes: 0, edges: 0, elapsed_ms: 1 }),
      ]),
    });
    const kinds: string[] = [];
    for await (const rec of run.records) kinds.push(rec.type);
    expect(kinds).toEqual(["version", "start", "done"]);
  });

  test("tolerates an old 0.0.1 binary that emits `start` first (no version)", async () => {
    const run = startParse({
      ...baseOpts,
      spawn: mockSpawn([
        JSON.stringify({ type: "start", files_total: 0, version: "0.0.1" }),
        JSON.stringify({ type: "done", files_done: 0, nodes: 0, edges: 0, elapsed_ms: 1 }),
      ]),
    });
    const kinds: string[] = [];
    for await (const rec of run.records) kinds.push(rec.type);
    expect(kinds).toEqual(["start", "done"]);
  });
});
