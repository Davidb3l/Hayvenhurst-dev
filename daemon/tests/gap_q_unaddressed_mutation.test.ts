/**
 * GAP Q5 — a MUTATION with no `?project=` selector silently targeted the PRIMARY.
 *
 * `buildMultiProjectApp` hard-refused only a PRESENT-but-unknown alias. An
 * OMITTED selector fell through to `primaryDeps`, so a mutating request meant
 * for repo B, sent to a shared daemon whose primary is repo A, wrote into A's
 * CRDT op-log with no error anywhere — the same class of silent wrong-repo write
 * the unknown-alias refusal exists to prevent.
 *
 * The refusal is TWO-SIDED by necessity: `cli/_shared.ts`'s `projectHeader()`
 * sends NO header when the daemon's primary IS this repo, so a naive server-side
 * requirement would break every correct CLI mutation from the primary repo.
 * The server half implemented here accepts either:
 *   - `x-hayven-project: <alias>` (what a multi-project daemon's /api/health
 *     already gives every client, primary included — the normal path), or
 *   - `x-hayven-primary-root: <abs root>`, RE-CHECKED against the primary's own
 *     root, for the single-project-shaped health response that has no alias.
 * Daemon-level mutations (add/remove a project) are exempt: their target is in
 * the request, not the selector.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import {
  buildMultiProjectApp,
  PRIMARY_ROOT_HEADER,
  type ServerDependencies,
} from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";
import { makeTestCrdtState } from "./_helpers.ts";

const HAYVEN_HOME_SANDBOX = mkdtempSync(join(tmpdir(), "hayven-gapq-mut-home-"));
process.env["HAYVEN_HOME"] = HAYVEN_HOME_SANDBOX;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function depsFor(): ServerDependencies {
  const db = new Db(":memory:");
  db.migrate();
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-gapq-mut-"));
  dirs.push(repoRoot);
  return {
    db,
    config: DEFAULT_CONFIG,
    paths: hayvenPathsFor(repoRoot),
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => ({ nodes: 0, edges: 0, files: 0, durationMs: 0 }) as never,
    },
  };
}

/**
 * The route layer may 400 a request for its OWN reasons (body validation), so
 * "did the selector gate refuse this?" is asserted on the gate's own signal —
 * its refusal body and its warn line — not on a bare status code.
 */
const REFUSAL_MARKER = "must say";

function mkApp(aliases: string[]) {
  const projects = new Map<string, ServerDependencies>();
  for (const a of aliases) projects.set(a, depsFor());
  const warns: string[] = [];
  const logger = createLogger({ toFile: false, toStderr: false });
  const spy = { ...logger, warn: (msg: string) => void warns.push(msg), child: () => spy } as never;
  return {
    app: buildMultiProjectApp({
      primary: aliases[0]!,
      projects,
      logger: spy,
      daemonVersion: "test",
      // A no-op remover so DELETE /api/projects/:alias is a real route.
      removeProject: async () => true,
      addProject: async (root: string) => ({ alias: "added", root, added: true }),
    }),
    projects,
    warns,
  };
}

/** True iff the SELECTOR GATE refused, as opposed to any route-level 400. */
async function refusedBySelectorGate(res: Response): Promise<boolean> {
  if (res.status !== 400) return false;
  const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
  return typeof body.error === "string" && body.error.includes(REFUSAL_MARKER);
}

/** A representative PROJECT-SCOPED mutation. */
const claimBody = JSON.stringify({ scope: "src/x.ts", agent: "tester" });

describe("Q5 — un-addressed mutations against a multi-project daemon", () => {
  test("REFUSED with a 400 that names the fix", async () => {
    const { app } = mkApp(["alpha", "beta"]);
    const res = await app.handle(
      new Request("http://localhost/api/claims", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: claimBody,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(REFUSAL_MARKER);
    expect(body.error).toContain("?project=");
  });

  test("ACCEPTED when the request carries x-hayven-project (the normal CLI path)", async () => {
    const { app } = mkApp(["alpha", "beta"]);
    const res = await app.handle(
      new Request("http://localhost/api/claims", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hayven-project": "beta" },
        body: claimBody,
      }),
    );
    // Whatever the route does with the body, it must not be the selector refusal.
    expect(await refusedBySelectorGate(res)).toBe(false);
  });

  test("ACCEPTED when ?project= names a served alias", async () => {
    const { app } = mkApp(["alpha", "beta"]);
    const res = await app.handle(
      new Request("http://localhost/api/claims?project=alpha", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: claimBody,
      }),
    );
    expect(await refusedBySelectorGate(res)).toBe(false);
  });

  test("ACCEPTED with a VERIFIED x-hayven-primary-root claim", async () => {
    const { app, projects, warns } = mkApp(["alpha", "beta"]);
    const primaryRoot = projects.get("alpha")!.paths.repoRoot;
    const res = await app.handle(
      new Request("http://localhost/api/claims", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [PRIMARY_ROOT_HEADER]: primaryRoot,
        },
        body: claimBody,
      }),
    );
    expect(await refusedBySelectorGate(res)).toBe(false);
    expect(warns.some((w) => w.includes("REFUSED un-addressed MUTATION"))).toBe(false);
  });

  test("REFUSED when the primary-root claim names a DIFFERENT repo", async () => {
    const { app, projects } = mkApp(["alpha", "beta"]);
    // A client whose idea of the primary went stale — the exact case a bare
    // "trust me" flag would have let through into the wrong op-log.
    const notPrimary = projects.get("beta")!.paths.repoRoot;
    const res = await app.handle(
      new Request("http://localhost/api/claims", {
        method: "POST",
        headers: { "content-type": "application/json", [PRIMARY_ROOT_HEADER]: notPrimary },
        body: claimBody,
      }),
    );
    expect(await refusedBySelectorGate(res)).toBe(true);
  });

  test("a SINGLE-project daemon is unaffected (nothing to disambiguate)", async () => {
    const { app } = mkApp(["solo"]);
    const res = await app.handle(
      new Request("http://localhost/api/claims", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: claimBody,
      }),
    );
    expect(await refusedBySelectorGate(res)).toBe(false);
  });

  test("READS with no selector are untouched", async () => {
    const { app } = mkApp(["alpha", "beta"]);
    const res = await app.handle(new Request("http://localhost/api/stats"));
    expect(res.status).toBe(200);
  });

  test("POST /api/traces/observations stays exempt — its clients CANNOT send a selector", async () => {
    // The Go / Python / Rust collectors are configured with a daemon base URL
    // and send Content-Type + User-Agent only; the payload carries no repo root
    // to infer an alias from. Refusing them would silently drop every runtime
    // trace the moment a daemon picked up a second project, which is the steady
    // state. This exemption is a KNOWN gap, not an oversight — closing it needs
    // a selector in the collector wire format.
    const { app, warns } = mkApp(["alpha", "beta"]);
    const res = await app.handle(
      new Request("http://localhost/api/traces/observations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "test", observations: [] }),
      }),
    );
    expect(await refusedBySelectorGate(res)).toBe(false);
    // Exempt, but never silent: it IS a write landing in a possibly-wrong project.
    expect(warns.some((w) => w.includes("no selector-capable client"))).toBe(true);
  });

  test("daemon-level project add/remove stay exempt — their target is in the request", async () => {
    const { app, projects } = mkApp(["alpha", "beta"]);
    const add = await app.handle(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: projects.get("beta")!.paths.repoRoot }),
      }),
    );
    expect(await refusedBySelectorGate(add)).toBe(false);

    const del = await app.handle(
      new Request("http://localhost/api/projects/beta", { method: "DELETE" }),
    );
    expect(await refusedBySelectorGate(del)).toBe(false);
  });
});
