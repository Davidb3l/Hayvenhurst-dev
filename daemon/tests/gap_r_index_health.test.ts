/**
 * LANE R / R1 — ONE decision function for "is this index usable?".
 *
 * The question used to be answered in three places that disagreed:
 * `Db.checkIndexIntegrity` (queries.ts), `hasSeedableContent` (branch_index.ts,
 * an admitted mirror) and `hasIngestMarker` (migrations.ts). They diverged on
 * every degenerate marker value and on the empty-graph case — and the
 * empty-graph disagreement is what let an earlier bug land as `ok:true`.
 *
 * These tests pin the SPECIFIC mechanisms, not just "some failure field is set":
 *   - a present-but-unparseable marker reads as IN PROGRESS (fail closed), and
 *     is still ADOPTABLE so it can never wedge an index permanently;
 *   - `""`/`"[]"` mean "no ingest in flight" on BOTH the health path and the
 *     seed path (the old mirror refused to seed from a perfectly healthy index);
 *   - an empty-but-structurally-fine index is READABLE and NOT SEEDABLE, and
 *     that difference is a documented derivation of one integrity result rather
 *     than two independent opinions.
 *
 * Hermetic: every index is its own `mkdtemp` file; `$HAYVEN_HOME` is sandboxed
 * (never `$HOME` — Bun resolves `os.homedir()` once per process, so mutating
 * `$HOME` at runtime would silently hit the developer's real `~/.hayven`).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { resolveWriteIndexForKey } from "../src/db/branch_index.ts";
import {
  INGEST_IN_PROGRESS_KEY,
  isSeedableIndex,
  parseInFlight,
  readIndexIntegrity,
} from "../src/db/index_health.ts";
import { Db } from "../src/db/queries.ts";
import type { GraphNode } from "../src/graph/types.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { DEFAULT_CONFIG, type HayvenConfig } from "../src/config/defaults.ts";

const dirs: string[] = [];

const HAYVEN_HOME_SANDBOX = mkdtempSync(join(tmpdir(), "hayven-gapr-home-"));
process.env["HAYVEN_HOME"] = HAYVEN_HOME_SANDBOX;

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `hayven-${prefix}-`));
  dirs.push(d);
  return d;
}

/** A throwaway project root with its `.hayven/` directory already created. */
function makeRepo(prefix: string): { repoRoot: string; paths: ReturnType<typeof hayvenPathsFor> } {
  const repoRoot = tmp(prefix);
  const paths = hayvenPathsFor(repoRoot);
  mkdirSync(paths.hayvenDir, { recursive: true });
  return { repoRoot, paths };
}

function gNode(id: string): GraphNode {
  return {
    id,
    name: id,
    qualified_name: id,
    kind: "function",
    language: "typescript",
    file: "src/a.ts",
    range: [1, 2],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  };
}

/** A populated, healthy index: one node and a matching watermark. */
function makePopulated(): { db: Db; path: string } {
  const root = tmp("gapr-idx");
  const path = join(root, "index.sqlite");
  const db = new Db(path);
  db.migrate();
  db.upsertNodes([gNode("a/one")]);
  db.setStat("last_ingest_at", "10000000");
  db.recordNodeWatermark(db.counts().nodes, true);
  return { db, path };
}

/* ------------------------------------------------------------------ */
/* the marker GRAMMAR — the states the three copies disagreed on        */
/* ------------------------------------------------------------------ */

describe("R1: one marker grammar, fail-closed on anything unparseable", () => {
  it('treats "0", a negative scalar and non-numeric junk as IN PROGRESS, not absent', () => {
    // The old `ingestInProgressSince` read all three as ABSENT (`Number("0")` is
    // not > 0; JSON.parse throws on junk), which DISARMED the interrupted-ingest
    // detector on exactly the index most likely to be half-written. The row is
    // only ever written by an ingest declaring itself in flight, and it is
    // DELETED — never blanked — on retraction, so a value we cannot read means
    // "someone declared something we don't understand".
    for (const raw of ["0", "-1", "not-json-at-all", "{}", "[{}]"]) {
      const entries = parseInFlight(raw);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]!.t).toBe("malformed");
      expect(entries[0]!.at).toBe(0); // start time is unknowable, not 1970
    }
  });

  it('treats absent, "" and "[]" as NO ingest in flight', () => {
    for (const raw of [null, undefined, "", "  ", "[]"]) {
      expect(parseInFlight(raw)).toEqual([]);
    }
  });

  it("reports an unparseable marker as ingest-interrupted WITHOUT claiming a 1970 start", () => {
    const { db } = makePopulated();
    db.setStat(INGEST_IN_PROGRESS_KEY, "0");

    expect(db.ingestInProgressSince()).toBe(0); // in flight, start unknown
    const integrity = db.checkIndexIntegrity();
    expect(integrity.ok).toBe(false);
    expect(integrity.reason).toBe("ingest-interrupted");
    // The MECHANISM, not just "some failure": no fabricated timestamp.
    expect(integrity.detail).toContain("cannot parse");
    expect(integrity.detail).not.toContain("1970");
    db.close();
  });

  it("ADOPTS an unparseable marker so it can never wedge the index permanently", () => {
    // Fail-closed must not mean unrecoverable: `beginIngest` re-keys a marker it
    // did not write to its own token, and `endIngest` then retracts it.
    const { db, path } = makePopulated();
    db.setStat(INGEST_IN_PROGRESS_KEY, "garbage-from-a-future-build");
    db.close();

    const next = new Db(path);
    expect(next.checkIndexIntegrity().reason).toBe("ingest-interrupted");
    next.beginIngest(5_000);
    expect(next.ingestInProgressSince()).toBe(5_000); // ours now, with OUR start
    next.endIngest();
    expect(next.ingestInProgressSince()).toBeNull();
    expect(next.checkIndexIntegrity().ok).toBe(true);
    next.close();
  });

  it("REAPS a real token whose owning process is provably gone, on clearGraph", async () => {
    // The wedge this closes: `endIngest` retracts only the CALLING handle's
    // token and `reindex` deliberately PRESERVES the marker key, so a token left
    // behind by a SIGKILLed ingest belonged to nobody and could be retracted by
    // nothing. No number of successful rebuilds cleared it; the only recovery
    // was deleting index.sqlite. `clearGraph` is the one safe place to reap it —
    // it is wiping the very graph that dead ingest half-wrote.
    const { db } = makePopulated();
    const dead = Bun.spawn(["true"]);
    const deadPid = dead.pid;
    await dead.exited; // this pid is now gone

    db.setStat(INGEST_IN_PROGRESS_KEY, JSON.stringify([{ t: `${deadPid}:abc:def`, at: 1_000 }]));
    expect(db.checkIndexIntegrity().reason).toBe("ingest-interrupted");

    // A normal full rebuild: clear, repopulate, succeed.
    db.clearGraph();
    db.upsertNodes([gNode("a/one")]);
    db.endIngest();
    expect(db.ingestInProgressSince()).toBeNull();
    expect(db.checkIndexIntegrity().ok).toBe(true);
    db.close();
  });

  it("PRESERVES a token whose process is still alive, or whose owner is UNKNOWABLE", () => {
    // The other half: reaping must not become a clear-all, or a rebuild in this
    // process would silently un-flag a genuinely in-flight ingest elsewhere.
    // Two must-survive shapes — an alive pid (`process.pid`, alive by
    // definition), and a token carrying no pid at all, where "is the owner
    // dead?" is unanswerable and the fail-closed answer is "assume alive".
    for (const token of [`${process.pid}:zzz:zzz`, "some-foreign-token-with-no-pid"]) {
      const { db } = makePopulated();
      db.setStat(INGEST_IN_PROGRESS_KEY, JSON.stringify([{ t: token, at: 2_000 }]));

      db.clearGraph();
      db.upsertNodes([gNode("a/one")]);
      db.endIngest();

      expect(db.ingestInProgressSince()).toBe(2_000); // the other ingest's flag stands
      expect(db.checkIndexIntegrity().reason).toBe("ingest-interrupted");
      db.close();
    }
  });

  it("clearGraph also adopts (rather than preserves) an unparseable marker", () => {
    // `clearGraph` filters the in-flight list too. If it KEPT the sentinel, the
    // success path's `endIngest` — which retracts only this handle's token —
    // would leave the index flagged broken after a perfectly good rebuild.
    const { db } = makePopulated();
    db.setStat(INGEST_IN_PROGRESS_KEY, "0");
    db.clearGraph();
    db.upsertNodes([gNode("a/one")]);
    db.endIngest();
    expect(db.ingestInProgressSince()).toBeNull();
    db.close();
  });
});

/* ------------------------------------------------------------------ */
/* the SEED path reads the same decision                               */
/* ------------------------------------------------------------------ */

describe("R1: seeding derives from the same integrity result", () => {
  const config: HayvenConfig = { ...DEFAULT_CONFIG };

  /** Seed a NEW branch key from whatever candidates exist; returns the source
   *  path the resolver chose, or null when it refused to seed. */
  function seedFrom(repoRoot: string): string | null {
    const paths = hayvenPathsFor(repoRoot);
    return resolveWriteIndexForKey(paths, config, `branch-${Math.random().toString(36).slice(2)}`, {
      seed: true,
    }).seededFrom;
  }

  it('SEEDS from an index whose marker row is an empty token list ("[]")', () => {
    // The old mirror rejected ANY existing `ingest_in_progress` row, so a
    // healthy index that merely still had an emptied marker row forced the new
    // branch into a needless full re-parse. `"[]"` means no ingest is in flight;
    // both readers must now say so.
    const { repoRoot, paths } = makeRepo("gapr-seed-ok");
    const legacy = new Db(paths.sqliteFile);
    legacy.migrate();
    legacy.upsertNodes([gNode("a/one")]);
    legacy.recordNodeWatermark(1, true);
    legacy.setStat(INGEST_IN_PROGRESS_KEY, "[]");
    legacy.close();

    const handle = new Database(paths.sqliteFile, { readonly: true });
    const integrity = readIndexIntegrity(handle);
    handle.close();
    expect(integrity.ok).toBe(true); // the health path says healthy...
    expect(seedFrom(repoRoot)).toBe(paths.sqliteFile); // ...so the seed path must too
  });

  it("REFUSES to seed from an index an unparseable marker flags as interrupted", () => {
    const { repoRoot, paths } = makeRepo("gapr-seed-bad");
    const legacy = new Db(paths.sqliteFile);
    legacy.migrate();
    legacy.upsertNodes([gNode("a/one")]);
    legacy.recordNodeWatermark(1, true);
    legacy.setStat(INGEST_IN_PROGRESS_KEY, "0"); // the state the two copies split on
    legacy.close();

    const handle = new Database(paths.sqliteFile, { readonly: true });
    expect(readIndexIntegrity(handle).reason).toBe("ingest-interrupted");
    handle.close();
    expect(seedFrom(repoRoot)).toBeNull();
  });

  it("an EMPTY graph is readable-but-not-seedable, by derivation from one result", () => {
    // THE disagreement that let a bug land as ok:true. An index with 0 nodes and
    // no watermark is structurally fine to READ (nothing is corrupt) and useless
    // to COPY (seeding propagates emptiness AND the seed's git head, which puts
    // the new branch on the incremental path forever). Both answers now come
    // from ONE integrity result.
    const { repoRoot, paths } = makeRepo("gapr-seed-empty");
    const legacy = new Db(paths.sqliteFile);
    legacy.migrate();
    legacy.close();

    const handle = new Database(paths.sqliteFile, { readonly: true });
    const integrity = readIndexIntegrity(handle);
    handle.close();
    expect(integrity.ok).toBe(true);
    expect(integrity.nodes).toBe(0);
    expect(isSeedableIndex(integrity)).toBe(false);
    expect(seedFrom(repoRoot)).toBeNull();
  });

  it("refuses to seed an index READ as empty even when the stats read then failed", () => {
    // `unreadable` covers two different situations: `nodes` itself was
    // unreadable (a genuine "cannot tell"), and `nodes` read fine as 0 but the
    // `stats` read failed. Checking `unreadable` first would seed from the
    // second — a KNOWN-empty index, the exact thing this predicate refuses.
    const { repoRoot, paths } = makeRepo("gapr-seed-nostats");
    const raw = new Database(paths.sqliteFile);
    raw.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY)"); // readable, and empty
    raw.close(); // ...but no `stats` table at all

    const handle = new Database(paths.sqliteFile, { readonly: true });
    const integrity = readIndexIntegrity(handle);
    handle.close();
    expect(integrity.reason).toBe("unreadable");
    expect(integrity.nodes).toBe(0); // positively read, and empty
    expect(isSeedableIndex(integrity)).toBe(false);
    expect(seedFrom(repoRoot)).toBeNull();
  });

  it("still seeds from a NON-hayven / unreadable file (cannot tell → unchanged)", () => {
    // The narrow asymmetry seeding needs, and the reason it cannot simply be
    // `integrity.ok`: `unreadable` must preserve the seed-it-anyway behaviour
    // the legacy fallback relies on.
    const { repoRoot, paths } = makeRepo("gapr-seed-foreign");
    const foreign = new Database(paths.sqliteFile);
    foreign.exec("CREATE TABLE unrelated (x INTEGER)");
    foreign.close();

    const handle = new Database(paths.sqliteFile, { readonly: true });
    const integrity = readIndexIntegrity(handle);
    handle.close();
    expect(integrity.reason).toBe("unreadable");
    expect(isSeedableIndex(integrity)).toBe(true);
    expect(seedFrom(repoRoot)).toBe(paths.sqliteFile);
  });
});

/* ------------------------------------------------------------------ */
/* tripwire                                                            */
/* ------------------------------------------------------------------ */

describe("R1 tripwire", () => {
  it("never wrote to a real ~/.hayven", () => {
    expect(existsSync(join(HAYVEN_HOME_SANDBOX))).toBe(true);
    expect(process.env["HAYVEN_HOME"]).toBe(HAYVEN_HOME_SANDBOX);
  });
});
