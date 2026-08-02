/**
 * `hayven doctor` must notice a BROKEN index.
 *
 * Every pre-existing check probed the ENVIRONMENT — bun version, native binary,
 * FTS5 — and nothing looked at the index itself, so `doctor` gave a clean bill
 * of health on an index with zero nodes. That is the exact state an interrupted
 * ingest leaves behind, and the state in which every query answers "No matches"
 * while the user reads that as a fact about their code. `doctor` is where
 * someone looks when results seem wrong, so it is where this has to surface.
 *
 * The row is deliberately NON-GATING: the suite envelope's `ok` means "is this
 * TOOL usable", and peers treat `ok:false` as "hayven is absent" (SUITE_CONTRACTS
 * §3). A corrupt index is a project problem, so it surfaces as a failed ROW with
 * an actionable detail while the envelope stays healthy — the same treatment the
 * tier3_model check already gets.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectForTest } from "../src/cli/doctor.ts";
import { migrate } from "../src/db/migrations.ts";
import { Db } from "../src/db/queries.ts";

let home: string;
let repo: string;
let priorHome: string | undefined;
let priorCwd: string;

beforeEach(() => {
  priorHome = process.env["HAYVEN_HOME"];
  priorCwd = process.cwd();
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-doctor-")));
  process.env["HAYVEN_HOME"] = home;
  repo = join(home, "repo");
  mkdirSync(join(repo, ".hayven"), { recursive: true });
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(priorCwd);
  if (priorHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = priorHome;
  rmSync(home, { recursive: true, force: true });
});

/** Seed the legacy index with `n` nodes and a matching success watermark. */
function seedIndex(n: number): Db {
  const db = new Db(join(repo, ".hayven", "index.sqlite"));
  migrate(db.handle);
  for (let i = 0; i < n; i++) {
    db.upsertNode({
      id: `f.ts::n${i}`,
      name: `n${i}`,
      qualified_name: `n${i}`,
      kind: "function",
      language: "typescript",
      file: "f.ts",
      range: [1, 1],
      ast_hash: "h",
      summary: null,
      last_seen: Date.now(),
      logical_clock: 1,
      last_modified_by: null,
    } as never);
  }
  db.setStat("last_ingest_at", String(Date.now()));
  db.setStat("last_ingest_nodes", String(n));
  return db;
}

function integrityRow(): { ok: boolean; detail: string; gating: boolean } {
  const row = collectForTest().checks.find((c) => c.name === "index_integrity");
  if (!row) throw new Error("doctor emitted no index_integrity check");
  return row;
}

describe("doctor index_integrity", () => {
  it("reports a healthy index as ok, with its node count", () => {
    seedIndex(3).close();
    const row = integrityRow();
    expect(row.ok).toBe(true);
    expect(row.detail).toContain("3 nodes");
  });

  it("FAILS on an index wiped by an interrupted ingest", () => {
    // The regression: this is what an ingest killed after `clearGraph()` leaves.
    const db = seedIndex(3);
    db.clearGraph(); // marker stamped atomically; no completing ingest follows
    db.close();

    const row = integrityRow();
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/hayven ingest --full/); // actionable, not just a complaint
  });

  it("stays NON-GATING so the suite envelope never reads as 'hayven is absent'", () => {
    const db = seedIndex(3);
    db.clearGraph();
    db.close();

    const report = collectForTest();
    expect(report.checks.find((c) => c.name === "index_integrity")?.ok).toBe(false);
    expect(report.ok).toBe(true); // SUITE_CONTRACTS §3
  });

  it("is quiet, not broken, when there is no index yet", () => {
    const row = integrityRow();
    expect(row.ok).toBe(true);
    expect(row.detail).toMatch(/no index yet/i);
  });
});
