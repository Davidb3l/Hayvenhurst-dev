/**
 * Bounded `fetch` for every CLI → daemon call.
 *
 * WHY THIS EXISTS (the class of bug that hid the six-hour incident). A `fetch`
 * with no `AbortSignal` inherits Bun's FIVE-MINUTE idle default. A daemon that
 * is alive but too busy to answer HTTP — exactly what a runaway ingest produces
 * — ACCEPTS the connection and then never replies, so every un-bounded CLI call
 * parked for 300 s while printing a message that promised something far
 * shorter. That is how five `hayven daemon start` invocations stacked up, and
 * why "the daemon is wedged" was indistinguishable from "the daemon is slow"
 * for six hours.
 *
 * `daemon/src/daemon/detach.ts` fixed `probeDaemon`/`waitForDaemon` first; this
 * module is the SAME convention (one `AbortSignal.timeout` per exchange,
 * clamped budgets) applied to the CLI subcommands, and it deliberately reuses
 * {@link DETACH_PROBE_TIMEOUT_MS} rather than minting a second probe constant.
 *
 * THE SIGNAL MUST COVER THE BODY READ. Aborting a `fetch` also tears down the
 * response BODY stream, so passing one signal to `fetch` bounds the whole
 * exchange. Measured against a server that sends headers and then stalls
 * mid-body: `res.json()` rejects with `TimeoutError` at the deadline. Creating
 * a signal, awaiting headers, and then reading the body WITHOUT that signal
 * simply moves the five-minute hang into the body read.
 */
import { DETACH_PROBE_TIMEOUT_MS } from "../daemon/detach.ts";

/**
 * Budget for a LIVENESS PROBE (`GET /api/health`) — reused verbatim from the
 * detach path so the CLI and the daemon-start path agree on what "the daemon
 * is not answering" means. A healthy daemon answers /api/health in single-digit
 * ms; two seconds is already enormously generous.
 */
export const CLI_PROBE_TIMEOUT_MS = DETACH_PROBE_TIMEOUT_MS;

/**
 * Budget for a REAL request (claim / release / node body / sync segment
 * transfer / summarize write). These do actual work in the daemon — a claim
 * runs the conflict oracle, a sync push decodes and fsyncs a batch — so they
 * get far more headroom than a probe. The number that matters is that it is
 * NOT 300 s: 30 s is ~15x the slowest measured healthy call and still fails
 * fast enough that a human or an agent notices something is wrong rather than
 * assuming the command is working.
 */
export const CLI_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Did this rejection come from our own deadline rather than from the network?
 *
 * `AbortSignal.timeout` aborts with `DOMException(name: "TimeoutError")` — that
 * is what Bun's `fetch` rejects with, and what a body read (`res.json()`)
 * rejects with when the same signal fires mid-stream. `AbortError` is included
 * because a caller-supplied signal composed in by {@link withTimeout} surfaces
 * under that name.
 */
export function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === "string" && /timed out|timeout|aborted/i.test(msg);
}

/**
 * Attach a `ms` deadline to `init`, preserving any signal the caller already
 * supplied (composed with `AbortSignal.any`, so whichever fires first wins).
 * `ms` is clamped to at least 1 so a zero/negative budget still produces a
 * signal that fires rather than one that never does.
 */
export function withTimeout(init: RequestInit | undefined, ms: number): RequestInit {
  const timeout = AbortSignal.timeout(Math.max(1, ms));
  const existing = init?.signal;
  return {
    ...init,
    signal: existing ? AbortSignal.any([existing, timeout]) : timeout,
  };
}

/**
 * `fetch` with a deadline. Returns the `Response` with the deadline STILL
 * ARMED, which is the point: the caller reads the body under the same budget.
 * `fetchImpl` is injectable so tests can drive the call sites without a socket.
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  ms: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(url, withTimeout(init, ms));
}

/**
 * The stderr text for a failed daemon call, distinguishing the two cases the
 * old wording conflated.
 *
 * "Start it with `hayven daemon start`" is ACTIVELY WRONG advice for a timeout:
 * the daemon is already running, it is just not answering, and starting another
 * one is precisely how the incident ended up with five stacked processes. So a
 * timeout gets its own message pointing at status/logs instead.
 */
export function describeDaemonFetchFailure(
  base: string,
  err: unknown,
  timeoutMs: number,
): string {
  if (isTimeoutError(err)) {
    return (
      `daemon at ${base} did not answer within ${timeoutMs} ms.\n` +
      "It accepted the connection, so it is RUNNING but not responding — most likely\n" +
      "busy with a long ingest, or wedged. Do NOT start a second one; check\n" +
      "`hayven daemon status` and `hayven daemon logs` first.\n"
    );
  }
  return (
    `could not reach daemon at ${base} (${(err as Error | null)?.message ?? String(err)}).\n` +
    "Start it with `hayven daemon start`.\n"
  );
}
