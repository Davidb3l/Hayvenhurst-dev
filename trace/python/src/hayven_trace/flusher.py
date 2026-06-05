"""Periodic flush of aggregated observations to the daemon.

Uses ``urllib.request`` (stdlib) so we ship zero runtime deps. The flush
runs on a daemon thread; it gracefully no-ops if the daemon is unreachable
(traces are aggregated locally on the next interval — no data lost on the
client side, though the daemon won't see them until it's back).
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from typing import Callable, List, Optional, Sequence, TypeVar

from .aggregator import Aggregator, CoverageAggregator, CoverageRow, Observation

_T = TypeVar("_T")


def _chunk(rows: Sequence[_T], size: int) -> List[List[_T]]:
    """Split ``rows`` into consecutive lists of at most ``size`` elements.

    Empty input yields an empty list (no chunks) so an edge-empty or
    coverage-empty side contributes nothing to the paired-send loop.
    """
    if size < 1:
        size = 1
    return [list(rows[i : i + size]) for i in range(0, len(rows), size)]

log = logging.getLogger("hayven_trace.flusher")

# Maximum number of rows (observations OR coverage) carried in a single POST.
# The flush splits the drained payload into chunks of this size so no single
# request is multi-MB. This is the FIX for the measured data-loss bug: a full
# test suite's shutdown flush accumulated thousands of observations + coverage
# rows into ONE giant JSON whose POST blew the per-request timeout (or a daemon
# body-size limit), raised, was swallowed at `flush_once`, and — because the
# aggregators were already drained — silently dropped EVERYTHING. With bounded
# chunks each request is small enough to land inside the timeout, and a single
# failed chunk can no longer take the rest of the flush down with it.
FLUSH_BATCH_SIZE = 1000

# The shutdown flush (`stop(flush=True)`) carries the whole tail of a run and is
# the one most likely to be large. Even though batching keeps each request
# small, we give the final flush a roomier per-request timeout so a momentarily
# busy daemon can't truncate the last batch. The interval flushes keep the tight
# default so a broken daemon never stalls live user code.
SHUTDOWN_TIMEOUT_SECONDS = 30.0


class Flusher:
    """Background thread that drains an Aggregator on an interval.

    Parameters
    ----------
    aggregator:
        The shared aggregator that the tracer feeds.
    daemon_url:
        Base URL of the Hayvenhurst daemon (e.g. ``http://localhost:7777``).
        ``/api/traces/observations`` is appended.
    interval_seconds:
        Flush cadence. Default 30s per PRD §9.
    sample_rate:
        Used only to multiply weights on the wire so the daemon receives
        "estimated total invocations" rather than "sampled invocations".
        Caller is expected to apply the same value to the tracer.
    timeout_seconds:
        HTTP timeout for each POST.
    sender:
        Injectable transport for testing. Default uses urllib.
    coverage:
        Optional per-test coverage aggregator. When supplied, each flush also
        emits a top-level ``test_coverage`` array alongside the unchanged
        ``observations``. Drained on the SAME lifecycle as the edge aggregate
        (cleared on every flush, including the final shutdown flush).
    """

    def __init__(
        self,
        aggregator: Aggregator,
        daemon_url: str,
        interval_seconds: float = 30.0,
        sample_rate: int = 100,
        timeout_seconds: float = 2.0,
        sender: Optional[Callable[[str, bytes], None]] = None,
        source: str = "python",
        coverage: Optional[CoverageAggregator] = None,
    ) -> None:
        self._agg = aggregator
        self._coverage = coverage
        self._url = daemon_url.rstrip("/") + "/api/traces/observations"
        self._interval = interval_seconds
        self._sample_rate = max(1, sample_rate)
        self._timeout = timeout_seconds
        self._sender = sender or self._default_sender
        self._source = source
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._last_flush_at: float = 0.0
        self._last_flush_count: int = 0
        self._last_error: Optional[str] = None

    # ----- lifecycle -----

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        t = threading.Thread(target=self._run, name="hayven-trace-flusher", daemon=True)
        self._thread = t
        t.start()

    def stop(self, flush: bool = True) -> None:
        self._stop.set()
        t = self._thread
        if t is not None:
            t.join(timeout=max(2.0, self._timeout + 1.0))
        self._thread = None
        if not flush:
            return
        # The shutdown flush is the big one — it carries the entire tail of the
        # run. Drain EVERYTHING in bounded batches under a roomier timeout, and
        # loop until both aggregators are empty so nothing accumulated during
        # the flush is left behind. A bounded iteration guard keeps a pathologic
        # producer (still feeding the aggregator after stop) from looping
        # forever; in practice the tracer is already uninstalled by now so one
        # pass drains it.
        prev_timeout = self._timeout
        self._timeout = max(self._timeout, SHUTDOWN_TIMEOUT_SECONDS)
        try:
            for _ in range(1000):
                drained = self.flush_once()
                obs_left = self._agg.size()
                cov_left = self._coverage.size() if self._coverage is not None else 0
                # Nothing left to send → done.
                if obs_left == 0 and cov_left == 0:
                    break
                # Something is left but this pass drained nothing new (the only
                # rows present are re-buffered failures from a down daemon).
                # Re-flushing would spin forever against a dead daemon, so stop;
                # the data stays buffered and a later flush can still send it.
                if drained == 0:
                    break
                if self._last_error is not None:
                    # This pass drained rows but every chunk failed and was
                    # re-buffered. Don't busy-loop retrying a broken daemon
                    # during shutdown — leave the rows buffered and bail.
                    break
        finally:
            self._timeout = prev_timeout

    # ----- public -----

    def flush_once(self) -> int:
        """Drain and POST in bounded batches. Returns observations *drained*.

        The return value is the number of observations taken out of the
        aggregator this call (the historical contract: "we drained it"),
        independent of how many chunks actually reached the daemon — a failed
        chunk is re-buffered for the next flush, so the count still reflects
        what this flush was responsible for.

        The drained payload is split into chunks of at most
        :data:`FLUSH_BATCH_SIZE` rows and each chunk is POSTed in its own
        request. This is the data-loss fix: a single multi-MB POST blew the
        per-request timeout on a full suite and dropped the whole (already
        drained) batch; bounded chunks keep every request small.

        Resilience: each chunk is sent inside its own try/except. A failed
        chunk is logged at DEBUG, its rows are re-buffered into the aggregator
        so the next flush retries them, and the loop CONTINUES — one slow or
        rejected chunk can never prevent the remaining chunks from being sent.

        Coverage is never silently discarded. When there are coverage rows but
        no observations we still POST them (with an empty ``observations``
        array, which the daemon accepts), fixing the early-return that used to
        drain-then-drop coverage on an edge-empty flush.

        Errors are logged at DEBUG and stashed on ``self._last_error``; we
        never raise into the user's code.
        """
        obs = self._agg.drain()
        coverage = self._coverage.drain() if self._coverage is not None else []
        if not obs and not coverage:
            return 0

        obs_chunks = _chunk(obs, FLUSH_BATCH_SIZE)
        cov_chunks = _chunk(coverage, FLUSH_BATCH_SIZE)
        # Pair observation chunks with coverage chunks so coverage rides WITH a
        # non-empty observations payload wherever possible. When one list has
        # more chunks than the other, the surplus chunks ship on their own
        # (coverage-only payloads carry an empty `observations: []`, which the
        # daemon route accepts; observation-only payloads omit `test_coverage`).
        sent = 0
        any_error: Optional[str] = None
        n_pairs = max(len(obs_chunks), len(cov_chunks))
        for i in range(n_pairs):
            o = obs_chunks[i] if i < len(obs_chunks) else []
            c = cov_chunks[i] if i < len(cov_chunks) else []
            payload = self._encode(o, c)
            try:
                self._sender(self._url, payload)
                sent += len(o)
            except Exception as e:
                any_error = f"{type(e).__name__}: {e}"
                log.debug("hayven-trace flush chunk failed: %s", any_error)
                # Re-buffer the failed chunk so the next flush retries it; this
                # turns a transient failure into a delayed send rather than a
                # permanent drop. We CONTINUE so chunks i+1… still go out.
                self._rebuffer(o, c)

        if any_error is not None:
            self._last_error = any_error
            self._last_flush_count = sent
        else:
            self._last_flush_at = time.time()
            self._last_flush_count = sent
            self._last_error = None
        return len(obs)

    def _rebuffer(self, obs: List[Observation], coverage: List[CoverageRow]) -> None:
        """Return a failed chunk's rows to the aggregators for the next flush.

        Best-effort: re-buffering must never raise out of the flush path, so a
        secondary failure here is swallowed (the data is lost only in that
        already-degraded case, never on the happy path).
        """
        try:
            for o in obs:
                self._agg.add(o.src, o.dst, kind=o.kind, weight=o.observed)
            if self._coverage is not None:
                for r in coverage:
                    self._coverage.add(r.test, r.entity, weight=r.weight)
        except Exception as e:  # pragma: no cover - defensive
            log.debug("hayven-trace re-buffer failed: %s", e)

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    @property
    def last_flush_count(self) -> int:
        return self._last_flush_count

    # ----- internals -----

    def _encode(
        self,
        observations: List[Observation],
        coverage: Optional[List[CoverageRow]] = None,
    ) -> bytes:
        # Send both the raw sample count (`observed`) and the scaled estimate
        # (`weight = observed * sample_rate`). The daemon verifies the
        # conversion against the envelope-level `sample_rate` and rejects
        # mismatched payloads. See PRD §4.6 / §9.
        body = {
            "source": self._source,
            "sample_rate": self._sample_rate,
            "observations": [
                {
                    "src": o.src,
                    "dst": o.dst,
                    "ts": o.ts,
                    "observed": o.observed,
                    "weight": o.observed * self._sample_rate,
                    "kind": o.kind,
                }
                for o in observations
            ],
        }
        # Additive per-test coverage. `observations` (the global graph) is
        # UNCHANGED. The daemon's /api/traces/observations accepts this field
        # additively; older payloads without it still validate. Wire contract:
        # `test`/`entity` are non-empty raw runtime names, `weight` a
        # non-negative int. We omit the key entirely when there is nothing to
        # report so edge-only batches stay byte-identical to the legacy shape.
        if coverage:
            body["test_coverage"] = [
                {"test": r.test, "entity": r.entity, "weight": r.weight}
                for r in coverage
            ]
        return json.dumps(body, separators=(",", ":")).encode("utf-8")

    def _default_sender(self, url: str, payload: bytes) -> None:
        req = urllib.request.Request(
            url,
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json", "User-Agent": "hayven-trace/0.0.4"},
        )
        # Bound the network call so a broken daemon never stalls user code.
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            # Drain and discard.
            resp.read(0)

    def _run(self) -> None:
        # Sleep in short chunks so stop() is responsive.
        while not self._stop.is_set():
            woken = self._stop.wait(timeout=self._interval)
            if woken:
                break
            try:
                self.flush_once()
            except Exception as e:  # pragma: no cover - belt and suspenders
                self._last_error = f"{type(e).__name__}: {e}"
                log.debug("hayven-trace background flush errored: %s", self._last_error)
