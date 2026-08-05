import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/db/queries.ts";
import { runIngest } from "../src/graph/ingest.ts";
import type { NativeRecord } from "../src/native/protocol.ts";
import type { ParseRun } from "../src/native/process.ts";
import type { Logger } from "../src/util/log.ts";

/**
 * Lane G: the module-record-ORDERING fallback (ARCHITECTURE.md §2).
 *
 * The native binary guarantees a file's `module` record arrives before any
 * other record from that file. When a payload violates that (an older binary, a
 * foreign producer, a truncated replay), the documented contract is: log a
 * warning and fall back to the FILE STEM as the module segment. Before this
 * fix, the code did neither: the id was silently derived WITHOUT the module
 * segment, which reintroduces exactly the sibling-file collision the segment
 * exists to prevent: `src/x/a.ts` and `src/x/b.ts` each defining `doThing`
 * both derived `src/x/doThing`, and ids are the `nodes` PRIMARY KEY, so one
 * definition vanished from the graph without a trace.
 */

function fakeRun(records: NativeRecord[]): ParseRun {
  async function* iter(): AsyncIterable<NativeRecord> {
    for (const r of records) yield r;
  }
  return {
    records: iter(),
    wait: async () => 0,
    kill: async () => undefined,
    recentStderr: () => [],
  };
}

function fnRec(file: string, name: string): NativeRecord {
  return {
    type: "node",
    file,
    name,
    qualified_name: name,
    kind: "function",
    language: "typescript",
    range: [1, 5],
    ast_hash: `fn-${file}-${name}`,
  };
}

function moduleRec(file: string, name: string): NativeRecord {
  return {
    type: "node",
    file,
    name,
    qualified_name: name,
    kind: "module",
    language: "typescript",
    range: [0, 0],
    ast_hash: `mod-${file}`,
  };
}

/** Test logger that records `warn` calls so the once-per-ingest latch is
 *  observable. Everything else is a no-op. */
function captureLogger(warns: Array<{ msg: string; fields?: Record<string, unknown> }>): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, fields) => {
      warns.push({ msg, ...(fields ? { fields } : {}) });
    },
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

const ORDERING_WARN = /ORDERING violation/;

describe("lane G: module-record ordering fallback", () => {
  test("sibling files with same-named functions and NO module records get DISTINCT ids, with exactly one warning per ingest", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-lane-g-fallback-"));
    const db = new Db(":memory:");
    db.migrate();
    const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];

    // TWO module-less files, each defining `doThing`, the exact collision the
    // module segment exists to prevent. No module record anywhere in the run.
    await runIngest({
      db,
      nodesDir: tmp,
      logger: captureLogger(warns),
      run: fakeRun([
        { type: "start", files_total: 2, version: "0.0.0-test" },
        fnRec("src/x/a.ts", "doThing"),
        fnRec("src/x/b.ts", "doThing"),
        { type: "progress", files_done: 2 },
        { type: "done", files_done: 2, nodes: 2, edges: 0, elapsed_ms: 1 },
      ]),
    });

    // The stem fallback produces the SAME shape a real module record would:
    // `src/x/a.ts` yields module segment `a`, so `src/x/a/doThing`.
    const aId = "src/x/a/doThing";
    const bId = "src/x/b/doThing";
    expect(db.getNode(aId)?.name).toBe("doThing");
    expect(db.getNode(bId)?.name).toBe("doThing");
    expect(aId).not.toBe(bId);
    // The segment-less collision id must NOT exist; neither file lost.
    expect(db.getNode("src/x/doThing")).toBeNull();

    // EXACTLY one ordering warning, even though the violation occurred for two
    // files (the latch is per-ingest, not per-record).
    const orderingWarns = warns.filter((w) => ORDERING_WARN.test(w.msg));
    expect(orderingWarns.length).toBe(1);

    // A SECOND ingest with the same violation warns again: the latch resets
    // per run, so a persistently-misbehaving producer stays visible in the log.
    await runIngest({
      db,
      nodesDir: tmp,
      logger: captureLogger(warns),
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0-test" },
        fnRec("src/x/c.ts", "doThing"),
        { type: "progress", files_done: 1 },
        { type: "done", files_done: 1, nodes: 1, edges: 0, elapsed_ms: 1 },
      ]),
    });
    expect(warns.filter((w) => ORDERING_WARN.test(w.msg)).length).toBe(2);
    expect(db.getNode("src/x/c/doThing")?.name).toBe("doThing");

    db.close();
  });

  test("the fallback id is byte-identical to the id a well-ordered module record derives", async () => {
    // Same file, same function: once module-less (fallback), once with the
    // module record first (the guaranteed ordering). The ids must agree, or
    // the graph forks on producer behavior.
    const tmpA = mkdtempSync(join(tmpdir(), "hayven-lane-g-parity-a-"));
    const dbA = new Db(":memory:");
    dbA.migrate();
    await runIngest({
      db: dbA,
      nodesDir: tmpA,
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0-test" },
        fnRec("src/auth/login.ts", "loginHandler"),
        { type: "done", files_done: 1, nodes: 1, edges: 0, elapsed_ms: 1 },
      ]),
    });

    const tmpB = mkdtempSync(join(tmpdir(), "hayven-lane-g-parity-b-"));
    const dbB = new Db(":memory:");
    dbB.migrate();
    await runIngest({
      db: dbB,
      nodesDir: tmpB,
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0-test" },
        moduleRec("src/auth/login.ts", "login"),
        fnRec("src/auth/login.ts", "loginHandler"),
        { type: "done", files_done: 1, nodes: 2, edges: 0, elapsed_ms: 1 },
      ]),
    });

    const expected = "src/auth/login/loginHandler";
    expect(dbA.getNode(expected)?.name).toBe("loginHandler");
    expect(dbB.getNode(expected)?.name).toBe("loginHandler");
    dbA.close();
    dbB.close();
  });

  test("parent-directory module files (mod.rs) fall back to the directory name, matching the real module segment", async () => {
    // ARCHITECTURE.md §2's per-language table: `mod.rs` takes its module name
    // from the PARENT DIRECTORY. A real module record for `src/y/mod.rs`
    // carries qn `y` (module id `src/y/y`), so the fallback must produce the
    // segment `y` too (`src/y/y/alpha`), not the stem `mod`.
    const tmp = mkdtempSync(join(tmpdir(), "hayven-lane-g-modrs-"));
    const db = new Db(":memory:");
    db.migrate();
    await runIngest({
      db,
      nodesDir: tmp,
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0-test" },
        {
          type: "node",
          file: "src/y/mod.rs",
          name: "alpha",
          qualified_name: "alpha",
          kind: "function",
          language: "rust",
          range: [1, 5],
          ast_hash: "fn-modrs-alpha",
        },
        { type: "done", files_done: 1, nodes: 1, edges: 0, elapsed_ms: 1 },
      ]),
    });
    expect(db.getNode("src/y/y/alpha")?.name).toBe("alpha");
    expect(db.getNode("src/y/mod/alpha")).toBeNull();
    db.close();
  });
});
