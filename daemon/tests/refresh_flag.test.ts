/**
 * `--refresh` gate (CLAUDE.md item (2) optional follow-up).
 *
 * `refreshIfRequested` performs a BOUNDED incremental ingest before a read, but
 * ONLY when it's both needed and safe. These hermetic tests drive the decision
 * logic with INJECTED seams (probes + a spy ingest runner + a temp probe Db) so
 * no native binary / real ingest is needed.
 *
 * Contract proven:
 *   - stale + NO daemon            → ingest runs exactly once ("ingested").
 *   - fresh                        → NO ingest (true no-op, "fresh").
 *   - daemon owns the project      → NO ingest, skipped/deferred ("daemon").
 *   - missing last_ingest_at       → NO ingest ("no-ingest-info").
 *   - a non-zero ingest            → reported "failed", read still proceeds.
 *   - the ingest is INCREMENTAL    → invoked WITHOUT `--full`, scoped to cwd.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/db/queries.ts";
import { refreshIfRequested, type FreshnessProbes } from "../src/db/freshness.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import type { ParsedArgs } from "../src/cli.ts";
import type { ProjectContext } from "../src/cli/_shared.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway project + on-disk index, optionally seeded with last_ingest_at. */
function makeCtx(lastIngestMs?: number): { ctx: ProjectContext; sqlite: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-refresh-test-"));
  dirs.push(repoRoot);
  const paths = hayvenPathsFor(repoRoot);
  mkdirSync(paths.hayvenDir, { recursive: true });
  const db = new Db(paths.sqliteFile);
  db.migrate();
  if (lastIngestMs !== undefined) db.setStat("last_ingest_at", String(lastIngestMs));
  db.close();
  const ctx: ProjectContext = {
    paths,
    // Minimal config — refresh only reads paths; the cast keeps the test focused.
    config: {} as ProjectContext["config"],
    configSources: [],
  };
  return { ctx, sqlite: paths.sqliteFile };
}

/** Injectable probes with a fixed newest-mtime + daemon-running flag. */
function probes(newestMs: number, daemonRunning = false): FreshnessProbes {
  return {
    newestSourceMtimeMs: () => newestMs,
    daemonRunning: () => daemonRunning,
    // No content-suppression here: these fixtures don't seed last_ingest_git_head,
    // so the git check is never consulted — but the interface requires the member.
    gitSourceContentUnchanged: () => false,
  };
}

/** A read-only probe-Db factory bound to the fixture's sqlite file. */
function openProbeDb(sqlite: string): (paths: ReturnType<typeof hayvenPathsFor>) => Db {
  return () => new Db(sqlite, { readonly: true });
}

const NO_REFRESH_ARGS: ParsedArgs = { positionals: [], flags: {} };

const INGEST = 1_000_000;

describe("refreshIfRequested — decision logic", () => {
  it("stale + NO daemon → runs the ingest exactly once", async () => {
    const { ctx, sqlite } = makeCtx(INGEST);
    let ingestCalls = 0;
    const outcome = await refreshIfRequested(NO_REFRESH_ARGS, ctx, {
      probes: probes(INGEST + 5_000), // newer than ingest → stale
      openProbeDb: openProbeDb(sqlite),
      ingest: async () => {
        ingestCalls++;
        return 0;
      },
    });
    expect(outcome).toBe("ingested");
    expect(ingestCalls).toBe(1);
  });

  it("fresh → NO ingest (true no-op)", async () => {
    const { ctx, sqlite } = makeCtx(INGEST);
    let ingestCalls = 0;
    const outcome = await refreshIfRequested(NO_REFRESH_ARGS, ctx, {
      probes: probes(INGEST - 5_000), // older than ingest → fresh
      openProbeDb: openProbeDb(sqlite),
      ingest: async () => {
        ingestCalls++;
        return 0;
      },
    });
    expect(outcome).toBe("fresh");
    expect(ingestCalls).toBe(0);
  });

  it("daemon owns the project → NO ingest, even when stale (never race the watcher)", async () => {
    const { ctx, sqlite } = makeCtx(INGEST);
    let ingestCalls = 0;
    let probed = 0;
    const outcome = await refreshIfRequested(NO_REFRESH_ARGS, ctx, {
      // daemonRunning true; newestSourceMtimeMs would say STALE if consulted.
      probes: {
        newestSourceMtimeMs: () => {
          probed++;
          return INGEST + 5_000;
        },
        daemonRunning: () => true,
        gitSourceContentUnchanged: () => false,
      },
      openProbeDb: openProbeDb(sqlite),
      ingest: async () => {
        ingestCalls++;
        return 0;
      },
    });
    expect(outcome).toBe("daemon");
    expect(ingestCalls).toBe(0);
    // The daemon guard short-circuits before we ever probe the tree.
    expect(probed).toBe(0);
  });

  it("missing last_ingest_at → NO ingest (never invent a refresh)", async () => {
    const { ctx, sqlite } = makeCtx(/* unseeded */);
    let ingestCalls = 0;
    const outcome = await refreshIfRequested(NO_REFRESH_ARGS, ctx, {
      probes: probes(INGEST + 5_000),
      openProbeDb: openProbeDb(sqlite),
      ingest: async () => {
        ingestCalls++;
        return 0;
      },
    });
    expect(outcome).toBe("no-ingest-info");
    expect(ingestCalls).toBe(0);
  });

  it("a non-zero ingest → reported 'failed', does not throw (read still proceeds)", async () => {
    const { ctx, sqlite } = makeCtx(INGEST);
    const outcome = await refreshIfRequested(NO_REFRESH_ARGS, ctx, {
      probes: probes(INGEST + 5_000),
      openProbeDb: openProbeDb(sqlite),
      ingest: async () => 1, // non-zero
    });
    expect(outcome).toBe("failed");
  });

  it("a refresh-triggered ingest's stdout is redirected OFF stdout (keeps --json pipeable)", async () => {
    const { ctx, sqlite } = makeCtx(INGEST);
    // Capture both streams while the (spy) ingest writes to stdout like the real
    // `runIngest` does. The redirect must keep that off the read command's stdout.
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    let out = "";
    let err = "";
    process.stdout.write = ((c: string | Uint8Array) => {
      out += typeof c === "string" ? c : Buffer.from(c).toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => {
      err += typeof c === "string" ? c : Buffer.from(c).toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      await refreshIfRequested(NO_REFRESH_ARGS, ctx, {
        probes: probes(INGEST + 5_000),
        openProbeDb: openProbeDb(sqlite),
        ingest: async () => {
          // Mimic runIngest: it writes its completion summary to STDOUT.
          process.stdout.write("Ingest complete (0.10s wall)\n");
          return 0;
        },
      });
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    // The ingest summary must NOT have reached stdout (so --json stays clean)…
    expect(out).toBe("");
    // …it lands on stderr instead, alongside the stale note.
    expect(err).toContain("Ingest complete");
    expect(err).toContain("index is stale");
  });

  it("the ingest is INCREMENTAL: invoked WITHOUT --full and scoped to the project cwd", async () => {
    const { ctx, sqlite } = makeCtx(INGEST);
    let seen: ParsedArgs | null = null;
    await refreshIfRequested(NO_REFRESH_ARGS, ctx, {
      probes: probes(INGEST + 5_000),
      openProbeDb: openProbeDb(sqlite),
      ingest: async (a) => {
        seen = a;
        return 0;
      },
    });
    expect(seen).not.toBeNull();
    const args = seen as unknown as ParsedArgs;
    // No `--full` → incremental (the same path `hayven ingest` uses without it).
    expect(args.flags["full"]).toBeUndefined();
    // No path positional → whole-repo idempotent re-parse.
    expect(args.positionals).toEqual([]);
    // Scoped to THIS project via --cwd (runIngest resolves the project from it).
    expect(args.flags["cwd"]).toBe(ctx.paths.repoRoot);
  });
});
