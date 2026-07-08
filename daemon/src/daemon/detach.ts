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
  | { kind: "foreign" }
  | { kind: "unreachable" };

/**
 * One-shot classification of whatever answers at `base`:
 *  - `hayven`      — a hayven daemon (health shape verified) → reuse it.
 *  - `foreign`     — SOMETHING answered but it is not a hayven daemon → the
 *                    caller must error clearly instead of spawning a doomed
 *                    child that would EADDRINUSE.
 *  - `unreachable` — nothing listening → safe to spawn.
 */
export async function probeDaemon(
  base: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonProbe> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/health`);
  } catch {
    return { kind: "unreachable" };
  }
  if (!res.ok) return { kind: "foreign" };
  const body = await res.json().catch(() => null);
  return looksLikeHayvenHealth(body) ? { kind: "hayven", health: body } : { kind: "foreign" };
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
 */
export async function waitForDaemon(
  base: string,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<HayvenHealth | null> {
  const timeoutMs = opts.timeoutMs ?? DETACH_HEALTH_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DETACH_HEALTH_INTERVAL_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  // Always probe at least once, even with a zero/negative timeout.
  for (;;) {
    const probe = await probeDaemon(base, fetchImpl);
    if (probe.kind === "hayven") return probe.health;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}
