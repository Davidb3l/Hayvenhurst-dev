/**
 * Phase 0.0.4.5 adoption layer: the context-packer HTTP endpoint
 * (`daemon/src/daemon/routes/context.ts`).
 *
 * Exercises the route end-to-end through `buildApp` with an in-memory `Db`, a
 * tiny seeded graph (call + import edges), and a TEMP repo with REAL source
 * files on disk (so `buildContextPack` can slice line-exact bodies). Asserts:
 *   - a known symbol returns a pack with header + target + neighbor slices;
 *   - `?neighbors=false` drops the neighbors;
 *   - an unknown symbol 404s with a helpful body;
 *   - slash-containing ids work both raw (`/api/context/a/b/c`) and url-encoded;
 *   - task mode (`?task=…`) returns `{ task, resolved, packs }`.
 *
 * NB the dev gotcha: Elysia `app.handle` is hostname-sensitive — ALWAYS build the
 * Request with `http://localhost/...` or routes 404 even when registered.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { EdgeKind } from "../src/graph/types.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

/** Write a file under the repo root, creating parent dirs. */
function writeRepoFile(repoRoot: string, relPath: string, content: string) {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Seed one entity node whose 1-based inclusive line range is [start,end]. */
function node(
  db: Db,
  id: string,
  file: string,
  start: number,
  end: number,
  name = id.split("/").pop() ?? id,
) {
  db.upsertNode({
    id,
    name,
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
 * A tiny repo + graph: `handler` (target) calls `parseCookie` in another file,
 * and is imported by a module. Real files on disk so the packer slices bodies.
 */
function seed(db: Db, repoRoot: string) {
  db.migrate();

  const handlerSrc = [
    "import { parseCookie } from './cookie';", // 1
    "", // 2
    "const PREFIX = 'sid=';", // 3
    "", // 4
    "export function handler(req: Request): string {", // 5
    "  const raw = req.headers.get('cookie') ?? '';", // 6
    "  return parseCookie(raw, PREFIX);", // 7
    "}", // 8
    "", // 9
  ].join("\n");
  writeRepoFile(repoRoot, "src/handler.ts", handlerSrc);

  const cookieSrc = [
    "export function parseCookie(raw: string, prefix: string): string {", // 1
    "  const part = raw.split(';').find((p) => p.trim().startsWith(prefix));", // 2
    "  return part ? part.trim().slice(prefix.length) : '';", // 3
    "}", // 4
    "", // 5
  ].join("\n");
  writeRepoFile(repoRoot, "src/cookie.ts", cookieSrc);

  // Entity nodes (1-based inclusive ranges into the real files above).
  node(db, "handler", "src/handler.ts", 5, 8);
  node(db, "cookie/parseCookie", "src/cookie.ts", 1, 4, "parseCookie");
  // A module that imports the handler (so impact/refs have an import edge too).
  node(db, "app", "src/app.ts", 1, 1);

  // Edges: handler --call--> parseCookie ; app --import--> handler.
  edge(db, "handler", "cookie/parseCookie", "static_call");
  edge(db, "app", "handler", "import");
}

function buildTestApp(db: Db, repoRoot: string) {
  const paths = hayvenPathsFor(repoRoot);
  return buildApp({
    db,
    config: DEFAULT_CONFIG,
    paths,
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

function freshRepo(): string {
  return mkdtempSync(join(tmpdir(), "hayven-ctxroute-"));
}

async function get(app: ReturnType<typeof buildApp>, path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

describe("context route (HTTP)", () => {
  it("GET /api/context/:symbol returns a pack with header + target + neighbor slices", async () => {
    const repoRoot = freshRepo();
    const db = new Db(":memory:");
    seed(db, repoRoot);
    const app = buildTestApp(db, repoRoot);

    const { status, body } = await get(app, "/api/context/handler");
    expect(status).toBe(200);
    expect(body.symbol).toBe("handler");
    expect(Array.isArray(body.slices)).toBe(true);

    const roles = (body.slices as Array<{ role: string }>).map((s) => s.role);
    expect(roles).toContain("header");
    expect(roles).toContain("target");
    expect(roles).toContain("neighbor");

    // The target slice carries the real handler body text, line-exact.
    const target = (body.slices as Array<{ role: string; text: string; id: string }>).find(
      (s) => s.role === "target",
    );
    expect(target?.id).toBe("handler");
    expect(target?.text).toContain("export function handler");

    // The callee neighbor is the cross-file parseCookie body.
    const neighbor = (
      body.slices as Array<{ role: string; id: string; via?: string; text: string }>
    ).find((s) => s.role === "neighbor" && s.id === "cookie/parseCookie");
    expect(neighbor).toBeDefined();
    expect(neighbor?.via).toBe("call");
    expect(neighbor?.text).toContain("export function parseCookie");

    expect(body.lineCount).toBeGreaterThan(0);
    expect(body.estTokens).toBeGreaterThan(0);
  });

  it("GET /api/context/:symbol?neighbors=false drops neighbor slices", async () => {
    const repoRoot = freshRepo();
    const db = new Db(":memory:");
    seed(db, repoRoot);
    const app = buildTestApp(db, repoRoot);

    const { status, body } = await get(app, "/api/context/handler?neighbors=false");
    expect(status).toBe(200);
    const roles = (body.slices as Array<{ role: string }>).map((s) => s.role);
    expect(roles).toContain("target");
    expect(roles).not.toContain("neighbor");
  });

  it("GET /api/context honors maxNeighbors=0 (target + header only)", async () => {
    const repoRoot = freshRepo();
    const db = new Db(":memory:");
    seed(db, repoRoot);
    const app = buildTestApp(db, repoRoot);

    const { status, body } = await get(app, "/api/context/handler?maxNeighbors=0");
    expect(status).toBe(200);
    const neighbors = (body.slices as Array<{ role: string }>).filter(
      (s) => s.role === "neighbor",
    );
    expect(neighbors.length).toBe(0);
  });

  it("GET /api/context/:symbol resolves a slash-containing id (raw and encoded)", async () => {
    const repoRoot = freshRepo();
    const db = new Db(":memory:");
    seed(db, repoRoot);
    const app = buildTestApp(db, repoRoot);

    // Raw slashes via the wildcard tail.
    const raw = await get(app, "/api/context/cookie/parseCookie");
    expect(raw.status).toBe(200);
    expect(raw.body.symbol).toBe("cookie/parseCookie");

    // URL-encoded slash via the single :symbol segment.
    const enc = await get(app, "/api/context/cookie%2FparseCookie");
    expect(enc.status).toBe(200);
    expect(enc.body.symbol).toBe("cookie/parseCookie");
  });

  it("GET /api/context/:symbol 404s with a helpful body for an unknown symbol", async () => {
    const repoRoot = freshRepo();
    const db = new Db(":memory:");
    seed(db, repoRoot);
    const app = buildTestApp(db, repoRoot);

    const { status, body } = await get(app, "/api/context/does/not/exist");
    expect(status).toBe(404);
    expect(body.error).toBeDefined();
    expect(body.hint).toBeDefined();
  });

  it("GET /api/context?task=… returns { task, resolved, packs }", async () => {
    const repoRoot = freshRepo();
    const db = new Db(":memory:");
    seed(db, repoRoot);
    const app = buildTestApp(db, repoRoot);

    const { status, body } = await get(app, "/api/context?task=parseCookie&top=2");
    expect(status).toBe(200);
    expect(body.task).toBe("parseCookie");
    expect(Array.isArray(body.resolved)).toBe(true);
    expect(Array.isArray(body.packs)).toBe(true);
    // The FTS resolver should surface the parseCookie entity for this task.
    expect(body.resolved).toContain("cookie/parseCookie");
    // Each pack carries slices for its symbol.
    const pack = (body.packs as Array<{ symbol: string; slices: unknown[] }>).find(
      (p) => p.symbol === "cookie/parseCookie",
    );
    expect(pack).toBeDefined();
    expect((pack?.slices.length ?? 0)).toBeGreaterThan(0);
  });

  it("GET /api/context without a task 400s", async () => {
    const repoRoot = freshRepo();
    const db = new Db(":memory:");
    seed(db, repoRoot);
    const app = buildTestApp(db, repoRoot);

    const { status, body } = await get(app, "/api/context");
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });
});
