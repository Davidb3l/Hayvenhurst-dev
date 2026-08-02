/**
 * Round 2 — the HTTP twin of the MCP wire, and the guard that had no test.
 *
 * TWO findings, both about `GET /api/context`:
 *
 * 1. `?top=N` was UNBOUNDED. `intParam` accepted any finite number, and every
 *    resolved symbol then costs a full `buildContextPack` — graph walks plus a
 *    whole-file read each — on the daemon's SINGLE event loop. `top=1e9` on a
 *    600-entity repo with 500 KB files measured 440 ms, 135 MB RSS and ~300 MB
 *    read. The MCP wire caps its equivalent at `MAX_SYMBOLS`; this route capped
 *    nothing, and the daemon has no Origin gate, so any web page open in the
 *    user's browser can fire it at 127.0.0.1:7777 in a loop.
 *
 * 2. `countOpt` — the packer-side floor on the numeric knobs — was pinned by
 *    ZERO tests. Every existing opt-bounds assertion went through the MCP wire,
 *    which rejects first, so replacing the whole guard with the pre-fix
 *    `return v ?? dflt` left all of them green. It matters precisely BECAUSE
 *    this route has its own parsing: `countOpt` is the last line of defence for
 *    any caller that isn't the MCP wire. These tests drive `buildContextPack`
 *    DIRECTLY (no wire) so the guard itself is the thing under test.
 *
 * NB the dev gotcha from `context_route.test.ts`: Elysia `app.handle` is
 * hostname-sensitive — always build the Request with `http://localhost/...`.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import {
  buildContextPack,
  buildContextPackForChange,
} from "../src/db/context_pack.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";
import type { EdgeKind } from "../src/graph/types.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function writeRepoFile(repoRoot: string, relPath: string, content: string) {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function node(db: Db, id: string, file: string, start: number, end: number, name?: string) {
  db.upsertNode({
    id,
    name: name ?? id.split("/").pop() ?? id,
    qualified_name: id,
    kind: "function",
    language: "typescript",
    file,
    range: [start, end],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

function edge(db: Db, src: string, dst: string, kind: EdgeKind) {
  db.upsertEdge({ src, dst, kind, weight: 1, last_seen: 0 });
}

/**
 * `handler` calls THREE helpers in another file, so a dropped-neighbors
 * regression is visible as a large, unambiguous line-count difference rather
 * than a one-line wobble. It ALSO references a same-file `Shape` interface long
 * enough to be truncated — without a `via:"ref"` neighbor, `maxRefSliceLines`
 * is never consulted and any test of it would be vacuous.
 */
function seed(db: Db, repoRoot: string) {
  db.migrate();
  writeRepoFile(
    repoRoot,
    "src/handler.ts",
    [
      "import { alpha, beta, gamma } from './helpers';", // 1
      "", // 2
      "export interface Shape {", // 3
      "  a: number;", // 4
      "  b: number;", // 5
      "  c: number;", // 6
      "  d: number;", // 7
      "  e: number;", // 8
      "  f: number;", // 9
      "  g: number;", // 10
      "  h: number;", // 11
      "  i: number;", // 12
      "  j: number;", // 13
      "  k: number;", // 14
      "  l: number;", // 15
      "}", // 16
      "", // 17
      "export function handler(s: Shape): string {", // 18
      "  return alpha(beta(gamma(String(s.a))));", // 19
      "}", // 20
      "", // 21
    ].join("\n"),
  );
  writeRepoFile(
    repoRoot,
    "src/helpers.ts",
    [
      "export function alpha(s: string): string {", // 1
      "  return s + 'a';", // 2
      "}", // 3
      "export function beta(s: string): string {", // 4
      "  return s + 'b';", // 5
      "}", // 6
      "export function gamma(s: string): string {", // 7
      "  return s + 'g';", // 8
      "}", // 9
      "", // 10
    ].join("\n"),
  );
  node(db, "handler", "src/handler.ts", 18, 20);
  db.upsertNode({
    id: "Shape",
    name: "Shape",
    qualified_name: "Shape",
    kind: "class", // the parser's kind for interface/type-like declarations
    language: "typescript",
    file: "src/handler.ts",
    range: [3, 16],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
  node(db, "helpers/alpha", "src/helpers.ts", 1, 3, "alpha");
  node(db, "helpers/beta", "src/helpers.ts", 4, 6, "beta");
  node(db, "helpers/gamma", "src/helpers.ts", 7, 9, "gamma");
  for (const dst of ["helpers/alpha", "helpers/beta", "helpers/gamma"]) {
    edge(db, "handler", dst, "static_call");
  }
}

function freshRepo(): string {
  const r = mkdtempSync(join(tmpdir(), "hayven-fixa-ctxroute-"));
  dirs.push(r);
  return r;
}

function buildTestApp(db: Db, repoRoot: string) {
  return buildApp({
    db,
    config: DEFAULT_CONFIG,
    paths: hayvenPathsFor(repoRoot),
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used");
      },
    },
  });
}

function setup() {
  const repoRoot = freshRepo();
  const db = new Db(":memory:");
  seed(db, repoRoot);
  return { repoRoot, db, app: buildTestApp(db, repoRoot) };
}

async function get(app: ReturnType<typeof buildApp>, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// 1. `?top=N`
// ---------------------------------------------------------------------------

describe("round 2 — GET /api/context?top=N is bounded", () => {
  it("rejects an absurd top with 400 instead of packing a billion symbols", async () => {
    const { app, db } = setup();
    const { status, body } = await get(app, "/api/context?task=handler&top=1000000000");
    expect(status).toBe(400);
    expect(String(body["error"])).toMatch(/`top` must be between/);
    db.close();
  });

  it("rejects top=1e9 in exponential spelling too", async () => {
    const { app, db } = setup();
    expect((await get(app, "/api/context?task=handler&top=1e9")).status).toBe(400);
    db.close();
  });

  it("rejects a non-integer and a zero/negative top", async () => {
    const { app, db } = setup();
    expect((await get(app, "/api/context?task=handler&top=abc")).status).toBe(400);
    expect((await get(app, "/api/context?task=handler&top=2.5")).status).toBe(400);
    expect((await get(app, "/api/context?task=handler&top=0")).status).toBe(400);
    expect((await get(app, "/api/context?task=handler&top=-1")).status).toBe(400);
    db.close();
  });

  it("still serves an in-range top, and the default when absent", async () => {
    const { app, db } = setup();
    const capped = await get(app, "/api/context?task=handler&top=2");
    expect(capped.status).toBe(200);
    expect((capped.body["packs"] as unknown[]).length).toBeLessThanOrEqual(2);
    const dflt = await get(app, "/api/context?task=handler");
    expect(dflt.status).toBe(200);
    expect(Array.isArray(dflt.body["packs"])).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 2. The route's own knob validation
// ---------------------------------------------------------------------------

describe("round 2 — the route rejects out-of-range knobs instead of silently substituting", () => {
  it("400s on a negative maxNeighbors rather than 200 with neighbors dropped", async () => {
    const { app, db } = setup();
    const { status, body } = await get(app, "/api/context/handler?maxNeighbors=-3");
    expect(status).toBe(400);
    expect(String(body["error"])).toMatch(/`maxNeighbors` must be between/);
    db.close();
  });

  it("400s on maxRefSliceLines below 1 (it yields an inverted slice range)", async () => {
    const { app, db } = setup();
    expect((await get(app, "/api/context/handler?maxRefSliceLines=0")).status).toBe(400);
    expect((await get(app, "/api/context/handler?maxRefSliceLines=-1000000")).status).toBe(400);
    db.close();
  });

  it("400s on a fractional or absurd knob", async () => {
    const { app, db } = setup();
    expect((await get(app, "/api/context/handler?maxNeighbors=1.5")).status).toBe(400);
    expect((await get(app, "/api/context/handler?maxNeighbors=1e18")).status).toBe(400);
    db.close();
  });

  it("still serves valid knobs (not over-broad)", async () => {
    const { app, db } = setup();
    const { status, body } = await get(app, "/api/context/handler?maxNeighbors=2");
    expect(status).toBe(200);
    expect(Array.isArray(body["slices"])).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 3. `countOpt` itself — NO wire in front of it.
// ---------------------------------------------------------------------------

describe("round 2 — countOpt is the last line of defence for non-wire callers", () => {
  /** The pack a correct default produces — the yardstick for "not degraded". */
  function baseline() {
    const { repoRoot, db } = setup();
    const pack = buildContextPack(db, repoRoot, "handler", {});
    expect(pack).not.toBeNull();
    return { repoRoot, db, pack: pack! };
  }

  it("a negative maxNeighbors falls back to the default, keeping every neighbor", () => {
    // The demonstrated regression: with the guard reverted this returned 4
    // lines instead of 7 — all three neighbors silently dropped — and over
    // HTTP that was an HTTP 200. This asserts the DEFAULT behaviour is
    // restored, not merely that nothing threw.
    const { repoRoot, db, pack } = baseline();
    const got = buildContextPack(db, repoRoot, "handler", { maxNeighbors: -3 });
    expect(got).not.toBeNull();
    expect(got!.slices.length).toBe(pack.slices.length);
    expect(got!.lineCount).toBe(pack.lineCount);
    const baseNeighbors = pack.slices.filter((s) => s.role === "neighbor").length;
    // Precondition: the baseline actually HAS neighbors, so "same count" means
    // something. (3 call neighbors + the `Shape` ref.)
    expect(baseNeighbors).toBe(4);
    expect(got!.slices.filter((s) => s.role === "neighbor").length).toBe(baseNeighbors);
    db.close();
  });

  it("a negative maxRefSliceLines cannot produce an inverted slice range", () => {
    const { repoRoot, db, pack } = baseline();
    // Precondition: the baseline really does contain a TRUNCATED ref slice, so
    // `maxRefSliceLines` is actually consulted. Without this the loop below
    // would pass on any implementation.
    expect(pack.slices.some((s) => s.via === "ref" && s.truncatedFromEndLine)).toBe(true);
    for (const maxRefSliceLines of [-1_000_000, -1, 0, 1.5, NaN]) {
      const got = buildContextPack(db, repoRoot, "handler", { maxRefSliceLines });
      expect(got).not.toBeNull();
      for (const s of got!.slices) {
        expect(s.endLine).toBeGreaterThanOrEqual(s.startLine);
      }
      // A negative cap made lineCount hugely negative via
      // `endLine - startLine + 1`.
      expect(got!.lineCount).toBeGreaterThan(0);
      expect(got!.estTokens).toBeGreaterThan(0);
    }
    db.close();
  });

  it("a negative maxHeaderLines does not corrupt the header", () => {
    const { repoRoot, db, pack } = baseline();
    const got = buildContextPack(db, repoRoot, "handler", { maxHeaderLines: -500 });
    expect(got).not.toBeNull();
    expect(got!.slices.length).toBe(pack.slices.length);
    for (const s of got!.slices) expect(s.endLine).toBeGreaterThanOrEqual(s.startLine);
    db.close();
  });

  it("a fractional / NaN / Infinity knob falls back rather than propagating", () => {
    const { repoRoot, db, pack } = baseline();
    for (const maxNeighbors of [2.5, NaN, Infinity, -Infinity]) {
      const got = buildContextPack(db, repoRoot, "handler", { maxNeighbors });
      expect(got).not.toBeNull();
      expect(got!.slices.length).toBe(pack.slices.length);
    }
    db.close();
  });

  it("a negative maxHeaderLines cannot silently collapse the module frame", () => {
    // Finding 9: `buildContextPackForChange` read `opts.maxHeaderLines` RAW when
    // forwarding it to `buildModuleFrame`, unlike the two guarded reads
    // elsewhere. A negative value then reached `computeModuleScope`, whose
    // trimmer drops every segment when `total > maxLines` can never be
    // satisfied — so the module header vanished and only the gap-fill's
    // changed-line run survived. Silent, and the pack still looked well-formed.
    //
    // The knob is now floored at BOTH the call site and inside
    // `buildModuleFrame`; this asserts the observable outcome (reverting both
    // yields `[4,4]` instead of `[1,4]`).
    const repoRoot = freshRepo();
    writeRepoFile(
      repoRoot,
      "m.ts",
      [
        "import { z } from './z';", // 1
        "import { y } from './y';", // 2
        "const K = 1;", // 3
        "const J = 2;", // 4
        "", // 5
        "export function one(): number {", // 6
        "  return K;", // 7
        "}", // 8
        "", // 9
      ].join("\n"),
    );
    const db = new Db(":memory:");
    db.migrate();
    node(db, "m.ts::one", "m.ts", 6, 8, "one");

    const baseline = buildContextPackForChange(db, repoRoot, "m.ts", [
      { startLine: 4, endLine: 4 },
    ]);
    // Precondition: the default really does pull in the whole module header,
    // so "same as default" is a meaningful claim.
    expect(baseline!.slices.map((s) => [s.startLine, s.endLine])).toEqual([[1, 4]]);

    for (const maxHeaderLines of [-5, -1_000_000, 0.5, NaN]) {
      const got = buildContextPackForChange(
        db,
        repoRoot,
        "m.ts",
        [{ startLine: 4, endLine: 4 }],
        { maxHeaderLines },
      );
      expect(got!.slices.map((s) => [s.startLine, s.endLine])).toEqual([[1, 4]]);
    }
    db.close();
  });

  it("0 still legitimately means 'no neighbors'", () => {
    // The floor must not swallow the meaningful zero.
    const { repoRoot, db } = baseline();
    const got = buildContextPack(db, repoRoot, "handler", { maxNeighbors: 0 });
    expect(got).not.toBeNull();
    expect(got!.slices.filter((s) => s.role === "neighbor").length).toBe(0);
    db.close();
  });
});
