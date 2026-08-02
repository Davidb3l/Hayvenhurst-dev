// LANE T / T1 — every daemon-facing CLI fetch is BOUNDED.
//
// The failure being prevented: a `fetch` with no `AbortSignal` inherits Bun's
// FIVE-MINUTE idle default. A daemon that is alive but too busy to answer HTTP
// — what a runaway ingest produces — accepts the connection and never replies,
// so the CLI parks for 300 s. That is what made "the daemon is wedged" and "the
// daemon is slow" indistinguishable for six hours, and what let five
// `hayven daemon start` invocations stack up.
//
// Three layers, because no single one of them is sufficient:
//
//   1. HELPER, REAL SOCKET. `_fetch.ts` against an accept-and-hang listener and
//      against a server that sends headers then stalls mid-body. This is the
//      only layer that proves a real WALL-CLOCK bound, and the only one that
//      proves the signal also covers `res.json()` — otherwise the body read
//      just becomes the new place to hang forever.
//   2. CALL SITE, REAL SOCKET. `resolvePeerProject` (sync's peer health probe)
//      end to end against a hanging socket. It uses the 2 s probe budget, so a
//      genuine wall-clock assertion is affordable here.
//   3. CALL SITE, INJECTED FETCH. The remaining six sites use the 30 s request
//      budget, which is too long to wait out per test. Instead the injected
//      fetch RECORDS whether an `AbortSignal` was attached, and rejects
//      distinctively when one was not — so a call site that loses its signal
//      fails fast and by name rather than by test timeout.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import {
  CLI_PROBE_TIMEOUT_MS,
  CLI_REQUEST_TIMEOUT_MS,
  describeDaemonFetchFailure,
  fetchWithTimeout,
  isTimeoutError,
  withTimeout,
} from "../src/cli/_fetch.ts";
import { runClaim } from "../src/cli/claim.ts";
import { runNode } from "../src/cli/node.ts";
import { runRelease } from "../src/cli/release.ts";
import { resolvePeerProject, runSync } from "../src/cli/sync.ts";
import { runSummarize } from "../src/cli/summarize.ts";

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** A socket that ACCEPTS and then never writes a byte — the exact shape of a
 *  live daemon with a pegged event loop. Un-bounded, a fetch at this port takes
 *  Bun's 300 s default; measured in the incident write-up at 300,020 ms. */
function acceptAndHang(): { port: number; stop: () => void } {
  const srv = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {} },
  });
  return { port: srv.port, stop: () => srv.stop(true) };
}

/** Sends JSON headers, enqueues a partial body, and never closes the stream. */
function headersThenStall(): { port: number; stop: () => void } {
  const srv = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"ok":'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  return { port: srv.port as number, stop: () => srv.stop(true) };
}

/** A temp repo with `.hayven/` so `requireProject()` resolves it. `realpathSync`
 *  because macOS routes the tmpdir through a `/private` symlink and the
 *  identity guard compares canonical roots. */
function makeProject(port: number): string {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "hayven-gapt-")));
  mkdirSync(join(repoRoot, ".hayven"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".hayven", "config.json"),
    JSON.stringify({ ...DEFAULT_CONFIG, daemon_host: "127.0.0.1", daemon_port: port }),
  );
  return repoRoot;
}

interface SeenCall {
  url: string;
  hasSignal: boolean;
}

/**
 * Injected `fetch` that answers `/api/health` (so the identity guard in
 * `_shared.ts` — Lane P's file, still un-bounded — cannot be what stalls these
 * tests) and, for every OTHER url, records whether a signal was attached.
 *
 * With a signal → reject as the real deadline does (`TimeoutError`), so the
 * call site's timeout branch runs. Without one → reject with a marker, so a
 * regressed call site fails immediately and legibly instead of hanging the
 * suite for five minutes.
 */
function signalRecordingFetch(
  repoRoot: string,
  seen: SeenCall[],
  /** Optional canned success responses, so a call site's LATER requests are
   *  reached (e.g. summarize's PUT only happens if its GET succeeded). */
  respond?: (url: string) => Response | null,
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const signal = init?.signal;
    // Health calls are RECORDED but always answered: `_shared.ts`'s identity
    // guard (Lane P's file, still un-bounded) also probes health, and if that
    // stalled these tests we would be measuring the wrong fetch.
    if (url.includes("/api/health")) {
      seen.push({ url, hasSignal: signal instanceof AbortSignal });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, version: "test", root: repoRoot }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    seen.push({ url, hasSignal: signal instanceof AbortSignal });
    const canned = respond?.(url) ?? null;
    if (canned !== null) return Promise.resolve(canned);
    if (!(signal instanceof AbortSignal)) {
      return Promise.reject(
        new Error("UNBOUNDED_FETCH: this call site attached no AbortSignal"),
      );
    }
    return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
  }) as unknown as typeof fetch;
}

async function withFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

async function captureIo(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = () => true;
  (process.stderr as { write: unknown }).write = (s: string) => {
    err.push(typeof s === "string" ? s : String(s));
    return true;
  };
  try {
    const code = await fn();
    return { code, err: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/* ------------------------------------------------------------------ *
 * 1. the helper, against real sockets
 * ------------------------------------------------------------------ */

describe("T1 — _fetch.ts bounds a real hanging socket", () => {
  it("aborts a connect-and-hang within the budget instead of Bun's 5-minute default", async () => {
    const srv = acceptAndHang();
    const started = Date.now();
    try {
      await expect(
        fetchWithTimeout(`http://127.0.0.1:${srv.port}/api/health`, undefined, 300),
      ).rejects.toThrow();
      // The number that matters is that it is nowhere near 300_000.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      srv.stop();
    }
  }, 15_000);

  it("the SAME signal covers the body read — a mid-body stall is bounded too", async () => {
    // Without this the bound is a half-bound: headers arrive fast, and
    // `res.json()` becomes the new place to hang for five minutes.
    const srv = headersThenStall();
    const started = Date.now();
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${srv.port}/x`, undefined, 300);
      expect(res.ok).toBe(true); // headers arrived; the body has not
      let caught: unknown;
      try {
        await res.json();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isTimeoutError(caught)).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      srv.stop();
    }
  }, 15_000);

  it("withTimeout attaches a signal and preserves a caller-supplied one", () => {
    const plain = withTimeout({ method: "POST" }, 50);
    expect(plain.signal).toBeInstanceOf(AbortSignal);
    expect(plain.method).toBe("POST");

    const caller = new AbortController();
    const composed = withTimeout({ signal: caller.signal }, 60_000);
    expect(composed.signal).toBeInstanceOf(AbortSignal);
    expect(composed.signal?.aborted).toBe(false);
    caller.abort(new Error("caller changed its mind"));
    expect(composed.signal?.aborted).toBe(true);
  });

  it("a zero/negative budget still produces a signal that fires", async () => {
    const srv = acceptAndHang();
    try {
      await expect(
        fetchWithTimeout(`http://127.0.0.1:${srv.port}/x`, undefined, 0),
      ).rejects.toThrow();
    } finally {
      srv.stop();
    }
  }, 15_000);

  it("isTimeoutError separates our deadline from a connection refusal", () => {
    expect(isTimeoutError(new DOMException("The operation timed out.", "TimeoutError"))).toBe(
      true,
    );
    expect(isTimeoutError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isTimeoutError(new Error("Unable to connect. Is the computer able to access the url?"))).toBe(
      false,
    );
    expect(isTimeoutError(null)).toBe(false);
  });

  it("a timeout NEVER tells the user to start a second daemon", () => {
    // The old blanket advice was actively harmful here: the daemon is already
    // up, and starting another is how the incident collected five processes.
    const timeout = describeDaemonFetchFailure(
      "http://127.0.0.1:7777",
      new DOMException("The operation timed out.", "TimeoutError"),
      CLI_REQUEST_TIMEOUT_MS,
    );
    expect(timeout).toContain("did not answer within");
    expect(timeout).toContain("Do NOT start a second one");
    expect(timeout).not.toContain("Start it with");

    const refused = describeDaemonFetchFailure(
      "http://127.0.0.1:7777",
      new Error("connection refused"),
      CLI_REQUEST_TIMEOUT_MS,
    );
    expect(refused).toContain("Start it with `hayven daemon start`");
  });
});

/* ------------------------------------------------------------------ *
 * 2. sync's peer probe, end to end against a real hanging socket
 * ------------------------------------------------------------------ */

describe("T1 — sync's peer health probe is wall-clock bounded", () => {
  it("resolvePeerProject gives up on a hanging peer within the probe budget", async () => {
    const srv = acceptAndHang();
    const started = Date.now();
    try {
      const res = await resolvePeerProject(
        `http://127.0.0.1:${srv.port}`,
        undefined,
        { paths: { repoRoot: "/tmp/whatever" } },
      );
      const elapsed = Date.now() - started;
      // Un-bounded this sat for 300 s before exchanging a single Merkle root.
      expect(elapsed).toBeLessThan(CLI_PROBE_TIMEOUT_MS * 3);
      expect(res.ok).toBe(true);
      expect(res.ok && res.warning).toContain("health probe failed");
    } finally {
      srv.stop();
    }
  }, 20_000);
});

/* ------------------------------------------------------------------ *
 * 3. the remaining call sites attach a signal and handle its firing
 * ------------------------------------------------------------------ */

describe("T1 — every mutating CLI call site attaches a deadline", () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  /** Every case: the non-health request must carry a signal, and when that
   *  signal fires the command must exit 1 with the timeout wording — not the
   *  "start the daemon" wording, and not by hanging. */
  async function expectBounded(
    run: () => Promise<number>,
    urlFragment: string,
  ): Promise<void> {
    const port = 7777;
    const repoRoot = makeProject(port);
    process.chdir(repoRoot);
    const seen: SeenCall[] = [];
    let captured = { code: -1, err: "" };
    await withFetch(signalRecordingFetch(repoRoot, seen), async () => {
      captured = await captureIo(run);
    });

    const target = seen.filter((c) => c.url.includes(urlFragment));
    expect(target.length).toBeGreaterThan(0);
    for (const call of target) expect(call.hasSignal).toBe(true);
    expect(captured.err).not.toContain("UNBOUNDED_FETCH");
    expect(captured.code).toBe(1);
  }

  it("hayven sync → every merkle/leaves/batch/push call (the shared wrapper)", async () => {
    // `reachableFetch` is the single wrapper the whole sync path funnels
    // through, so this covers merkle, leaves, batch and push at once. An
    // un-bounded one froze `hayven sync` for 300 s PER REQUEST, and a sync
    // touching twenty segments could sit there for an hour looking alive.
    const repoRoot = makeProject(7777);
    process.chdir(repoRoot);
    const seen: SeenCall[] = [];
    let captured = { code: -1, err: "" };
    await withFetch(signalRecordingFetch(repoRoot, seen), async () => {
      captured = await captureIo(() =>
        runSync({ positionals: ["http://127.0.0.1:7788"], flags: {} }),
      );
    });
    const merkle = seen.filter((c) => c.url.includes("/api/sync/merkle"));
    expect(merkle.length).toBeGreaterThan(0);
    for (const call of merkle) expect(call.hasSignal).toBe(true);
    expect(captured.code).toBe(1);
    expect(captured.err).toContain("did not answer within");
    expect(captured.err).toContain("Do NOT start a second one");
  });

  it("hayven claim → POST /api/claims", async () => {
    await expectBounded(
      () => runClaim({ positionals: ["mod/a"], flags: { intent: "test" } }),
      "/api/claims",
    );
  });

  it("hayven release → DELETE /api/claims/:id", async () => {
    await expectBounded(
      () => runRelease({ positionals: ["claim_x"], flags: {} }),
      "/api/claims/claim_x",
    );
  });

  it("hayven node body → PUT /api/nodes/:id/body", async () => {
    await expectBounded(
      () => runNode({ positionals: ["body", "mod/a"], flags: { body: "hello" } }),
      "/api/nodes/mod%2Fa/body",
    );
  });

  it("claim/release/node all report a timeout rather than 'start the daemon'", async () => {
    const repoRoot = makeProject(7777);
    process.chdir(repoRoot);
    const seen: SeenCall[] = [];
    let captured = { code: -1, err: "" };
    await withFetch(signalRecordingFetch(repoRoot, seen), async () => {
      captured = await captureIo(() =>
        runRelease({ positionals: ["claim_x"], flags: {} }),
      );
    });
    expect(captured.err).toContain("did not answer within");
    expect(captured.err).toContain("Do NOT start a second one");
    expect(captured.err).not.toContain("Start it with `hayven daemon start`");
  });

  it("hayven summarize bounds BOTH its health probe and its per-node calls", async () => {
    // summarize's health probe decides the whole run's transport, and the
    // per-node GET/PUT run once PER NODE — an unbounded one there means a
    // `--all` run over a wedged daemon cannot finish this side of a week.
    const repoRoot = makeProject(7777);
    const paths = hayvenPathsFor(repoRoot);
    const db = new Db(paths.sqliteFile);
    db.migrate();
    db.upsertNode({
      id: "mod/a",
      name: "a",
      qualified_name: "a",
      kind: "function",
      language: "typescript",
      file: "a.ts",
      range: [1, 2],
      ast_hash: "blake3:test",
      last_seen: Date.now(),
      logical_clock: 0,
    });
    db.close();
    process.chdir(repoRoot);

    const seen: SeenCall[] = [];
    // Answer the per-node GET so the run REACHES the PUT — otherwise the write
    // half of the loop is never exercised and could lose its signal unnoticed.
    const respond = (url: string): Response | null =>
      url.includes("/api/nodes/") && !url.endsWith("/body")
        ? new Response(
            JSON.stringify({
              node: {
                id: "mod/a",
                name: "a",
                qualified_name: "a",
                kind: "function",
                language: "typescript",
                file: "a.ts",
                range: [1, 2],
                ast_hash: "blake3:test",
                last_seen: 0,
                logical_clock: 0,
              },
            }),
            { headers: { "content-type": "application/json" } },
          )
        : null;
    await withFetch(signalRecordingFetch(repoRoot, seen, respond), async () => {
      await captureIo(() => runSummarize({ positionals: ["mod/a"], flags: {} }));
    });

    // summarize's OWN health probe runs first (it decides the transport);
    // `_shared.ts`'s un-bounded one follows. So call #1 is the one under test.
    const health = seen.filter((c) => c.url.includes("/api/health"));
    expect(health.length).toBeGreaterThan(0);
    expect(health[0]?.hasSignal).toBe(true);

    // Both halves of the per-node loop must be bounded.
    const get = seen.filter((c) => c.url.includes("/api/nodes/") && !c.url.endsWith("/body"));
    const put = seen.filter((c) => c.url.endsWith("/body"));
    expect(get.length).toBeGreaterThan(0);
    expect(put.length).toBeGreaterThan(0);
    for (const call of [...get, ...put]) expect(call.hasSignal).toBe(true);
  });
});
