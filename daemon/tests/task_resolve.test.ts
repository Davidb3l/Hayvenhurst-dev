/**
 * `resolveTaskToSymbols` — the embedding-free fuzzy task → symbol entry to the
 * context packer (`daemon/src/db/task_resolve.ts`).
 *
 * Seeds a small in-memory Db with distinct names + summaries so the EXISTING
 * FTS (`searchFts`) has real content to rank, then asserts:
 *   - a natural-language task phrase resolves to the relevant symbol id(s);
 *   - `module` nodes are excluded (their body is the whole file — the opposite
 *     of a precise pack);
 *   - gibberish resolves to `[]`;
 *   - results are deduped, rank-ordered, and capped at `limit`.
 *
 * Self-contained: the schema's FTS triggers populate `nodes_fts` automatically
 * on `upsertNode` after `migrate()`, so no manual FTS seeding is needed.
 */
import { describe, expect, it } from "bun:test";

import { Db } from "../src/db/queries.ts";
import type { GraphNode, NodeKind } from "../src/graph/types.ts";
import { resolveTaskToSymbols } from "../src/db/task_resolve.ts";

function node(
  db: Db,
  id: string,
  opts: { name?: string; kind?: NodeKind; summary?: string; file?: string } = {},
) {
  const name = opts.name ?? (id.split("/").pop() ?? id);
  const n: GraphNode = {
    id,
    name,
    qualified_name: id,
    kind: opts.kind ?? "function",
    language: "typescript",
    file: opts.file ?? `${id}.ts`,
    range: [1, 20],
    ast_hash: "h",
    summary: opts.summary,
    last_seen: 0,
    logical_clock: 0,
  };
  db.upsertNode(n);
}

/**
 * Seed a few entities with distinct names + summaries so FTS can discriminate by
 * a natural-language task, plus a `module` node that shares a task keyword (so we
 * can prove module nodes are filtered out even when they rank).
 */
function seed(db: Db): void {
  db.migrate();
  node(db, "auth/loginHandler", {
    name: "loginHandler",
    summary: "Authenticates a user and issues a session token on login.",
  });
  node(db, "auth/logout", {
    name: "logout",
    summary: "Clears the session and signs the user out.",
  });
  node(db, "sync/mergePeers", {
    name: "mergePeers",
    summary: "Converges two peer replicas after a network partition heals.",
  });
  node(db, "math/addNumbers", {
    name: "addNumbers",
    summary: "Adds two integers together and returns the sum.",
  });
  // A MODULE node that also matches "session" — must be excluded from results.
  node(db, "auth/session", {
    name: "session",
    kind: "module",
    summary: "Session module: token storage and the login session lifecycle.",
    file: "auth/session.ts",
  });
}

describe("resolveTaskToSymbols", () => {
  it("resolves a natural-language task to the relevant entity symbol(s)", () => {
    const db = new Db(":memory:");
    seed(db);
    const ids = resolveTaskToSymbols(db, "authenticate a user on login", 3);
    expect(ids).toContain("auth/loginHandler");
    // The unrelated arithmetic helper must not be the top answer.
    expect(ids).not.toContain("math/addNumbers");
  });

  it("resolves a partition-recovery task to the converge-peers symbol", () => {
    const db = new Db(":memory:");
    seed(db);
    const ids = resolveTaskToSymbols(
      db,
      "how does the daemon converge peers after a partition",
      3,
    );
    expect(ids).toContain("sync/mergePeers");
  });

  it("excludes module nodes even when they match the task", () => {
    const db = new Db(":memory:");
    seed(db);
    const ids = resolveTaskToSymbols(db, "session login token", 5);
    // The `auth/session` MODULE matches the keywords but must be filtered out.
    expect(ids).not.toContain("auth/session");
    // The entity-kind login handler also matches and IS a valid candidate.
    expect(ids).toContain("auth/loginHandler");
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(db.getNode(id)?.kind).not.toBe("module");
    }
  });

  it("returns [] for gibberish that matches nothing", () => {
    const db = new Db(":memory:");
    seed(db);
    expect(resolveTaskToSymbols(db, "zzqxwvk qqxzzwq", 3)).toEqual([]);
  });

  it("returns [] for empty / whitespace task text", () => {
    const db = new Db(":memory:");
    seed(db);
    expect(resolveTaskToSymbols(db, "")).toEqual([]);
    expect(resolveTaskToSymbols(db, "   ")).toEqual([]);
  });

  it("caps the result at `limit` and dedupes", () => {
    const db = new Db(":memory:");
    seed(db);
    // "session" / "login" / "user" appear across multiple entities; cap to 1.
    const ids = resolveTaskToSymbols(db, "session login user token", 1);
    expect(ids.length).toBeLessThanOrEqual(1);
    // No duplicate ids ever.
    const all = resolveTaskToSymbols(db, "session login user token", 5);
    expect(new Set(all).size).toBe(all.length);
  });

  it("returns [] when limit is 0", () => {
    const db = new Db(":memory:");
    seed(db);
    expect(resolveTaskToSymbols(db, "login user", 0)).toEqual([]);
  });
});
