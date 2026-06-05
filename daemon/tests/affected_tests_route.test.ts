/**
 * `GET /api/affected-tests` — the trace-augmented test-impact route
 * (daemon/src/daemon/routes/affected_tests.ts).
 *
 * Seeds a synthetic graph around a changed symbol `src/sym`:
 *   - a STATIC test (`testStaticSym` in `tests/static.test.ts`) reaches it via a
 *     static_call edge → must classify `evidence:"static"`;
 *   - a TRACE test (`testTraceSym` in `tests/trace.test.ts`) reaches it via a
 *     resolved runtime observation (insertObservations with bare names) → must
 *     classify `evidence:"trace"`.
 *
 * Then drives the route via `app.handle` and pins the contract: the run list,
 * counts, traceEdgeCount, the trace/static evidence split, `?trace_only`, the
 * `?changed=<file>` file entry point, and the missing-params 400.
 *
 * Mirrors `neighbors_trace.test.ts`'s `mkApp`/`seedNode` helpers verbatim.
 * REMEMBER: `app.handle` is hostname-sensitive — always `http://localhost/...`.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp, type ServerDependencies } from "../src/daemon/server.ts";
import { affectedTestsRoutes } from "../src/daemon/routes/affected_tests.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

interface AffectedTestsResponse {
  symbol?: string;
  changed?: string[];
  roots: string[];
  count: number;
  traceEdgeCount: number;
  note?: string;
  tests: Array<{
    id: string;
    file: string | null;
    evidence: "trace" | "static";
    depth: number;
    weight: number;
    runnable: string | null;
    runner: string;
  }>;
}

/**
 * Build the daemon app and mount the affected-tests route onto it. We compose
 * `affectedTestsRoutes(deps)` here rather than relying on server.ts having wired
 * it: this Lane ships the route file; the integrator registers it in server.ts.
 * Mounting it in the test keeps the test self-contained and green pre-integration
 * (and stays correct after, since the route is identical either way), WITHOUT
 * this Lane editing server.ts. `.use()` registers it before the viewer `/*`
 * catch-all wins, so `/api/affected-tests` resolves.
 */
function mkApp(db: Db) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-affected-tests-"));
  const paths = hayvenPathsFor(repoRoot);
  const deps: ServerDependencies = {
    db,
    config: DEFAULT_CONFIG,
    paths,
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used in this test");
      },
    },
  };
  return buildApp(deps).use(affectedTestsRoutes(deps));
}

/** Index a node whose unambiguous `name`/`qualified_name` the resolver can hit. */
function seedNode(db: Db, id: string, name: string, file: string): void {
  db.upsertNode({
    id,
    name,
    qualified_name: name,
    kind: "function",
    language: "typescript",
    file,
    range: [1, 10],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

/**
 * Build the synthetic graph: the changed symbol, a static-reaching test, a
 * trace-reaching test, and the one resolved trace observation. Returned so each
 * `it` gets a fresh in-memory db.
 */
function seedGraph(): Db {
  const db = new Db(":memory:");
  db.migrate();

  // The changed symbol under test. Bare name `symFn` so a runtime observation's
  // `dst` resolves to it via the bare-name index.
  seedNode(db, "src/sym", "symFn", "src/sym.ts");

  // STATIC test → static_call edge into the symbol. Lives in a test file AND has
  // a test-shaped name, so classifyTest collects it as evidence:"static".
  seedNode(db, "tests/static.test.ts/testStaticSym", "testStaticSym", "tests/static.test.ts");
  db.upsertEdge({
    src: "tests/static.test.ts/testStaticSym",
    dst: "src/sym",
    kind: "static_call",
    weight: 3,
    last_seen: 0,
  });

  // TRACE test → reached ONLY via a resolved runtime observation (no static
  // edge). Bare name `testTraceSym` resolves the observation's `src`.
  seedNode(db, "tests/trace.test.ts/testTraceSym", "testTraceSym", "tests/trace.test.ts");
  db.insertObservations([
    { src: "testTraceSym", dst: "symFn", ts: 1, observed: 7, weight: 7, source: "py" },
  ]);

  return db;
}

async function getAffected(
  app: ReturnType<typeof mkApp>,
  qs: string,
): Promise<{ status: number; body: AffectedTestsResponse }> {
  const res = await app.handle(
    new Request(`http://localhost/api/affected-tests?${qs}`),
  );
  const body = (await res.json()) as AffectedTestsResponse;
  return { status: res.status, body };
}

describe("GET /api/affected-tests", () => {
  it("returns the static + trace tests with correct evidence, count, traceEdgeCount", async () => {
    const app = mkApp(seedGraph());
    const { status, body } = await getAffected(app, "id=src/sym");

    expect(status).toBe(200);
    expect(body.symbol).toBe("src/sym");
    expect(Array.isArray(body.tests)).toBe(true);
    // Both tests reach the symbol.
    expect(body.count).toBe(2);
    expect(body.tests).toHaveLength(2);
    // One resolved trace edge in the project (testTraceSym → symFn).
    expect(body.traceEdgeCount).toBe(1);

    const byId = new Map(body.tests.map((t) => [t.id, t]));
    const trace = byId.get("tests/trace.test.ts/testTraceSym");
    const stat = byId.get("tests/static.test.ts/testStaticSym");
    expect(trace?.evidence).toBe("trace");
    expect(stat?.evidence).toBe("static");

    // Trace is ranked first (ground truth before predicted).
    expect(body.tests[0]?.evidence).toBe("trace");
  });

  it("?trace_only=true returns ONLY the trace-reached test", async () => {
    const app = mkApp(seedGraph());
    const { status, body } = await getAffected(app, "id=src/sym&trace_only=true");

    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.tests).toHaveLength(1);
    expect(body.tests[0]?.id).toBe("tests/trace.test.ts/testTraceSym");
    expect(body.tests[0]?.evidence).toBe("trace");
  });

  it("?changed=<file> returns the same tests via the file entry point", async () => {
    const app = mkApp(seedGraph());
    const { status, body } = await getAffected(app, "changed=src/sym.ts");

    expect(status).toBe(200);
    expect(body.changed).toEqual(["src/sym.ts"]);
    // The file defines `src/sym`, so its entities seed the same reverse-walk.
    expect(body.roots).toContain("src/sym");
    expect(body.count).toBe(2);
    const evidence = body.tests.map((t) => t.evidence).sort();
    expect(evidence).toEqual(["static", "trace"]);
  });

  it("returns 400 when neither id nor changed is provided", async () => {
    const app = mkApp(seedGraph());
    const res = await app.handle(
      new Request("http://localhost/api/affected-tests"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("provide ?id=");
  });
});
