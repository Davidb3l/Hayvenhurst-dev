// Tests for `hayven traces <id>` (daemon/src/cli/traces.ts).
//
// `traces` opens the project's SQLite index read-only (like `query`/`neighbors`)
// and aggregates the `observations` table per node: observed callers are rows
// where `dst = id`, observed callees are rows where `src = id`. We seed a tiny
// observation fixture on disk and assert the human + --json output reflects
// exactly what was recorded (and the empty case + unknown-id + missing-id).
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { runTraces } from "../src/cli/traces.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import type { GraphNode } from "../src/graph/types.ts";

function node(id: string): GraphNode {
  return {
    id,
    name: id.split("/").pop() ?? id,
    qualified_name: id,
    kind: "function",
    language: "python",
    file: `${id}.py`,
    range: [1, 2],
    ast_hash: "deadbeef",
    last_seen: 1,
    logical_clock: 1,
  };
}

/**
 * A temp project rooted at a real `.hayven/` dir with an on-disk SQLite index
 * (NOT `:memory:` — the CLI re-opens the file at `paths.sqliteFile`). Returns
 * the repo root plus a handle to seed fixtures, then closes the seed handle so
 * the CLI's read-only open sees the committed rows.
 */
function makeProjectWith(seed: (db: Db) => void): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-traces-"));
  mkdirSync(join(repoRoot, ".hayven"), { recursive: true });
  writeFileSync(join(repoRoot, ".hayven", "config.json"), JSON.stringify(DEFAULT_CONFIG));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(paths.sqliteFile);
  db.migrate();
  seed(db);
  db.close();
  return repoRoot;
}

async function captureIo(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: string) => {
    out.push(typeof s === "string" ? s : String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: string) => {
    err.push(typeof s === "string" ? s : String(s));
    return true;
  };
  try {
    const code = await fn();
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe("runTraces CLI", () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  it("missing id → usage on stderr, exit 2", async () => {
    const { code, err } = await captureIo(() => runTraces({ positionals: [], flags: {} }));
    expect(code).toBe(2);
    expect(err).toContain("usage: hayven traces <id>");
  });

  it("unknown id → friendly message, exit 1", async () => {
    const repoRoot = makeProjectWith((db) => {
      db.upsertNode(node("a/known"));
    });
    process.chdir(repoRoot);
    const { code, err } = await captureIo(() => runTraces({ positionals: ["a/missing"], flags: {} }));
    expect(code).toBe(1);
    expect(err).toContain("No node with id `a/missing`");
  });

  it("reports observed callers and callees with summed invocation counts", async () => {
    // sample_rate 100. `target` is called by `caller_a` (3 samples → 300) and
    // `caller_b` (1 sample → 100), and itself calls `callee_x` (2 samples → 200).
    const repoRoot = makeProjectWith((db) => {
      for (const id of ["caller_a", "caller_b", "target", "callee_x"]) db.upsertNode(node(id));
      db.insertObservations([
        // callers of `target` (dst = target). Two ts windows from caller_a sum.
        { src: "caller_a", dst: "target", ts: 1000, observed: 2, weight: 200, source: "python" },
        { src: "caller_a", dst: "target", ts: 2000, observed: 1, weight: 100, source: "python" },
        { src: "caller_b", dst: "target", ts: 1000, observed: 1, weight: 100, source: "python" },
        // callees of `target` (src = target).
        { src: "target", dst: "callee_x", ts: 1000, observed: 2, weight: 200, source: "python" },
      ]);
    });
    process.chdir(repoRoot);

    const { code, out } = await captureIo(() => runTraces({ positionals: ["target"], flags: {} }));
    expect(code).toBe(0);
    expect(out).toContain("## Observed callers (from traces)");
    // caller_a: 200 + 100 = 300 invocations; sorted first (descending).
    expect(out).toContain("`caller_a` (300 invocations)");
    expect(out).toContain("`caller_b` (100 invocations)");
    expect(out).toContain("## Observed callees (from traces)");
    expect(out).toContain("`callee_x` (200 invocations)");
    // caller_a (300) must sort before caller_b (100).
    expect(out.indexOf("caller_a")).toBeLessThan(out.indexOf("caller_b"));
  });

  it("--json mirrors the aggregated callers/callees with observed + samples", async () => {
    const repoRoot = makeProjectWith((db) => {
      for (const id of ["caller_a", "target", "callee_x"]) db.upsertNode(node(id));
      db.insertObservations([
        { src: "caller_a", dst: "target", ts: 1000, observed: 2, weight: 200, source: "python" },
        { src: "caller_a", dst: "target", ts: 2000, observed: 1, weight: 100, source: "python" },
        { src: "target", dst: "callee_x", ts: 1000, observed: 5, weight: 500, source: "python" },
      ]);
    });
    process.chdir(repoRoot);

    const { code, out } = await captureIo(() =>
      runTraces({ positionals: ["target"], flags: { json: true } }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      id: string;
      callers: Array<{ id: string; invocations: number; observed: number; samples: number }>;
      callees: Array<{ id: string; invocations: number; observed: number; samples: number }>;
    };
    expect(parsed.id).toBe("target");
    expect(parsed.callers).toEqual([
      { id: "caller_a", invocations: 300, observed: 3, samples: 2 },
    ]);
    expect(parsed.callees).toEqual([
      { id: "callee_x", invocations: 500, observed: 5, samples: 1 },
    ]);
  });

  it("surfaces resolved trace edges where the runtime name differs from the id", async () => {
    // `auth/login/loginHandler` is the entity id; the tracer recorded a RUNTIME
    // name `myapp.auth:loginHandler` calling `myapp.auth:Session.refresh`. The
    // raw caller/callee aggregation (keyed on id) misses these, but the resolved
    // section maps them back to the entities.
    const repoRoot = makeProjectWith((db) => {
      db.upsertNode({ ...node("auth/login/loginHandler"), name: "loginHandler", qualified_name: "loginHandler" });
      db.upsertNode({ ...node("auth/session/Session.refresh"), name: "refresh", qualified_name: "Session.refresh" });
      db.insertObservations([
        {
          src: "myapp.auth:loginHandler",
          dst: "myapp.auth:Session.refresh",
          ts: 1000,
          observed: 4,
          weight: 400,
          source: "python",
        },
      ]);
    });
    process.chdir(repoRoot);

    // From loginHandler's view, the callee resolved to Session.refresh.
    const { code, out } = await captureIo(() =>
      runTraces({ positionals: ["auth/login/loginHandler"], flags: { json: true } }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      resolvedCallees: Array<{
        raw: string;
        resolved: string | null;
        invocations: number;
        observed: number;
        samples: number;
      }>;
    };
    expect(parsed.resolvedCallees).toEqual([
      { raw: "myapp.auth:Session.refresh", resolved: "auth/session/Session.refresh", invocations: 400, observed: 4, samples: 1 },
    ]);

    // Human output shows the runtime-name → entity arrow.
    const human = await captureIo(() =>
      runTraces({ positionals: ["auth/login/loginHandler"], flags: {} }),
    );
    expect(human.out).toContain("## Resolved trace edges (runtime name → entity)");
    expect(human.out).toContain("`myapp.auth:Session.refresh` → `auth/session/Session.refresh`");
  });

  it("node with no observations → 'no observations yet', exit 0", async () => {
    const repoRoot = makeProjectWith((db) => {
      db.upsertNode(node("lonely"));
    });
    process.chdir(repoRoot);
    const { code, out } = await captureIo(() => runTraces({ positionals: ["lonely"], flags: {} }));
    expect(code).toBe(0);
    expect(out).toContain("No observations yet");
  });

  it("empty case in --json is two empty arrays", async () => {
    const repoRoot = makeProjectWith((db) => {
      db.upsertNode(node("lonely"));
    });
    process.chdir(repoRoot);
    const { code, out } = await captureIo(() =>
      runTraces({ positionals: ["lonely"], flags: { json: true } }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { callers: unknown[]; callees: unknown[] };
    expect(parsed.callers).toEqual([]);
    expect(parsed.callees).toEqual([]);
  });
});
