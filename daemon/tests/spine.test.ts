// Tests for the suite event spine PRODUCER (SUITE_CONTRACTS §2). The emitter is
// pure fs + crypto, so we exercise it in isolation against a temp dir — no
// native watcher binary required.
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCodeChangedLine, emitCodeChanged } from "../src/spine.ts";

// Conformance regexes — MIRROR the validator the contract describes.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TYPE_RE = /^[a-z]+(\.[a-z]+)+$/;
const SOURCES = new Set(["amt", "hayven", "sirius", "catryna", "guignet", "agent"]);

const MAX_LINE_BYTES = 4096;
// A fixed instant on 2026-07-11 UTC so the day-bucket filename is deterministic.
const FIXED_MS = Date.parse("2026-07-11T12:34:56Z");
const FIXED_DATE = "2026-07-11";

function eventsFile(repoRoot: string, date = FIXED_DATE): string {
  return join(repoRoot, ".suite", "events", `${date}.jsonl`);
}

describe("spine code.changed emitter", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    cleanups.length = 0;
  });

  function newRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "hayven-spine-"));
    cleanups.push(dir);
    return dir;
  }

  it("emits a contract-shaped envelope to .suite/events/<date>.jsonl", () => {
    const repo = newRepo();
    emitCodeChanged({
      repoRoot: repo,
      files: ["src/a.ts", "src/b.ts"],
      symbols: ["src/a.ts#foo", "src/b.ts#Bar"],
      now: () => FIXED_MS,
    });

    const path = eventsFile(repo);
    expect(existsSync(path)).toBe(true);

    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    // Exactly one line + trailing newline.
    expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(1);

    const ev = JSON.parse(raw);
    expect(ev.v).toBe(1);
    expect(ev.source).toBe("hayven");
    expect(SOURCES.has(ev.source)).toBe(true);
    expect(ev.type).toBe("code.changed");
    expect(TYPE_RE.test(ev.type)).toBe(true);
    expect(UUID_V4.test(ev.id)).toBe(true);
    expect(TS_UTC.test(ev.ts)).toBe(true);
    expect(ev.ts.endsWith("Z")).toBe(true);

    expect(Array.isArray(ev.refs)).toBe(true);
    for (const r of ev.refs) expect(typeof r).toBe("string");
    expect(ev.refs).toEqual(["hayven:node/src/a.ts#foo", "hayven:node/src/b.ts#Bar"]);

    expect(typeof ev.data).toBe("object");
    expect(ev.data).not.toBeNull();
    expect(ev.data.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(ev.data.symbols).toEqual(["src/a.ts#foo", "src/b.ts#Bar"]);
  });

  it("appends rather than overwrites — two emits produce two lines", () => {
    const repo = newRepo();
    emitCodeChanged({ repoRoot: repo, files: ["a.ts"], symbols: ["a.ts#x"], now: () => FIXED_MS });
    emitCodeChanged({ repoRoot: repo, files: ["b.ts"], symbols: ["b.ts#y"], now: () => FIXED_MS });

    const raw = readFileSync(eventsFile(repo), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.data.files).toEqual(["a.ts"]);
    expect(second.data.files).toEqual(["b.ts"]);
    // Distinct ids per event.
    expect(first.id).not.toBe(second.id);
  });

  it("every emitted line is < 4096 bytes including the newline", () => {
    const repo = newRepo();
    emitCodeChanged({
      repoRoot: repo,
      files: ["src/a.ts", "src/b.ts"],
      symbols: ["src/a.ts#foo", "src/b.ts#Bar"],
      now: () => FIXED_MS,
    });
    for (const line of readFileSync(eventsFile(repo), "utf8").split("\n")) {
      if (line.length === 0) continue;
      expect(Buffer.byteLength(line, "utf8") + 1).toBeLessThan(MAX_LINE_BYTES);
    }
  });

  it("truncates an oversized symbol set to a valid sub-4096 line, preserving files", () => {
    const files = ["src/big.ts"];
    // Thousands of symbols — the full payload is far over 4096 bytes.
    const symbols = Array.from({ length: 5000 }, (_, i) => `src/big.ts#sym_${i}`);

    const line = buildCodeChangedLine({
      id: "00000000-0000-4000-8000-000000000000",
      ts: "2026-07-11T12:34:56Z",
      files,
      symbols,
    });

    // Fits atomically...
    expect(Buffer.byteLength(line, "utf8") + 1).toBeLessThan(MAX_LINE_BYTES);
    // ...is still valid JSON with the truncation marker, and preserves files.
    const ev = JSON.parse(line);
    expect(ev.data.truncated).toBe(true);
    expect(ev.data.symbols).toEqual([]);
    expect(ev.refs).toEqual([]);
    expect(ev.data.files).toEqual(files);
    expect(ev.type).toBe("code.changed");
    expect(UUID_V4.test(ev.id)).toBe(true);
  });

  it("falls back to a minimal marker when even the file set overflows", () => {
    // A file list so large that {files, symbols:[], truncated:true} also blows
    // the budget — the emitter must still produce a valid, atomic line.
    const files = Array.from({ length: 5000 }, (_, i) => `src/very/deep/path/file_${i}.ts`);
    const symbols = Array.from({ length: 5000 }, (_, i) => `s#${i}`);

    const line = buildCodeChangedLine({
      id: "11111111-1111-4111-8111-111111111111",
      ts: "2026-07-11T12:34:56Z",
      files,
      symbols,
    });

    expect(Buffer.byteLength(line, "utf8") + 1).toBeLessThan(MAX_LINE_BYTES);
    const ev = JSON.parse(line);
    expect(ev.data).toEqual({ truncated: true });
    expect(ev.refs).toEqual([]);
    expect(ev.type).toBe("code.changed");
  });
});
