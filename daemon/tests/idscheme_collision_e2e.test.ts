// KNOWN_ISSUES #1, END-TO-END through the real CLI ingest + native parser.
//
// A repo holding BOTH `a/b.ts` and `a/src/b.ts` used to lose one of them: the
// old `scopeForFile` elided the first `src/` segment, so both files derived the
// module id `a/b`, and ids are the `nodes` PRIMARY KEY. Measured on exactly this
// fixture before the fix, the graph held 4 nodes for 6 real symbols —
// `a/b.ts`'s module node AND its `helper` were both overwritten by
// `a/src/b.ts`'s, and the surviving `a/b` module was left apparently containing
// `onlyTop`, a function from the OTHER file.
//
// Binary-gated like the other native-backed suites: skipped when no
// hayven-native is available.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { branchKey, branchSqlitePath } from "../src/db/branch_index.ts";
import { Db } from "../src/db/queries.ts";
import { registryFile } from "../src/daemon/registry.ts";
import { runInit } from "../src/cli/init.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  const here = import.meta.dir;
  for (const c of [
    join(here, "../../native/target/release/hayven-native"),
    join(here, "../../native/target/debug/hayven-native"),
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}
const bin = findBinary();
const maybe = bin === null ? describe.skip : describe;

function git(repo: string, args: string[]): void {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

maybe("KNOWN_ISSUES #1 — `a/src/b.ts` vs `a/b.ts` (E2E, native binary)", () => {
  let repo: string;
  let sandboxHome: string;
  let priorHayvenHome: string | undefined;
  let priorPort: string | undefined;

  /** A port nothing listens on, so `runInit`'s best-effort hot-add cannot reach
   *  the developer's REAL daemon and register a temp repo in their registry. */
  const DEAD_PORT = "7914";

  beforeEach(() => {
    if (bin) process.env["HAYVEN_NATIVE_BIN"] = bin;
    priorHayvenHome = process.env["HAYVEN_HOME"];
    priorPort = process.env["HAYVEN_PORT"];
    sandboxHome = mkdtempSync(join(tmpdir(), "hayven-idscheme-home-"));
    process.env["HAYVEN_HOME"] = sandboxHome;
    process.env["HAYVEN_PORT"] = DEAD_PORT;
    // Tripwire: a silent registry leak becomes a loud failure.
    if (!registryFile().startsWith(sandboxHome)) {
      throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${sandboxHome}`);
    }

    repo = mkdtempSync(join(tmpdir(), "hayven-idscheme-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    mkdirSync(join(repo, "a/src"), { recursive: true });
    // Same basename, same symbol name, different files. `helper` is the one the
    // old scheme lost outright; `onlyTop`/`onlySrc` prove each file still
    // contributes its own symbols under its own module.
    writeFileSync(
      join(repo, "a/b.ts"),
      'export function helper() {\n  return "top";\n}\nexport function onlyTop() {\n  return 1;\n}\n',
    );
    writeFileSync(
      join(repo, "a/src/b.ts"),
      'export function helper() {\n  return "src";\n}\nexport function onlySrc() {\n  return 2;\n}\n',
    );
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(sandboxHome, { recursive: true, force: true });
    if (priorHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
    else process.env["HAYVEN_HOME"] = priorHayvenHome;
    if (priorPort === undefined) delete process.env["HAYVEN_PORT"];
    else process.env["HAYVEN_PORT"] = priorPort;
  });

  test("both files survive the ingest with distinct ids", async () => {
    expect(await runInit({ positionals: [], flags: { cwd: repo } })).toBe(0);

    const paths = hayvenPathsFor(repo);
    const db = new Db(branchSqlitePath(paths, branchKey(repo)!), { readonly: true });
    try {
      const rows = db.handle
        .query<{ id: string; name: string; kind: string; file: string }, []>(
          "SELECT id, name, kind, file FROM nodes ORDER BY id",
        )
        .all();

      // Six real symbols: two modules + four functions. The old scheme yielded
      // four rows here.
      expect(rows.length).toBe(6);

      // Each file gets its OWN module node, at its own id.
      const modules = rows.filter((r) => r.kind === "module");
      expect(modules.map((m) => m.id).sort()).toEqual(["a/b", "a/src/b"]);

      // The symbol the old scheme silently erased: BOTH `helper`s are present,
      // at distinct ids, each attributed to the file that actually defines it.
      const helpers = rows.filter((r) => r.name === "helper");
      expect(helpers.length).toBe(2);
      expect(helpers.map((h) => h.id).sort()).toEqual(["a/b/helper", "a/src/b/helper"]);
      expect(helpers.find((h) => h.id === "a/b/helper")?.file).toBe("a/b.ts");
      expect(helpers.find((h) => h.id === "a/src/b/helper")?.file).toBe("a/src/b.ts");

      // No node may be attributed to a file it does not belong to. Under the old
      // scheme `a/b/onlyTop` (from `a/b.ts`) hung off a module node whose file
      // was `a/src/b.ts` — the graph mixed two files' provenance under one id.
      for (const r of rows) {
        const scope = r.id.slice(0, r.id.lastIndexOf("/"));
        expect(r.file.startsWith(scope === "" ? "" : `${scope.replace(/\/[^/]*$/, "")}/`)).toBe(true);
      }

      // Ids are unique by construction now, so the ingest collision detector —
      // which was the mitigation for this bug — must report nothing.
      expect(db.getStat("last_ingest_id_collisions")).toBe("0");
    } finally {
      db.close();
    }
  });
});
