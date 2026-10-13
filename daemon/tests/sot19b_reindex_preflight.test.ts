/**
 * SOT-19b: `hayven reindex` must prove the native companion is usable BEFORE it
 * marks the index broken and drops the derived graph. Previously the follow-on
 * ingest was the first thing to look for `hayven-native`, so a missing binary
 * left an empty index marked broken.
 *
 * Same sandboxing as fix_c_reindex_e2e.test.ts: $HAYVEN_HOME in a tmp dir,
 * fixture project under the OS temp dir, no ports, no daemon.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { preflightNativeBinary, runReindex } from "../src/cli/reindex.ts";
import { Db } from "../src/db/queries.ts";

let home: string;
let project: string;
let indexPath: string;
const saved: Record<string, string | undefined> = {};

function setEnv(k: string, v: string): void {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hayven-pf-home-"));
  setEnv("HAYVEN_HOME", home);
  project = mkdtempSync(join(tmpdir(), "hayven-pf-proj-"));
  mkdirSync(join(project, ".hayven"), { recursive: true });
  writeFileSync(join(project, ".hayven", "config.json"), "{}\n");
  indexPath = join(project, ".hayven", "index.sqlite");
  const db = new Db(indexPath);
  db.migrate();
  db.handle.exec(`
    INSERT INTO nodes (id, name, qualified_name, kind, language, file)
      VALUES ('n1','a','m.a','function','ts','src/a.ts'),
             ('n2','b','m.b','function','ts','src/a.ts');
  `);
  db.setStat("last_ingest_at", String(Date.now()));
  db.recordNodeWatermark(2, true);
  db.close();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function nodeCount(): number {
  const db = new Db(indexPath, { readonly: true });
  const n = db.handle.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM nodes").get()?.n ?? -1;
  db.close();
  return n;
}

describe("reindex native preflight (SOT-19b)", () => {
  it("native unavailable (injected) -> error, index untouched, NOT marked broken, ingest never runs", async () => {
    let ingestRan = false;
    const code = await runReindex(
      { positionals: [], flags: {} },
      {
        cwd: project,
        preflightNative: () => "Could not find `hayven-native`.",
        ingest: async () => {
          ingestRan = true;
          return 0;
        },
      },
    );
    expect(code).toBe(1);
    expect(ingestRan).toBe(false);
    expect(nodeCount()).toBe(2);
    const db = new Db(indexPath, { readonly: true });
    const integrity = db.checkIndexIntegrity();
    db.close();
    expect(integrity.ok).toBe(true);
    expect(integrity.inProgressSince).toBeNull();
  });

  it("real preflight with no locatable binary -> error, node count unchanged, index not marked broken", async () => {
    setEnv("HAYVEN_NATIVE_BIN", join(tmpdir(), "definitely-missing-hayven-native"));
    setEnv("PATH", "");
    const code = await runReindex({ positionals: [], flags: {} }, { cwd: project });
    expect(code).toBe(1);
    expect(nodeCount()).toBe(2);
    const db = new Db(indexPath, { readonly: true });
    const integrity = db.checkIndexIntegrity();
    db.close();
    expect(integrity.ok).toBe(true);
    expect(integrity.inProgressSince).toBeNull();
  });

  it("preflightNativeBinary reports a binary that exists but cannot run", () => {
    const bogus = join(project, process.platform === "win32" ? "hayven-native.exe" : "hayven-native");
    writeFileSync(bogus, "not an executable");
    setEnv("HAYVEN_NATIVE_BIN", bogus);
    setEnv("PATH", "");
    const msg = preflightNativeBinary(project);
    expect(msg).not.toBeNull();
    expect(msg).toContain(bogus);
  });

  it("preflightNativeBinary passes for a real, runnable binary", () => {
    const real = Bun.which("hayven-native") ?? null;
    if (real === null) return; // no companion on this machine; covered by the negative cases.
    setEnv("HAYVEN_NATIVE_BIN", real);
    expect(preflightNativeBinary(project)).toBeNull();
  });
});
