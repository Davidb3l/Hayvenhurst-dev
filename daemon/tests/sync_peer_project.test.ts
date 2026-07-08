/**
 * Peer-side project identity for `hayven sync` — the guard that keeps a sync
 * against a SHARED multi-project peer daemon from exchanging segments with the
 * wrong project (ARCHITECTURE.md §15.5; the local leg is pinned by
 * daemon_serves_register.test.ts / project_header_routing.test.ts):
 *
 *   client (resolvePeerProject):
 *     1. multi-project peer + no --peer-project → hard refusal listing aliases
 *     2. multi-project peer + valid alias → that alias (addressed requests)
 *     3. multi-project peer + unknown alias → hard refusal listing aliases
 *     4. single-project peer → alias auto-selected, no flag needed
 *     5. legacy peer (no `projects` in health) → un-addressed + warning;
 *        but an explicit --peer-project it cannot honor is a hard refusal
 *     6. unreachable/unhealthy peer → tolerated (the merkle fetch reports it),
 *        preserving an explicit alias
 *     7. root-basename mismatch on the chosen alias → warning (not fatal)
 *
 *   server (buildMultiProjectApp): /api/sync/* is STRICT on every method —
 *   an explicit unknown selector 404s even on GET /api/sync/merkle, because a
 *   merkle answer from the primary's tree would diff two different projects.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { computeMerkle } from "../src/crdt/merkle.ts";
import { OpLog } from "../src/crdt/oplog.ts";
import { resolvePeerProject, runSync } from "../src/cli/sync.ts";
import { buildMultiProjectApp, type ServerDependencies } from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { Db } from "../src/db/queries.ts";
import { createLogger } from "../src/util/log.ts";

const PEER = "http://peer.example:7777";

function ctxWithRoot(repoRoot: string): { paths: { repoRoot: string } } {
  return { paths: { repoRoot } };
}

/** Run `fn` with /api/health on the peer stubbed to `health` (or a transport
 *  failure / non-OK status), restoring fetch afterwards. */
async function withPeerHealth(
  health: Record<string, unknown> | { unreachable: true } | { status: number },
  fn: () => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("/api/health")) {
      throw new Error(`unexpected request in peer-health stub: ${url}`);
    }
    if ("unreachable" in health && health.unreachable) {
      throw new Error("connection refused");
    }
    if ("status" in health && typeof health.status === "number" && !("ok" in health)) {
      return new Response("nope", { status: health.status });
    }
    return new Response(JSON.stringify(health), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

const MULTI_HEALTH = {
  ok: true,
  root: "/machines/peer/work/alpha",
  primary: "alpha",
  projects: [
    { alias: "alpha", root: "/machines/peer/work/alpha", branch: null },
    { alias: "beta", root: "/machines/peer/work/beta", branch: null },
  ],
};

describe("resolvePeerProject (client leg)", () => {
  it("refuses a multi-project peer without --peer-project, listing aliases", async () => {
    await withPeerHealth(MULTI_HEALTH, async () => {
      const res = await resolvePeerProject(PEER, undefined, ctxWithRoot("/me/work/alpha"));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.message).toContain("alpha, beta");
        expect(res.message).toContain("--peer-project");
      }
    });
  });

  it("uses a valid --peer-project alias on a multi-project peer", async () => {
    await withPeerHealth(MULTI_HEALTH, async () => {
      const res = await resolvePeerProject(PEER, "beta", ctxWithRoot("/me/work/beta"));
      expect(res).toEqual({ ok: true, alias: "beta" });
    });
  });

  it("refuses an alias the peer does not serve, listing what it does", async () => {
    await withPeerHealth(MULTI_HEALTH, async () => {
      const res = await resolvePeerProject(PEER, "gamma", ctxWithRoot("/me/work/gamma"));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.message).toContain("'gamma'");
        expect(res.message).toContain("alpha, beta");
      }
    });
  });

  it("auto-selects the alias of a single-project peer", async () => {
    await withPeerHealth(
      {
        ok: true,
        primary: "solo",
        projects: [{ alias: "solo", root: "/machines/peer/work/solo", branch: null }],
      },
      async () => {
        const res = await resolvePeerProject(PEER, undefined, ctxWithRoot("/me/work/solo"));
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.alias).toBe("solo");
      },
    );
  });

  it("warns (does not fail) when the chosen peer root's basename differs from ours", async () => {
    await withPeerHealth(MULTI_HEALTH, async () => {
      const res = await resolvePeerProject(PEER, "beta", ctxWithRoot("/me/work/otherproj"));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.alias).toBe("beta");
        expect(res.warning).toContain("'beta'");
        expect(res.warning).toContain("otherproj");
      }
    });
  });

  it("tolerates a legacy peer (no projects list) with a warning, un-addressed", async () => {
    await withPeerHealth({ ok: true, root: "/machines/peer/work/old" }, async () => {
      const res = await resolvePeerProject(PEER, undefined, ctxWithRoot("/me/work/old"));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.alias).toBeUndefined();
        expect(res.warning).toContain("did not report its served projects");
      }
    });
  });

  it("refuses --peer-project against a legacy peer that cannot honor it", async () => {
    await withPeerHealth({ ok: true, root: "/machines/peer/work/old" }, async () => {
      const res = await resolvePeerProject(PEER, "alpha", ctxWithRoot("/me/work/old"));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toContain("does not support project addressing");
    });
  });

  it("tolerates an unreachable peer WITH a warning, preserving an explicit alias", async () => {
    await withPeerHealth({ unreachable: true }, async () => {
      const bare = await resolvePeerProject(PEER, undefined, ctxWithRoot("/me/x"));
      expect(bare.ok).toBe(true);
      if (bare.ok) {
        expect(bare.alias).toBeUndefined();
        expect(bare.warning).toContain("could not verify");
      }
      const pinned = await resolvePeerProject(PEER, "beta", ctxWithRoot("/me/x"));
      expect(pinned.ok).toBe(true);
      if (pinned.ok) {
        expect(pinned.alias).toBe("beta");
        expect(pinned.warning).toContain("'beta'");
      }
    });
  });

  it("tolerates an unhealthy (non-200) peer the same way, with a warning", async () => {
    await withPeerHealth({ status: 503 }, async () => {
      const res = await resolvePeerProject(PEER, undefined, ctxWithRoot("/me/x"));
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.warning).toContain("could not verify");
    });
  });

  it("warns loudly when a legacy peer's single project root name differs from ours", async () => {
    await withPeerHealth({ ok: true, root: "/machines/peer/work/otherrepo" }, async () => {
      const res = await resolvePeerProject(PEER, undefined, ctxWithRoot("/me/work/mine"));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.alias).toBeUndefined();
        expect(res.warning).toContain("'otherrepo'");
        expect(res.warning).toContain("'mine'");
        expect(res.warning).toContain("cross-contaminate");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end header wiring: a full runSync round must carry the PEER alias on
// every peer request and the LOCAL alias on the local push — a regression
// dropping `peerHeaders` at any one call site fails here.
// ---------------------------------------------------------------------------

describe("runSync peer/local header wiring (end-to-end)", () => {
  it("addresses every peer request with the peer alias and the local push with ours", async () => {
    const projDir = mkdtempSync(join(tmpdir(), "hayven-syncwire-"));
    mkdirSync(join(projDir, ".hayven"), { recursive: true });
    writeFileSync(join(projDir, ".hayven", "config.json"), "{}\n");
    const paths = hayvenPathsFor(projDir);

    // Our (empty) op-log's real Merkle roots, so the stubbed peer can return
    // a snapshot that differs ONLY on lww → exactly one segment to pull.
    const probe = new OpLog(paths.crdtDir);
    const ourRoots = computeMerkle(probe).roots;
    probe.close();

    const peerBase = "http://peer.example:7777";
    const seen: Array<{ url: string; alias: string | null }> = [];
    const segment = new Uint8Array([3, 1, 2, 3]); // varint len 3 + one 3-byte batch

    const origFetch = globalThis.fetch;
    const origCwd = process.cwd();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const alias = new Headers(init?.headers).get("x-hayven-project");
      seen.push({ url, alias });
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      const isPeer = url.startsWith(peerBase);
      if (url.includes("/api/health")) {
        return isPeer
          ? json({
              ok: true,
              primary: "solo",
              projects: [{ alias: "solo", root: projDir, branch: null }],
            })
          : json({
              ok: true,
              root: "/somewhere/else", // not our root → alias path, not primary
              primary: "other",
              projects: [
                { alias: "other", root: "/somewhere/else", branch: null },
                { alias: "localalias", root: projDir, branch: null },
              ],
            });
      }
      if (url.includes("/api/sync/merkle")) return json({ ...ourRoots, lww: "f".repeat(64) });
      if (url.includes("/api/sync/leaves"))
        return json({ type: "lww", leaves: [{ path: "lww/0001.seg", hash: "ab" }] });
      if (url.includes("/api/sync/batch"))
        return new Response(segment, { status: 200, headers: { "x-segment-eof": "1" } });
      if (url.includes("/api/sync/push")) return json({ ok: true });
      throw new Error(`unexpected request: ${url}`);
    }) as unknown as typeof fetch;

    try {
      process.chdir(projDir);
      const code = await runSync({ positionals: [peerBase], flags: {} });
      expect(code).toBe(0);
    } finally {
      process.chdir(origCwd);
      globalThis.fetch = origFetch;
    }

    const peerSync = seen.filter((r) => r.url.startsWith(peerBase) && r.url.includes("/api/sync/"));
    // merkle + leaves(lww) + batch — every one addressed to the peer's project.
    expect(peerSync.length).toBeGreaterThanOrEqual(3);
    for (const r of peerSync) expect(r.alias).toBe("solo");

    const localPushes = seen.filter(
      (r) => !r.url.startsWith(peerBase) && r.url.includes("/api/sync/push"),
    );
    expect(localPushes.length).toBe(1);
    expect(localPushes[0]?.alias).toBe("localalias");
  });
});

// ---------------------------------------------------------------------------
// Server leg: /api/sync/* strictness on a shared multi-project daemon.
// ---------------------------------------------------------------------------

function depsFor(): ServerDependencies {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-syncstrict-"));
  const db = new Db(":memory:");
  db.migrate();
  return {
    db,
    config: DEFAULT_CONFIG,
    paths: hayvenPathsFor(repoRoot),
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used in this test");
      },
    },
  };
}

function mkApp() {
  const projects = new Map<string, ServerDependencies>([
    ["alpha", depsFor()],
    ["beta", depsFor()],
  ]);
  return buildMultiProjectApp({
    primary: "alpha",
    projects,
    logger: createLogger({ toFile: false, toStderr: false }),
    daemonVersion: "test",
  });
}

describe("shared daemon /api/sync/* strictness (server leg)", () => {
  it("404s GET /api/sync/merkle with an unknown explicit selector (no primary fallback)", async () => {
    const app = mkApp();
    const res = await app.handle(
      new Request("http://localhost/api/sync/merkle", {
        headers: { "x-hayven-project": "gone" },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("'gone'");
  });

  it("serves GET /api/sync/merkle for a valid selector", async () => {
    const app = mkApp();
    const res = await app.handle(
      new Request("http://localhost/api/sync/merkle", {
        headers: { "x-hayven-project": "beta" },
      }),
    );
    expect(res.status).toBe(200);
    const roots = (await res.json()) as Record<string, string>;
    expect(Object.keys(roots).sort()).toEqual(["gset", "lww", "orset"]);
  });

  it("still serves un-addressed GET /api/sync/merkle from the primary (legacy clients)", async () => {
    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/sync/merkle"));
    expect(res.status).toBe(200);
  });

  it("keeps the primary fallback for unknown selectors on non-sync READS", async () => {
    const app = mkApp();
    const res = await app.handle(
      new Request("http://localhost/api/health", {
        headers: { "x-hayven-project": "gone" },
      }),
    );
    expect(res.status).toBe(200);
  });
});
