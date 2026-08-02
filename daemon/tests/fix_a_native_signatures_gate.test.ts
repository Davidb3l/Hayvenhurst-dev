/**
 * Round 2 — `conflict/native_signatures.ts`'s body reader was the same ungated
 * pattern that let the MCP surface read `/etc/passwd`:
 *
 *   const abs = join(repoRoot, rel);
 *   if (existsSync(abs)) txt = readFileSync(abs, "utf8");
 *
 * `rel` comes off a graph row, and `dbEntityResolver` is HTTP-reachable
 * (`db/impact_preview.ts` → `routes/impact_preview.ts`) as well as reachable
 * from `conflict/oracle.ts`. Today it is safe ONLY because the Rust producer
 * canonicalizes paths and does not follow symlinks — i.e. the guarantee lives
 * in another language, in another crate, held by a lane that does not know it
 * is load-bearing here. That is defence-in-depth worth having in TypeScript.
 *
 * These tests write the hostile `file` value DIRECTLY into the node row, which
 * is exactly the state a producer bug (or a future non-Rust producer) would
 * leave behind — so they test THIS gate rather than the Rust invariant.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbEntityResolver } from "../src/conflict/native_signatures.ts";
import { Db } from "../src/db/queries.ts";
import type { NodeKind } from "../src/graph/types.ts";

const SECRET = "CANARY-NATIVE-SIG-SECRET";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repo, a sibling out-of-tree secret, and an in-repo `.env`. */
function makeSandbox(): { root: string } {
  const sandbox = mkdtempSync(join(tmpdir(), "hayven-fixa-nsig-"));
  dirs.push(sandbox);
  const root = join(sandbox, "repo");
  const outside = join(sandbox, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(
    join(root, "src", "a.ts"),
    "export function fa(): number {\n  return 1;\n}\n",
  );
  writeFileSync(join(outside, "secret.txt"), `${SECRET}\nmore\n`);
  writeFileSync(join(root, ".env"), `TOKEN=${SECRET}\n`);
  symlinkSync(join(outside, "secret.txt"), join(root, "src", "linked.ts"));
  return { root };
}

/** Seed one node whose `file` is whatever we say — the producer-bug state. */
function seed(file: string, range: [number, number] = [1, 3]): Db {
  const db = new Db(":memory:");
  db.migrate();
  db.upsertNode({
    id: "n1",
    name: "fa",
    qualified_name: "n1",
    kind: "function" as NodeKind,
    language: "typescript",
    file,
    range,
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
  return db;
}

function bodyFor(root: string, file: string): string {
  const db = seed(file);
  const resolved = dbEntityResolver(db, root).resolve("n1");
  const body = resolved?.body ?? "";
  db.close();
  return body;
}

describe("round 2 — dbEntityResolver refuses what the packer refuses", () => {
  it("does not read an out-of-repo absolute path", () => {
    const { root } = makeSandbox();
    expect(bodyFor(root, "/etc/hosts")).toBe("");
  });

  it("does not read a `..` escape to a real secret", () => {
    const { root } = makeSandbox();
    expect(bodyFor(root, "../outside/secret.txt")).not.toContain(SECRET);
    expect(bodyFor(root, "../outside/secret.txt")).toBe("");
  });

  it("does not follow an in-repo symlink pointing outside", () => {
    const { root } = makeSandbox();
    expect(bodyFor(root, "src/linked.ts")).not.toContain(SECRET);
  });

  it("does not read an in-repo credential file", () => {
    const { root } = makeSandbox();
    expect(bodyFor(root, ".env")).not.toContain(SECRET);
  });

  it("still resolves a legitimate in-repo source body", () => {
    // The negative control: over-blocking here silently degrades every
    // contract-diff signature to the empty-body fallback.
    const { root } = makeSandbox();
    expect(bodyFor(root, "src/a.ts")).toContain("function fa");
  });
});
