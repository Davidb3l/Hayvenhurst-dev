/**
 * GAP S2 — the packer must not be MORE PERMISSIVE than the indexer.
 *
 * The credential denylist enumerates named SHAPES (`.env*`, `.git/`, `id_rsa*`,
 * `.pem`, …). Its own docblock admitted the hole: a file whose name nobody
 * enumerated — a stray `dump.sql`, a `backup.json`, a `secrets.yaml.bak` — was
 * still readable if the caller named it exactly, even though the Rust walker
 * (which honours `.gitignore`, prunes hidden paths and build directories, and
 * only opens files of a language it can parse) would never have touched it. The
 * packer reads the RAW file whether or not it is indexed, and that read feeds a
 * model prompt, so the packer was strictly more permissive than the indexer on
 * the one path where that matters most.
 *
 * The class fix is `isIndexerAdmissible`: hidden components, always-pruned build
 * directories, and any extension the indexer cannot parse are refused. These
 * tests drive `resolveWithinRepo` and `buildContextPackForChange` DIRECTLY — NOT
 * through the MCP wire, which rejects absolute paths and containment failures of
 * its own and would short-circuit the guard under test.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildContextPackForChange,
  isPackableFile,
  resolveWithinRepo,
} from "../src/db/context_pack.ts";
import { Db } from "../src/db/queries.ts";
import type { NodeKind } from "../src/graph/types.ts";

const CANARY = "CANARY-GAP-S2-PAYLOAD";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const A_TS = `import { x } from "./x";

export function fa(): number {
  return 1;
}
`;

/** A repo where only `src/a.ts` is indexed, surrounded by data files whose names
 *  are NOT on any credential denylist — the exact residual class. */
function makeRepo(): { root: string; db: Db } {
  const root = mkdtempSync(join(tmpdir(), "hayven-gap-s2-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, ".config"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), A_TS);

  // The S2 residual class: ordinary-looking names, real payloads.
  writeFileSync(join(root, "dump.sql"), `INSERT INTO t VALUES ('${CANARY}');\n`);
  writeFileSync(join(root, "backup.json"), `{"token":"${CANARY}"}\n`);
  writeFileSync(join(root, "secrets.yaml.bak"), `password: ${CANARY}\n`);
  writeFileSync(join(root, "prod.db.sqlite"), `sqlite ${CANARY}\n`);
  writeFileSync(join(root, "notes.txt"), `${CANARY}\n`);
  writeFileSync(join(root, "src", "credentials.csv"), `user,pass\nroot,${CANARY}\n`);
  writeFileSync(join(root, "Dockerfile"), `ENV TOKEN=${CANARY}\n`); // no extension at all
  // Extensionless files whose WHOLE NAME is a language extension. Without the
  // explicit "must have a dot" guard, `basename.slice(-1 + 1)` hands the whole
  // name to the extension set and `ts` / `go` sail through.
  writeFileSync(join(root, "ts"), `${CANARY}\n`);
  writeFileSync(join(root, "src", "go"), `${CANARY}\n`);
  // Hidden path with a SOURCE extension — the walker's `hidden(true)` prunes it.
  writeFileSync(join(root, ".config", "local.ts"), `export const k = "${CANARY}";\n`);
  // Build output with a source extension — `ALWAYS_SKIP_DIRS` prunes it.
  writeFileSync(join(root, "dist", "bundle.js"), `var k = "${CANARY}";\n`);
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), `var k = "${CANARY}";\n`);

  const db = new Db(":memory:");
  db.migrate();
  db.upsertNode({
    id: "src/a.ts::fa",
    name: "fa",
    qualified_name: "src/a.ts::fa",
    kind: "function" as NodeKind,
    language: "typescript",
    file: "src/a.ts",
    range: [3, 5],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
  return { root, db };
}

/** Every path the indexer would never open, in the spellings a client can send. */
const NON_SOURCE: string[] = [
  "dump.sql",
  "./dump.sql",
  "src/../dump.sql",
  "backup.json",
  "secrets.yaml.bak",
  "prod.db.sqlite",
  "notes.txt",
  "src/credentials.csv",
  "Dockerfile",
  "ts",
  "src/go",
  ".config/local.ts",
  "dist/bundle.js",
  "node_modules/pkg/index.js",
];

describe("S2 — indexer parity closes the un-enumerated data-file class", () => {
  it("resolveWithinRepo refuses every one of them", () => {
    const { root, db } = makeRepo();
    for (const rel of NON_SOURCE) {
      expect(resolveWithinRepo(root, rel)).toBeNull();
    }
    db.close();
  });

  it("the packer returns nothing for them, and no canary escapes", () => {
    const { root, db } = makeRepo();
    for (const rel of NON_SOURCE) {
      const pack = buildContextPackForChange(db, root, rel, [
        { startLine: 1, endLine: 100 },
      ]);
      // Grep the WHOLE serialized pack, not just the return shape.
      expect(JSON.stringify(pack)).not.toContain(CANARY);
      expect(pack).toBeNull();
    }
    db.close();
  });

  it("an ABSOLUTE spelling of a non-source in-repo file is refused too", () => {
    const { root, db } = makeRepo();
    expect(resolveWithinRepo(root, join(root, "dump.sql"))).toBeNull();
    expect(resolveWithinRepo(root, join(root, "dist", "bundle.js"))).toBeNull();
    db.close();
  });

  it("does NOT over-block: real source still resolves and still packs", () => {
    // The negative control. The gate is about what the indexer WOULD admit, not
    // about what it has already seen — a brand-new, not-yet-indexed source file
    // is the case `context_for_change` exists to serve, and must survive.
    const { root, db } = makeRepo();
    expect(resolveWithinRepo(root, "src/a.ts")).not.toBeNull();

    writeFileSync(join(root, "src", "brand-new.ts"), "export const x = 1;\n");
    expect(resolveWithinRepo(root, "src/brand-new.ts")).not.toBeNull();
    expect(
      buildContextPackForChange(db, root, "src/brand-new.ts", [
        { startLine: 1, endLine: 1 },
      ]),
    ).not.toBeNull();

    // Every language the Rust walker parses, including the multi-extension
    // TypeScript/JavaScript spellings that a naive `.ts`-only rule would drop.
    for (const ok of [
      "src/m.py",
      "src/m.ts",
      "src/m.cts",
      "src/m.mts",
      "src/m.tsx",
      "src/m.js",
      "src/m.mjs",
      "src/m.cjs",
      "src/m.jsx",
      "src/m.rs",
      "src/m.go",
      "src/m.astro",
      "src/types.d.ts",
      "src/environment.ts",
      "src/vendor/dep.ts", // conditional walker prune — must NOT be mirrored
      "test/fixtures/app/index.ts", // conditional walker prune — must NOT be mirrored
    ]) {
      mkdirSync(join(root, ok, ".."), { recursive: true });
      writeFileSync(join(root, ok), "x = 1\n");
      expect(resolveWithinRepo(root, ok)).not.toBeNull();
    }
    db.close();
  });

  it("mirrors the walker's CASE-SENSITIVE directory prune, so `Build/` still packs", () => {
    // `walker.rs::is_skipped_dir` is `ALWAYS_SKIP_DIRS.contains(&name)` with no
    // case folding, so a repo whose source lives in `Build/` or `Dist/` IS
    // indexed. Lowercasing the mirror here refused to pack nodes the index
    // contains — over-blocking, the one thing a parity mirror must never do.
    // A DEDICATED root: the shared fixture already creates lowercase `dist/` and
    // `node_modules/`, and on a case-INSENSITIVE filesystem (macOS default)
    // `mkdir Dist` lands in the existing `dist` and `realpathSync` hands back
    // the on-disk casing — so the differently-cased names must not collide with
    // anything the fixture made, or the test measures the filesystem instead of
    // the predicate.
    const root = mkdtempSync(join(tmpdir(), "hayven-gap-s2-case-"));
    dirs.push(root);
    for (const ok of ["Build/x.ts", "Dist/y.ts", "Target/z.go", "Venv/v.py"]) {
      mkdirSync(join(root, ok, ".."), { recursive: true });
      writeFileSync(join(root, ok), "x = 1\n");
      expect({ path: ok, resolved: resolveWithinRepo(root, ok) !== null }).toEqual({
        path: ok,
        resolved: true,
      });
    }
    // …while the exact lowercase names the walker prunes stay refused.
    const { root: fixtureRoot, db } = makeRepo();
    for (const no of ["dist/bundle.js", "node_modules/pkg/index.js"]) {
      expect(resolveWithinRepo(fixtureRoot, no)).toBeNull();
    }
    db.close();
  });

  it("case does not launder a non-source extension", () => {
    const { root, db } = makeRepo();
    writeFileSync(join(root, "src", "DUMP.SQL"), `-- ${CANARY}\n`);
    expect(resolveWithinRepo(root, "src/DUMP.SQL")).toBeNull();
    // …and an upper-cased SOURCE extension is still source.
    writeFileSync(join(root, "src", "Mod.TS"), "export const y = 1;\n");
    expect(resolveWithinRepo(root, "src/Mod.TS")).not.toBeNull();
    db.close();
  });
});

describe("S6 — the file-TYPE guard, pinned directly", () => {
  // The previous round's "a directory named as a file is refused" test could not
  // fail: it drove `buildContextPackForChange`, where `readFileSync` on a
  // directory throws EISDIR on its own, so deleting `statPackable`'s `isFile()`
  // check changed nothing observable. Pin the predicate itself instead — and now
  // there is a SECOND validating layer above it (indexer parity refuses `src`
  // for having no extension), which would short-circuit any end-to-end probe.
  it("isPackableFile rejects a directory and accepts a regular file", () => {
    const { root, db } = makeRepo();
    expect(isPackableFile(join(root, "src"))).toBe(false);
    expect(isPackableFile(root)).toBe(false);
    expect(isPackableFile(join(root, "src", "a.ts"))).toBe(true);
    db.close();
  });

  it("the packer still refuses a directory end-to-end", () => {
    const { root, db } = makeRepo();
    expect(
      buildContextPackForChange(db, root, "src", [{ startLine: 1, endLine: 10 }]),
    ).toBeNull();
    db.close();
  });
});
