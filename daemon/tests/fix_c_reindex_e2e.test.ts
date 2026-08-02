/**
 * END-TO-END coverage for `runReindex` itself (`daemon/src/cli/reindex.ts`).
 *
 * WHY THIS FILE EXISTS: the first version of this lane tested `dropDerived`
 * against a raw `bun:sqlite` handle and never imported `cli/reindex.ts` at all.
 * A reviewer reverted `reindex.ts` IN FULL to the baseline — the version that
 * calls `dropAll()`, destroys fleet memory, and unlinks the WAL sidecars — and
 * the suite still returned 9 pass / 0 fail. The command the whole lane exists to
 * fix had zero coverage. Everything here drives `runReindex` through its real
 * entry point.
 *
 * The follow-on `--full` ingest is injected (`deps.ingest`) so these tests
 * exercise the destructive half without shelling out to the native parser; the
 * stub also lets us simulate the ingest FAILING, which is the crash case.
 *
 * SANDBOXING: `$HAYVEN_HOME` (never `$HOME` — Bun resolves `os.homedir()` once
 * per process, so mutating HOME at runtime does nothing and the test would read
 * and rewrite the developer's real `~/.hayven`). Fixture projects live under the
 * OS temp dir. Nothing here binds a port or talks to a daemon.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { runReindex } from "../src/cli/reindex.ts";
import { Db } from "../src/db/queries.ts";
import { hayvenHomeDir } from "../src/util/paths.ts";

let home: string;
let project: string;
let indexPath: string;
let savedHayvenHome: string | undefined;

/** A minimal but REAL project: `.hayven/` plus a migrated index. */
function makeProject(): void {
  project = mkdtempSync(join(tmpdir(), "hayven-e2e-proj-"));
  mkdirSync(join(project, ".hayven"), { recursive: true });
  writeFileSync(join(project, ".hayven", "config.json"), "{}\n");
  indexPath = join(project, ".hayven", "index.sqlite");
}

function seedIndex(): void {
  const db = new Db(indexPath);
  db.migrate();
  db.handle.exec(`
    INSERT INTO nodes (id, name, qualified_name, kind, language, file)
      VALUES ('n1','authHandler','auth.authHandler','function','ts','src/auth.ts'),
             ('n2','login','auth.login','function','ts','src/auth.ts');
    INSERT INTO edges (src, dst, kind, weight) VALUES ('n1','n2','calls',3);
    INSERT INTO fleet_memory (id, agent, node_id, kind, note, created)
      VALUES ('m1','agent-a','n1','decision','we rejected the retry loop here',1),
             ('m2','agent-b',NULL,'gotcha','the parser chokes on BOM files',2);
    INSERT INTO observations (src,dst,ts,observed,weight,source) VALUES ('n1','n2',1,1,5,'trace');
    INSERT INTO test_coverage (test,entity,weight,source) VALUES ('t:auth','auth.login',1,'trace');
    INSERT INTO claims (id,agent,scope_json,fingerprint,intent,created,ttl)
      VALUES ('c1','agent-a','["n1"]','fp','edit',1,600);
  `);
  // A prior SUCCESSFUL ingest: both freshness and the integrity watermark.
  db.setStat("last_ingest_at", String(Date.now()));
  db.recordNodeWatermark(2, true);
  db.close();
}

/** Stand-in for a successful `--full` ingest: repopulate and stamp like the real one. */
async function fakeSuccessfulIngest(): Promise<number> {
  const db = new Db(indexPath);
  db.migrate();
  db.handle.exec(
    "INSERT INTO nodes (id,name,qualified_name,kind) VALUES ('n1','authHandler','auth.authHandler','function')",
  );
  db.setStat("last_ingest_at", String(Date.now()));
  db.recordNodeWatermark(db.counts().nodes, true);
  db.endIngest(); // retracts ITS OWN token only — reindex must retract its own
  db.close();
  return 0;
}

beforeEach(() => {
  savedHayvenHome = process.env["HAYVEN_HOME"];
  home = mkdtempSync(join(tmpdir(), "hayven-e2e-home-"));
  process.env["HAYVEN_HOME"] = home;
  // TRIPWIRE (see registry.test.ts): if the sandbox is not in force we would be
  // reading and rewriting the developer's real global state. Refuse to run.
  expect(hayvenHomeDir()).toBe(home);
  expect(hayvenHomeDir().startsWith(homedir())).toBe(false);
  makeProject();
  seedIndex();
});

afterEach(() => {
  if (savedHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = savedHayvenHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function openIndex(): Db {
  return new Db(indexPath, { readonly: true });
}

describe("runReindex: non-rebuildable data survives a REAL reindex", () => {
  it("keeps fleet memory, observations, claims and test coverage", async () => {
    const code = await runReindex(
      { positionals: [], flags: {} },
      { cwd: project, ingest: fakeSuccessfulIngest },
    );
    expect(code).toBe(0);

    const db = openIndex();
    const n = (t: string) =>
      db.handle.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${t}"`).get()?.n ?? -1;
    // The baseline `dropAll` left every one of these at 0.
    expect(n("fleet_memory")).toBe(2);
    expect(n("fleet_memory_fts")).toBe(2);
    expect(n("observations")).toBe(1);
    expect(n("claims")).toBe(1);
    expect(n("test_coverage")).toBe(1);
    expect(
      db.handle.query<{ note: string }, []>("SELECT note FROM fleet_memory ORDER BY id").all()
        .map((r) => r.note),
    ).toEqual(["we rejected the retry loop here", "the parser chokes on BOM files"]);
    db.close();
  });

  it("still clears the derived graph (a reindex that preserved everything would be useless)", async () => {
    let sawNodes = -1;
    await runReindex(
      { positionals: [], flags: {} },
      {
        cwd: project,
        // Observe the index at the moment the ingest would start: graph gone.
        ingest: async () => {
          const db = new Db(indexPath, { readonly: true });
          sawNodes = db.handle.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM nodes").get()?.n ?? -1;
          db.close();
          return fakeSuccessfulIngest();
        },
      },
    );
    expect(sawNodes).toBe(0);
  });

  it("leaves the index HEALTHY after a successful reindex", async () => {
    await runReindex(
      { positionals: [], flags: {} },
      { cwd: project, ingest: fakeSuccessfulIngest },
    );
    const db = openIndex();
    const integrity = db.checkIndexIntegrity();
    db.close();
    // Both reindex's token AND the ingest's token must be retracted, or a
    // successful rebuild would leave the index wedged as permanently broken.
    expect(integrity.inProgressSince).toBeNull();
    expect(integrity.ok).toBe(true);
    expect(integrity.reason).toBe("ok");
  });
});

describe("runReindex: an INTERRUPTED reindex must not certify itself healthy", () => {
  /** The crash: reindex clears the graph, then the ingest never completes. */
  async function crashedIngest(): Promise<number> {
    throw new Error("native parser died (simulated OOM)");
  }

  it("marks the index BROKEN when the rebuild throws", async () => {
    await expect(
      runReindex({ positionals: [], flags: {} }, { cwd: project, ingest: crashedIngest }),
    ).rejects.toThrow("native parser died");

    const db = openIndex();
    const integrity = db.checkIndexIntegrity();
    const nodes = db.handle.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM nodes").get()?.n;
    db.close();

    expect(nodes).toBe(0);
    // The reviewer's probe on the broken build read:
    //   {"ok":true,"reason":"ok","nodes":0,"claimedNodes":-1,"inProgressSince":null}
    expect(integrity.ok).toBe(false);
    expect(integrity.inProgressSince).not.toBeNull();
  });

  it("marks the index BROKEN when the rebuild exits non-zero", async () => {
    const code = await runReindex(
      { positionals: [], flags: {} },
      { cwd: project, ingest: async () => 3 },
    );
    expect(code).toBe(3);

    const db = openIndex();
    const integrity = db.checkIndexIntegrity();
    db.close();
    expect(integrity.ok).toBe(false);
    // BOTH detectors are armed. `checkIndexIntegrity` reports the watermark one
    // first because it does not depend on the marker having survived; assert the
    // marker independently so this stays honest if that precedence ever changes.
    expect(integrity.reason).toBe("empty-but-claims-content");
    expect(integrity.claimedNodes).toBe(2);
    expect(integrity.inProgressSince).not.toBeNull();
  });

  it("preserves the node WATERMARK so the second detector fires independently", async () => {
    // Even if the in-progress marker were somehow lost, `nodes === 0` while
    // `last_ingest_nodes` says 2 is unambiguous corruption. `dropAll` destroyed
    // this detector along with the marker; the targeted stats DELETE keeps it.
    await runReindex({ positionals: [], flags: {} }, { cwd: project, ingest: async () => 3 });

    const db = new Db(indexPath);
    db.endIngest(); // no-op: this handle owns no token, so the marker stands
    db.handle.query("DELETE FROM stats WHERE key = 'ingest_in_progress'").run(); // simulate marker loss
    const integrity = db.checkIndexIntegrity();
    db.close();

    expect(integrity.claimedNodes).toBe(2);
    expect(integrity.nodes).toBe(0);
    expect(integrity.ok).toBe(false);
    expect(integrity.reason).toBe("empty-but-claims-content");
  });

  it("clears `last_ingest_at`, so staleness cannot report a wiped index as fresh", async () => {
    await runReindex({ positionals: [], flags: {} }, { cwd: project, ingest: async () => 3 });
    const db = openIndex();
    const at = db.getStat("last_ingest_at");
    db.close();
    // Surviving `last_ingest_at` is what made `evaluateStaleness` answer
    // {"stale":false} over a zero-node graph.
    expect(at).toBeNull();
  });
});

describe("runReindex: WAL handling", () => {
  it("checkpoints instead of unlinking the sidecars, and data survives reopen", async () => {
    await runReindex(
      { positionals: [], flags: {} },
      { cwd: project, ingest: fakeSuccessfulIngest },
    );
    // The baseline `rmSync`'d these. Unlinking a WAL that still holds committed
    // pages is data loss now that fleet memory survives in this file.
    if (existsSync(indexPath + "-wal")) {
      expect(statSync(indexPath + "-wal").size).toBeLessThan(1024 * 1024);
    }
    const db = openIndex();
    expect(
      db.handle.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fleet_memory").get()?.n,
    ).toBe(2);
    db.close();
  });
});
