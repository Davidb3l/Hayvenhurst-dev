import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/db/queries.ts";
import { reresolveAllEdges, runIngest } from "../src/graph/ingest.ts";
import type { NativeRecord } from "../src/native/protocol.ts";
import type { ParseRun } from "../src/native/process.ts";

/**
 * Regression: `reresolveAllEdges` (the BL-10 cross-batch pass) must NEVER
 * re-resolve an `import` edge by NAME.
 *
 * An unresolved import's `?:` payload is a module SPECIFIER (`?:config` from
 * `import ... from "config"` — an npm package), not an entity name. The main
 * resolver only resolves imports through the SpecifierResolver and leaves
 * external specifiers unresolved on purpose: a wrong resolution is worse than
 * an orphan. Before the guard, a repo that imported the npm package `config`
 * AND defined a unique local function `config` had the import edge silently
 * rewired onto the local function by the name-match pass, polluting
 * refs/importers/impact until the next full reingest.
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

// Module node for a file, so the entity-id scheme prefixes the module name
// (same fixture helpers as ingest.test.ts's BL-10 suite).
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

describe("lane A: reresolveAllEdges never name-resolves import edges", () => {
  test("an external `?:config` import stays unresolved while a same-named static_call re-resolves", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-lane-a-import-guard-"));
    const db = new Db(":memory:");
    db.migrate();

    // ─── Step 1: ingest ONLY the importer. It imports the EXTERNAL specifier
    // `config` (an npm package — no module in the index resolves it), so the
    // SpecifierResolver leaves the import edge at `?:config`. The `boot`
    // function also CALLS `config`, which is likewise undefined in this batch,
    // so the call edge is `?:config` too — a deliberate twin, so the assertion
    // below can prove the pass RAN (call fixed) while the import was skipped.
    await runIngest({
      db,
      nodesDir: tmp,
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0-test" },
        moduleRec("src/app/main.ts", "main"),
        fnRec("src/app/main.ts", "boot"),
        {
          type: "edge",
          src_file: "src/app/main.ts",
          src_name: "main", // module-scope import → attributed to the module node
          dst_name: "config", // the npm package specifier, verbatim
          kind: "import",
        },
        {
          type: "edge",
          src_file: "src/app/main.ts",
          src_name: "boot",
          dst_name: "config",
          kind: "static_call",
        },
        { type: "progress", files_done: 1 },
        { type: "done", files_done: 1, nodes: 2, edges: 2, elapsed_ms: 1 },
      ]),
    });

    const importerId = "src/app/main"; // the module node's entity id
    const bootId = "src/app/main/boot";
    expect(db.outgoing(importerId).map((e) => e.dst)).toEqual(["?:config"]);
    expect(db.outgoing(bootId).map((e) => e.dst)).toEqual(["?:config"]);

    // ─── Step 2: incremental batch ingests a DIFFERENT file that defines a
    // unique local function named `config`. This is the collision fixture: the
    // repo now contains exactly one non-module entity whose name matches the
    // import's specifier payload.
    await runIngest({
      db,
      nodesDir: tmp,
      run: fakeRun([
        { type: "start", files_total: 1, version: "0.0.0-test" },
        moduleRec("src/app/config.ts", "config"),
        fnRec("src/app/config.ts", "config"),
        { type: "progress", files_done: 1 },
        { type: "done", files_done: 1, nodes: 2, edges: 0, elapsed_ms: 1 },
      ]),
    });

    const localConfigId = "src/app/config/config";
    expect(db.getNode(localConfigId)?.name).toBe("config");

    // ─── Step 3: the cross-batch pass. Exactly ONE rewrite is licensed: the
    // static_call `?:config` (an entity NAME, unambiguous). The import's
    // `?:config` is a SPECIFIER and must be skipped.
    const fixed = reresolveAllEdges(db);
    expect(fixed).toBe(1);

    // The import edge still points at the unresolved sentinel...
    const importEdges = db.outgoing(importerId).filter((e) => e.kind === "import");
    expect(importEdges.map((e) => e.dst)).toEqual(["?:config"]);
    // ...and NO import edge was rewired onto the local function.
    expect(
      db.outgoing(importerId).some((e) => e.kind === "import" && e.dst === localConfigId),
    ).toBe(false);
    // The twin static_call DID re-resolve — proof the pass executed and the
    // import survival above is the guard, not a dead pass.
    expect(db.outgoing(bootId).map((e) => e.dst)).toEqual([localConfigId]);

    // Idempotence: nothing left for a second pass, and the import is still
    // honest after it.
    expect(reresolveAllEdges(db)).toBe(0);
    expect(db.outgoing(importerId).map((e) => e.dst)).toEqual(["?:config"]);

    db.close();
  });
});
