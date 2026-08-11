/**
 * Detached daemon start — the plumbing behind the DEFAULT `hayven daemon start`.
 *
 * The CLI re-execs ITSELF as a background child (`daemon start --foreground`),
 * redirects the child's stdio to the daemon log, detaches it from the parent's
 * process group/session (so clearing or exiting the launching terminal — e.g. a
 * Claude Code session ending — no longer kills the daemon), then polls the
 * health endpoint until the child is serving and exits 0.
 *
 * Everything here is PURE or dependency-injected (fetch/sleep) so the spawn-arg
 * construction, health-shape detection, and polling are unit-testable without
 * spawning real processes or binding ports.
 */

import { VERSION } from "../version.ts";

/** One project row of a multi-project `/api/health` response. */
export interface HealthProject {
  readonly alias: string;
  readonly root: string;
  readonly branch?: string | null;
}

/** The subset of `/api/health` the detach/registration paths care about. */
export interface HayvenHealth {
  readonly ok: boolean;
  readonly version?: string;
  readonly root?: string;
  readonly primary?: string;
  readonly projects?: HealthProject[];
  /**
   * The daemon process's own pid (additive - absent from pre-upgrade daemons).
   * This is what lets `daemon stop`/`status` name and, with corroboration
   * (the pid must be alive on THIS machine), signal an orphan daemon that
   * answers on the port with no pidfile in any repo.
   */
  readonly pid?: number;
}

/**
 * Structural check that a JSON body is a hayven daemon's `/api/health` payload
 * — `ok: true` plus a string `version` AND a string `root` (both shipped since
 * the identity hardening pass). Used to tell "port already owned by a hayven
 * daemon" (register + reuse) apart from "port owned by something else entirely"
 * (hard error), so we never treat a random dev server's 200 as our daemon.
 */
export function looksLikeHayvenHealth(body: unknown): body is HayvenHealth {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return b["ok"] === true && typeof b["version"] === "string" && typeof b["root"] === "string";
}

/* ------------------------------------------------------------------ *
 * CLI ↔ daemon version handshake
 * ------------------------------------------------------------------ */

/**
 * The OLDEST resident daemon this CLI will talk to.
 *
 * THE RULE (stated so the next person can apply it):
 *   - daemon version < this floor            → refuse, "restart the daemon".
 *   - daemon MAJOR > this CLI's major        → refuse, "upgrade the binary".
 *   - anything else (newer patch/minor within the same major, or any version at
 *     or above the floor)                    → accepted.
 *
 * Bump this whenever the daemon's HTTP surface changes in a way a newer CLI
 * depends on. `/api/health` has always shipped a `version`, but nothing ever
 * compared it, so a new CLI against an old resident daemon proceeded and then
 * took a JSON 404 on a route the old daemon does not serve — see the one-symptom
 * patch at `cli/sync.ts:195` ("old daemon without a `projects` list"). We set
 * the floor at 0.0.6 because that is the release where `/api/health` began
 * reporting the multi-project `projects` list the current CLI assumes.
 *
 * Note this is deliberately a 0.x-aware floor rather than semver "same major":
 * on a 0.0.x line every release is a potential breaking change, so a
 * major-only comparison would make the handshake vacuous.
 */
export const MIN_COMPATIBLE_DAEMON_VERSION = "0.0.6";

/** Parse `MAJOR.MINOR.PATCH` (ignoring any `-rc1`-style suffix). */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type VersionCheck = { ok: true } | { ok: false; reason: string };

/**
 * Compare the version a daemon reports against this CLI's expectations.
 *
 * Returns an ACTIONABLE reason on mismatch — naming both versions and the fix —
 * so the failure is "your daemon is stale, restart it" rather than a mystery
 * 404 fifteen calls later. An unparseable version is treated as incompatible:
 * the only producer of that field is our own `VERSION` constant, so a string we
 * cannot read means we are not talking to a build we understand.
 */
export function checkDaemonVersion(
  daemonVersion: string,
  cliVersion: string,
  minDaemonVersion: string = MIN_COMPATIBLE_DAEMON_VERSION,
): VersionCheck {
  const daemon = parseVersion(daemonVersion);
  const cli = parseVersion(cliVersion);
  const floor = parseVersion(minDaemonVersion);
  if (daemon === null) {
    return {
      ok: false,
      reason:
        `the daemon reports an unrecognizable version ("${daemonVersion}"); ` +
        `this CLI is ${cliVersion} and cannot verify compatibility. ` +
        "Restart the daemon (`hayven daemon stop && hayven daemon start`).",
    };
  }
  if (cli === null || floor === null) return { ok: true }; // nothing to compare against
  if (compareVersions(daemon, floor) < 0) {
    return {
      ok: false,
      reason:
        `the running daemon is hayven ${daemonVersion}, but this CLI (${cliVersion}) ` +
        `requires a daemon of at least ${minDaemonVersion}. ` +
        "Restart it so it picks up the current binary: `hayven daemon stop && hayven daemon start`.",
    };
  }
  if (daemon[0] > cli[0]) {
    return {
      ok: false,
      reason:
        `the running daemon is hayven ${daemonVersion}, which is a newer major than ` +
        `this CLI (${cliVersion}). Upgrade the binary: an old CLI cannot speak the ` +
        "newer daemon's API.",
    };
  }
  return { ok: true };
}

/**
 * Build the argv used to re-exec THIS CLI as the detached daemon child.
 *
 * Two execution modes:
 *  - Compiled single binary (`bun build --compile`): `process.argv[1]` is the
 *    virtual embedded entrypoint (`/$bunfs/...` on POSIX, a `~BUN`-ish virtual
 *    drive path on Windows). Re-exec the binary itself with the subcommand.
 *  - Source mode (`bun src/cli.ts …`): `execPath` is the `bun` runtime and
 *    `argv[1]` is the real script path — pass it through.
 *
 * `extraArgs` forwards the user's bind overrides (`--port`/`--host`) so the
 * child binds exactly where the parent will poll.
 */
export function buildDetachedCommand(opts: {
  execPath: string;
  /** `process.argv[1]` — the entry script, virtual when compiled. */
  entryScript: string | undefined;
  extraArgs?: readonly string[];
}): string[] {
  const script = opts.entryScript ?? "";
  const isCompiled =
    script.length === 0 ||
    script.startsWith("/$bunfs") ||
    script.includes("$bunfs") ||
    script.includes("~BUN");
  const head = isCompiled ? [opts.execPath] : [opts.execPath, script];
  return [...head, "daemon", "start", "--foreground", ...(opts.extraArgs ?? [])];
}

export type DaemonProbe =
  | { kind: "hayven"; health: HayvenHealth }
  /**
   * `reason`/`health` are set ONLY for the version-mismatch case: a genuine
   * hayven daemon answered, but one this CLI refuses to drive. Callers that
   * print an error should prefer `reason` over their own generic wording.
   */
  | { kind: "foreign"; reason?: string; health?: HayvenHealth }
  | { kind: "unreachable" };

/**
 * How long ONE health probe may take, end to end.
 *
 * WHY THIS EXISTS: `fetch` had no `AbortSignal`, so a socket that ACCEPTS and
 * then never answers — a live daemon with a pegged event loop, exactly what a
 * runaway ingest produces — parked the probe on Bun's 5-minute default idle
 * timeout. Measured: a single `probeDaemon` against an accept-and-hang server
 * took 300,020 ms. That is how five `hayven daemon start` invocations stacked up
 * during the incident, each printing a "within 10s" message that was wrong by a
 * factor of thirty. A healthy daemon answers /api/health in single-digit ms; two
 * seconds is already enormously generous.
 */
export const DETACH_PROBE_TIMEOUT_MS = 2_000;

/**
 * One-shot classification of whatever answers at `base`:
 *  - `hayven`      — a hayven daemon, health shape verified AND version
 *                    compatible (see {@link checkDaemonVersion}) → reuse it.
 *  - `foreign`     — SOMETHING answered but we must not drive it: either not a
 *                    hayven daemon at all, or a hayven daemon too old/too new
 *                    for this CLI. Either way the caller must error clearly
 *                    instead of spawning a doomed child that would EADDRINUSE.
 *  - `unreachable` — nothing listening, or nothing answered within
 *                    `timeoutMs` → safe to spawn.
 *
 * A hang is deliberately classified as `unreachable` rather than `foreign`: the
 * caller's next step for `unreachable` is the pidfile check, which prints
 * "pidfile reports a live daemon but <base> is unreachable" — accurate for a
 * wedged daemon, and it refuses to start a duplicate.
 */
export async function probeDaemon(
  base: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DETACH_PROBE_TIMEOUT_MS,
): Promise<DaemonProbe> {
  // ONE signal for the whole exchange. Aborting also tears down the response
  // BODY stream, so a server that sends headers and then stalls mid-body is
  // bounded by the same budget as the connect/headers phase — otherwise the
  // `res.json()` below would be the new place to hang forever.
  const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/health`, { signal });
  } catch {
    return { kind: "unreachable" };
  }
  if (!res.ok) return { kind: "foreign" };
  const body = await res.json().catch(() => null);
  if (!looksLikeHayvenHealth(body)) return { kind: "foreign" };

  const check = checkDaemonVersion(body.version ?? "", VERSION);
  if (!check.ok) return { kind: "foreign", reason: check.reason, health: body };
  return { kind: "hayven", health: body };
}

/** How long the parent waits for the detached child to come up healthy. */
export const DETACH_HEALTH_TIMEOUT_MS = 10_000;
/** Poll interval while waiting for the child's health endpoint. */
export const DETACH_HEALTH_INTERVAL_MS = 200;

/**
 * Poll `${base}/api/health` until a hayven daemon answers or `timeoutMs`
 * elapses. Returns the health payload on success, `null` on timeout. A
 * `foreign` answer keeps polling — during startup a proxy or the OS can return
 * transient non-hayven responses; the deadline bounds the wait either way.
 *
 * `timeoutMs` bounds TOTAL elapsed time, which it previously did not: the
 * deadline was only consulted AFTER `probeDaemon` returned, so one unbounded
 * probe (see {@link DETACH_PROBE_TIMEOUT_MS}) blew straight through it — a
 * `waitForDaemon(base, {timeoutMs: 10_000})` was measured still parked at 45 s.
 * Every probe and every sleep is now clamped to the remaining budget, so the
 * caller's "did not become healthy within 10s" message is finally TRUE.
 */
export async function waitForDaemon(
  base: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    /** Per-probe cap; also clamped down to whatever budget remains. */
    probeTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<HayvenHealth | null> {
  const timeoutMs = opts.timeoutMs ?? DETACH_HEALTH_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DETACH_HEALTH_INTERVAL_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? DETACH_PROBE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  // Always probe at least once, even with a zero/negative timeout.
  let first = true;
  for (;;) {
    const remaining = deadline - Date.now();
    if (!first && remaining <= 0) return null;
    // Clamp the probe to what is left of the budget. The very first probe gets
    // the full per-probe cap even on a zero budget, so "always probe at least
    // once" still holds and the worst case is bounded by probeTimeoutMs.
    const budget = first && remaining <= 0 ? probeTimeoutMs : Math.min(probeTimeoutMs, remaining);
    first = false;
    const probe = await probeDaemon(base, fetchImpl, budget);
    if (probe.kind === "hayven") return probe.health;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await sleep(Math.min(intervalMs, left));
  }
}
