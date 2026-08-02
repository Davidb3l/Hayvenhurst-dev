/**
 * File-read containment on the two readers Lane A could not reach.
 *
 * `context_pack.ts`'s reader was gated (Lane A), but the SAME ungated pattern —
 * `readFileSync(isAbsolute(file) ? file : join(repoRoot, file))` — survived in
 * `db/imported_symbol.ts` and `db/context_escalation.ts`, neither of which any
 * lane owned. Both read a path taken from a graph row, and a SYMLINK inside the
 * repository is enough to make that path point anywhere on disk: a checked-in
 * `env.ts -> /etc/passwd` had its contents returned straight into a context
 * pack. Reachable from `hayven context`, fleet-context and the orchestrator.
 *
 * These tests use a symlink rather than an absolute path because the symlink is
 * the case a lexical-only check would miss — the stored `file` is a perfectly
 * ordinary repo-relative string.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEscalatingContext } from "../src/db/context_escalation.ts";
import { collectImportedSymbols } from "../src/db/imported_symbol.ts";
import { migrate } from "../src/db/migrations.ts";
import { Db } from "../src/db/queries.ts";

/**
 * The canary must be shaped like a MODULE-LEVEL DECLARATION, not like a `.env`
 * line. `collectImportedSymbols` only emits a slice when it can locate a
 * declaration of a candidate identifier, so a fixture containing
 * `AWS_SECRET_ACCESS_KEY=…` produces no slice whether or not the read is gated —
 * i.e. it passes with the fix REVERTED. Mutation testing caught exactly that.
 * A real leaked file is usually a checked-in config module, which does look
 * like this.
 */
const SECRET_DECL = 'export const CREDENTIALS = { key: "hayven-canary-do-not-leak" };';

let base: string;
let repo: string;
let outside: string;
let db: Db;

beforeEach(() => {
  // realpath'd: on macOS `tmpdir()` is a symlink, and the containment check
  // resolves symlinks — an un-realpath'd fixture would compare two spellings of
  // the same dir and make these tests pass for the wrong reason.
  base = realpathSync(mkdtempSync(join(tmpdir(), "hayven-containment-")));
  repo = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(join(repo, ".hayven"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(outside, "secret.ts"), SECRET_DECL + "\n");
  // The attack: an ordinary-looking repo-relative path that leaves the repo.
  symlinkSync(join(outside, "secret.ts"), join(repo, "env.ts"));

  db = new Db(join(repo, ".hayven", "index.sqlite"));
  migrate(db.handle);
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

function node(over: Record<string, unknown>) {
  return {
    id: "x",
    name: "x",
    qualified_name: "x",
    kind: "function",
    language: "typescript",
    file: "a.ts",
    range: [1, 1],
    ast_hash: "h",
    summary: null,
    last_seen: Date.now(),
    logical_clock: 1,
    last_modified_by: null,
    ...over,
  } as never;
}

describe("imported_symbol reader containment", () => {
  it("does not return the contents of a symlink that escapes the repo", () => {
    writeFileSync(join(repo, "a.ts"), "export function useIt(){ return CREDENTIALS.key; }\n");

    // Graph shape `collectImportedSymbols` walks: a.ts's module node imports
    // env.ts's module node, so env.ts becomes a candidate file to scan.
    db.upsertNode(node({ id: "a.ts::mod", name: "a.ts", kind: "module", file: "a.ts" }));
    db.upsertNode(node({ id: "env.ts::mod", name: "env.ts", kind: "module", file: "env.ts" }));
    db.upsertNode(node({ id: "a.ts::useIt", name: "useIt", file: "a.ts" }));
    db.upsertEdges([
      { src: "a.ts::mod", dst: "env.ts::mod", kind: "import", weight: 1, last_seen: Date.now() },
    ] as never);

    const target = db.getNode("a.ts::useIt");
    expect(target).not.toBeNull();

    const slices = collectImportedSymbols(
      db,
      repo,
      target as never,
      "export function useIt(){ return CREDENTIALS.key; }",
      new Set<string>(),
    );

    const blob = JSON.stringify(slices);
    expect(blob).not.toContain("hayven-canary-do-not-leak");
  });
});

describe("context_escalation whole-file rung containment", () => {
  /**
   * HONEST SCOPE — read before trusting this test.
   *
   * The containment check added to `context_escalation.ts` is DEFENCE IN DEPTH,
   * not the load-bearing guard. Mutation testing proved it: reverting that
   * check alone does NOT leak, because `buildContextPack` refuses the escaping
   * file first (Lane A's fix), so the whole-file rung's file list is empty and
   * the escalation reader is never reached with a bad path.
   *
   * It is kept because the two readers resolving paths DIFFERENTLY is exactly
   * how this class of bug appeared in the first place — the original comment in
   * that file said "resolve the path EXACTLY as the packer does", and it stopped
   * being true the moment the packer was hardened. The check keeps them in
   * lockstep so a future change to either cannot silently reopen the hole.
   *
   * So this asserts the LAYERED OUTCOME (no secret reaches a caller), not the
   * individual line. The `imported_symbol` test above IS load-bearing.
   */
  it("does not inline a secret reachable through an escaping symlink", () => {
    writeFileSync(join(repo, "real.ts"), "export function real(){ return 1; }\n");
    db.upsertNode(node({ id: "env.ts::leak", name: "leak", file: "env.ts", range: [1, 1] }));

    const result = buildEscalatingContext(db, repo, "env.ts::leak", { maxRung: "whole-file" });

    expect(JSON.stringify(result)).not.toContain("hayven-canary-do-not-leak");
  });

  it("still reads an ordinary in-repo file", () => {
    // Positive control: if this ever stops passing, the containment check has
    // gone too far and the tests above would pass for the wrong reason.
    writeFileSync(join(repo, "real.ts"), "export function real(){ return 42; }\n");
    db.upsertNode(node({ id: "real.ts::real", name: "real", file: "real.ts", range: [1, 1] }));

    const result = buildEscalatingContext(db, repo, "real.ts::real", { maxRung: "whole-file" });

    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).toContain("42");
  });
});
