/**
 * The CONTEXT-ESCALATION LADDER (`db/context_escalation.ts`).
 *
 * The contract under test: `buildEscalatingContext` wraps `buildContextPack` in
 * an ordered ladder — `pack → pack-2hop → whole-file` — and picks the cheapest
 * rung still under the honest "open every file" baseline. The headline behaviors
 * to pin:
 *   (1) a multi-rung case where the pack is strictly cheaper than the whole file
 *       → `recommended` is the pack rung, and 2-hop pulls a NEW callee body;
 *   (2) a self-contained function whose 2-hop adds no new slice → the 2-hop rung
 *       is OMITTED (only `pack` + `whole-file` survive);
 *   (3) a tiny file where the precise pack is ≥ the whole file → `recommended`
 *       falls back to the whole-file rung;
 *   (4) an unresolvable symbol → `null`.
 *
 * Fixtures are synthetic in-memory graphs (same pattern as
 * `affected_tests.test.ts`): nodes via `db.upsertNode`, call edges via
 * `db.upsertEdge`. Because `buildContextPack` reads REAL file text off each
 * node's `range`, we write small temp source files under a `mkdtempSync`
 * repoRoot and point each node's `file` at the repo-relative path with the
 * matching 1-based inclusive line range.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Db } from "../src/db/queries.ts";
import type { NodeKind } from "../src/graph/types.ts";
import { buildEscalatingContext } from "../src/db/context_escalation.ts";

function freshDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  return db;
}

/** Seed a function node whose `name`==`qualified_name` (so a fuzzy FTS resolve
 *  is unambiguous) at a 1-based inclusive `[start,end]` line range in `file`. */
function seedNode(
  db: Db,
  id: string,
  name: string,
  file: string,
  start: number,
  end: number,
  kind: NodeKind = "function",
): void {
  db.upsertNode({
    id,
    name,
    qualified_name: name,
    kind,
    language: "typescript",
    file,
    range: [start, end],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

/** A resolved static call edge `src → dst`. */
function callEdge(db: Db, src: string, dst: string, weight = 1): void {
  db.upsertEdge({ src, dst, kind: "static_call", weight, last_seen: 0 });
}

/** Write a repo-relative source file under the temp repoRoot. */
function writeSource(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

let repoRoot: string;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "hayven-escalation-"));
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("buildEscalatingContext — multi-rung (pack < whole-file)", () => {
  it("builds pack → pack-2hop → whole-file, pulls a 2-hop callee, recommends the pack rung", () => {
    const db = freshDb();

    // entry() calls mid(); mid() calls deep(). The 1-hop pack of `entry` sees
    // `mid` as a callee; the 2-hop rung must additionally pull `deep`'s body
    // (reached only through mid → deep). Each lives in its own file so the
    // whole-file rung opens three real files (clearly bigger than the slice).
    const entrySrc = [
      "// entry module",
      "import { mid } from './mid.ts';", // line 2
      "", // 3
      "export function entry() {", // 4
      "  return mid() + 1;", // 5
      "}", // 6
    ].join("\n");
    // Pad mid/deep files with extra module-scope text so the WHOLE file is
    // visibly larger than the sliced function body.
    const midSrc = [
      "// mid module — lots of unrelated module text to make the file fat",
      "const UNUSED_A = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';",
      "const UNUSED_B = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';",
      "import { deep } from './deep.ts';", // line 4
      "", // 5
      "export function mid() {", // 6
      "  return deep() * 2;", // 7
      "}", // 8
      "const UNUSED_C = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';",
    ].join("\n");
    const deepSrc = [
      "// deep module — also padded with unrelated module text",
      "const PAD_1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';",
      "const PAD_2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';",
      "", // 4
      "export function deep() {", // 5
      "  return 42;", // 6
      "}", // 7
      "const PAD_3 = 'cccccccccccccccccccccccccccccccccccccccccccccc';",
    ].join("\n");

    writeSource(repoRoot, "entry.ts", entrySrc);
    writeSource(repoRoot, "mid.ts", midSrc);
    writeSource(repoRoot, "deep.ts", deepSrc);

    seedNode(db, "entry.ts#entry", "entry", "entry.ts", 4, 6);
    seedNode(db, "mid.ts#mid", "mid", "mid.ts", 6, 8);
    seedNode(db, "deep.ts#deep", "deep", "deep.ts", 5, 7);
    callEdge(db, "entry.ts#entry", "mid.ts#mid", 1);
    callEdge(db, "mid.ts#mid", "deep.ts#deep", 1);

    const res = buildEscalatingContext(db, repoRoot, "entry.ts#entry");
    expect(res).not.toBeNull();
    const r = res!;

    expect(r.symbol).toBe("entry.ts#entry");
    expect(r.resolved).toBeNull(); // exact id match → not fuzzy-resolved

    // All three rungs present, in cheapest→richest order.
    expect(r.rungs.map((x) => x.level)).toEqual(["pack", "pack-2hop", "whole-file"]);

    const pack = r.rungs[0]!;
    const twoHop = r.rungs[1]!;
    const whole = r.rungs[2]!;

    // The pack rung sees `mid` as a callee but NOT `deep`.
    expect(pack.slices.some((s) => s.id === "mid.ts#mid")).toBe(true);
    expect(pack.slices.some((s) => s.id === "deep.ts#deep")).toBe(false);

    // The 2-hop rung adds `deep`'s body (reached via mid → deep).
    expect(twoHop.slices.some((s) => s.id === "deep.ts#deep")).toBe(true);
    expect(twoHop.slices.length).toBeGreaterThan(pack.slices.length);

    // Dedup: no two slices in any rung share the (file,start,end) key.
    for (const rung of r.rungs) {
      const keys = rung.slices.map((s) => `${s.file}:${s.startLine}-${s.endLine}`);
      expect(new Set(keys).size).toBe(keys.length);
    }

    // The whole-file rung is one slice per touched file, role:"target".
    expect(whole.slices.every((s) => s.role === "target" && s.kind === "file" && s.id === null)).toBe(true);
    expect(new Set(whole.files)).toEqual(new Set(["entry.ts", "mid.ts", "deep.ts"]));

    // Monotonic-ish cost: each rung is at least as expensive as the previous, and
    // the precise rungs are strictly cheaper than opening every whole file.
    expect(twoHop.estTokens).toBeGreaterThanOrEqual(pack.estTokens);
    expect(pack.estTokens).toBeLessThan(whole.estTokens);

    // The cheapest rung under the whole-file baseline is `pack`.
    expect(r.recommended.level).toBe("pack");
    expect(r.notes.some((n) => n.includes("pack"))).toBe(true);
  });
});

describe("buildEscalatingContext — self-contained (2-hop omitted)", () => {
  it("omits the pack-2hop rung when it adds no new slice over the pack rung", () => {
    const db = freshDb();

    // `solo` calls nothing — its pack has no call-edge neighbor to expand, so the
    // 2-hop rung would be identical to the pack rung and must be OMITTED.
    const soloSrc = [
      "// solo module",
      "const PAD = 'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';",
      "", // 3
      "export function solo() {", // 4
      "  return 7;", // 5
      "}", // 6
    ].join("\n");
    writeSource(repoRoot, "solo.ts", soloSrc);
    seedNode(db, "solo.ts#solo", "solo", "solo.ts", 4, 6);

    const res = buildEscalatingContext(db, repoRoot, "solo.ts#solo");
    expect(res).not.toBeNull();
    const r = res!;

    // Pack and whole-file survive; pack-2hop is omitted (no new context).
    expect(r.rungs.map((x) => x.level)).toEqual(["pack", "whole-file"]);
    expect(r.notes.some((n) => n.includes("pack-2hop omitted"))).toBe(true);
  });
});

describe("buildEscalatingContext — tiny file (pack >= whole-file)", () => {
  it("recommends the whole-file rung when the precise pack is not smaller than the file", () => {
    const db = freshDb();

    // A file that is ENTIRELY the target function — the pack (header skeleton +
    // target body) can only be >= the whole file, so no precise rung beats it
    // and `recommended` falls back to the whole-file rung.
    const tinySrc = ["export function tiny() {", "  return 1;", "}"].join("\n");
    writeSource(repoRoot, "tiny.ts", tinySrc);
    seedNode(db, "tiny.ts#tiny", "tiny", "tiny.ts", 1, 3);

    const res = buildEscalatingContext(db, repoRoot, "tiny.ts#tiny");
    expect(res).not.toBeNull();
    const r = res!;

    const whole = r.rungs.find((x) => x.level === "whole-file")!;
    expect(whole).toBeDefined();
    // No precise rung is strictly cheaper than the whole file.
    const pack = r.rungs.find((x) => x.level === "pack")!;
    expect(pack.estTokens).toBeGreaterThanOrEqual(whole.estTokens);
    expect(r.recommended.level).toBe("whole-file");
    expect(r.notes.some((n) => n.includes("tiny-file"))).toBe(true);
  });
});

describe("buildEscalatingContext — maxRung cap", () => {
  it("stops the ladder at maxRung:'pack'", () => {
    const db = freshDb();
    const src = [
      "// capped",
      "import { other } from './other.ts';", // 2
      "", // 3
      "export function capped() {", // 4
      "  return other();", // 5
      "}", // 6
    ].join("\n");
    const otherSrc = ["export function other() {", "  return 9;", "}"].join("\n");
    writeSource(repoRoot, "capped.ts", src);
    writeSource(repoRoot, "other.ts", otherSrc);
    seedNode(db, "capped.ts#capped", "capped", "capped.ts", 4, 6);
    seedNode(db, "other.ts#other", "other", "other.ts", 1, 3);
    callEdge(db, "capped.ts#capped", "other.ts#other", 1);

    const res = buildEscalatingContext(db, repoRoot, "capped.ts#capped", { maxRung: "pack" });
    expect(res).not.toBeNull();
    const r = res!;
    expect(r.rungs.map((x) => x.level)).toEqual(["pack"]);
    // With no whole-file ceiling, recommendation is the richest built rung.
    expect(r.recommended.level).toBe("pack");
  });
});

describe("buildEscalatingContext — unresolved symbol", () => {
  it("returns null when the symbol resolves to nothing", () => {
    const db = freshDb();
    seedNode(db, "real.ts#real", "real", "real.ts", 1, 3);
    writeSource(repoRoot, "real.ts", ["export function real() {", "  return 0;", "}"].join("\n"));

    const res = buildEscalatingContext(db, repoRoot, "totally::nonexistent::zzz");
    expect(res).toBeNull();
  });
});

describe("buildEscalatingContext — absolute node file path", () => {
  it("reads an absolute `file` for the whole-file rung (no repoRoot double-join) and never recommends an empty rung", () => {
    const db = freshDb();

    // The packer's `makeFileReader` reads an ABSOLUTE node `file` as-is, but the
    // whole-file rung used to ALWAYS `join(repoRoot, file)` — joining an already-
    // absolute path doubles the root (`repoRoot + "/abs/path"`), so the read
    // ENOENT'd and the file the pack rung saw fine was silently dropped. That
    // produced an EMPTY whole-file rung (0 slices) which the recommendation logic
    // then preferred over the perfectly good pack rung — handing the caller no
    // context at all. Pin both halves: the rung reads the file, and the
    // recommendation carries the target body.
    const absFile = join(repoRoot, "abs-target.ts");
    writeSource(repoRoot, "abs-target.ts", ["export function af() {", "  return 1;", "}"].join("\n"));
    // Seed directly (the `seedNode` helper assumes a repo-relative path); the id
    // doubles as the file's absolute path so the fuzzy resolve is unambiguous.
    db.upsertNode({
      id: "af",
      name: "af",
      qualified_name: "af",
      kind: "function",
      language: "typescript",
      file: absFile,
      range: [1, 3],
      ast_hash: "h",
      last_seen: 0,
      logical_clock: 0,
    });

    const res = buildEscalatingContext(db, repoRoot, "af");
    expect(res).not.toBeNull();
    const r = res!;

    // The whole-file rung actually read the file (one slice, non-empty), instead
    // of dropping it to a double-joined ENOENT.
    const whole = r.rungs.find((x) => x.level === "whole-file")!;
    expect(whole.slices.length).toBe(1);
    expect(whole.estTokens).toBeGreaterThan(0);

    // No "could not read … for the whole-file rung" failure note this time.
    expect(r.notes.some((n) => n.includes("could not read"))).toBe(false);

    // The recommendation is never the empty/contextless rung — it carries the
    // target body.
    expect(r.recommended.slices.length).toBeGreaterThan(0);
    expect(r.recommended.slices.some((s) => s.id === "af" || s.role === "target")).toBe(true);
  });
});

describe("buildEscalatingContext — unreadable whole-file rung", () => {
  it("does not recommend an empty whole-file rung, and labels it honestly (not the tiny-file case)", () => {
    const db = freshDb();

    // The whole-file rung can read NONE of its files — here the node's `file`
    // points at a DIRECTORY, so every `readFileSync` throws (the same shape as a
    // file deleted between the pack read and the whole-file read). The rung is
    // then EMPTY (0 slices, 0 tok). It must NOT be recommended as the ceiling —
    // an empty rung carries no context, and labeling it the "tiny-file case"
    // (the precise pack is not smaller than the file) would be a lie: the rung
    // is empty because the read FAILED, not because the file is small.
    mkdirSync(join(repoRoot, "is-a-dir.ts"), { recursive: true });
    seedNode(db, "is-a-dir.ts#x", "x", "is-a-dir.ts", 1, 3);

    const res = buildEscalatingContext(db, repoRoot, "is-a-dir.ts#x");
    expect(res).not.toBeNull();
    const r = res!;

    const whole = r.rungs.find((x) => x.level === "whole-file")!;
    expect(whole.slices.length).toBe(0); // every read failed → empty rung

    // The recommendation is not the empty whole-file rung, and the rationale note
    // calls out the unreadable rung rather than the (wrong) tiny-file rationale.
    expect(r.recommended.level).not.toBe("whole-file");
    expect(r.notes.some((n) => n.includes("read none of its files"))).toBe(true);
    expect(r.notes.some((n) => n.includes("tiny-file"))).toBe(false);
  });
});
