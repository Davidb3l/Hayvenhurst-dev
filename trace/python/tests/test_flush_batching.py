"""Regression tests for the batched flush (the full-suite data-loss bug).

THE BUG these guard: the per-test coverage collector lost data on a full test
suite. The flush POSTed the whole accumulated payload (thousands of
observations + coverage rows = multi-MB JSON) in ONE request under a 2 s
timeout; on a large run that POST raised, the exception was swallowed at
``flush_once``, and because the aggregators had ALREADY been ``drain()``-ed the
data was gone — silently. A second bug discarded drained coverage whenever
there happened to be no new observations (the early ``return 0``).

The fix splits every flush into bounded chunks of ``FLUSH_BATCH_SIZE`` rows,
sends each in its own request, and never drops the rest of a flush when one
chunk fails. These tests prove all four properties on the wire using the same
capturing-sender pattern as ``test_coverage.py``.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Tuple

from hayven_trace.aggregator import Aggregator, CoverageAggregator
from hayven_trace.flusher import FLUSH_BATCH_SIZE, Flusher


class _CapturingSender:
    """Sender that captures every POST body so tests can inspect them whole.

    Mirrors ``tests/test_coverage.py::_CapturingSender`` (the established
    pattern) but adds observation-side accessors for the batching assertions.
    """

    def __init__(self) -> None:
        self.bodies: List[Dict[str, Any]] = []

    def __call__(self, url: str, payload: bytes) -> None:
        self.bodies.append(json.loads(payload.decode("utf-8")))

    def all_observations(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for b in self.bodies:
            out.extend(b.get("observations", []))
        return out

    def observed_edges(self) -> set[Tuple[str, str]]:
        return {(o["src"], o["dst"]) for o in self.all_observations()}

    def coverage_cells(self) -> set[Tuple[str, str]]:
        cells: set[Tuple[str, str]] = set()
        for b in self.bodies:
            for r in b.get("test_coverage", []):
                cells.add((r["test"], r["entity"]))
        return cells


class _FlakyOnceSender(_CapturingSender):
    """Raises on the FIRST send, succeeds (and captures) thereafter.

    Proves a failed chunk does not prevent later chunks from being sent.
    """

    def __init__(self) -> None:
        super().__init__()
        self.attempts = 0
        self.failed_once = False

    def __call__(self, url: str, payload: bytes) -> None:
        self.attempts += 1
        if self.attempts == 1:
            self.failed_once = True
            raise ConnectionResetError("first chunk dropped")
        super().__call__(url, payload)


def _make_flusher(sender, **kw) -> Tuple[Aggregator, CoverageAggregator, Flusher]:
    agg = Aggregator()
    cov = CoverageAggregator()
    f = Flusher(
        agg,
        daemon_url="http://daemon",
        sample_rate=kw.pop("sample_rate", 1),
        sender=sender,
        coverage=cov,
        interval_seconds=600,
        **kw,
    )
    return agg, cov, f


def test_payload_larger_than_batch_is_split_across_multiple_posts() -> None:
    """The headline regression guard for the data-loss bug.

    A set LARGER than ``FLUSH_BATCH_SIZE`` must be sent across MULTIPLE POSTs,
    and the UNION of all sent rows must equal the full set — nothing dropped.
    """
    n = FLUSH_BATCH_SIZE * 2 + 7  # >2 full batches + a partial → at least 3 chunks
    agg, cov, f = _make_flusher(_CapturingSender())
    cap: _CapturingSender = f._sender  # type: ignore[assignment]

    expected_edges = set()
    expected_cells = set()
    for i in range(n):
        src, dst = f"mod:caller_{i}", f"mod:callee_{i}"
        agg.add(src, dst)
        expected_edges.add((src, dst))
        test, entity = f"t:test_{i}", f"e:entity_{i}"
        cov.add(test, entity)
        expected_cells.add((test, entity))

    drained = f.flush_once()
    assert drained == n

    # Bounded per request: no single POST exceeds the batch size on either side.
    assert len(cap.bodies) >= 3, len(cap.bodies)
    for b in cap.bodies:
        assert len(b.get("observations", [])) <= FLUSH_BATCH_SIZE
        assert len(b.get("test_coverage", [])) <= FLUSH_BATCH_SIZE

    # The union of everything sent equals the full set — NOTHING dropped.
    assert cap.observed_edges() == expected_edges
    assert cap.coverage_cells() == expected_cells
    assert len(cap.all_observations()) == n


def test_one_failing_chunk_does_not_drop_the_rest() -> None:
    """A chunk whose send raises must not prevent the remaining chunks from
    being sent (no total loss on one failure)."""
    n = FLUSH_BATCH_SIZE * 3  # exactly 3 observation chunks
    agg, cov, f = _make_flusher(_FlakyOnceSender())
    cap: _FlakyOnceSender = f._sender  # type: ignore[assignment]

    expected_edges = set()
    for i in range(n):
        src, dst = f"mod:caller_{i}", f"mod:callee_{i}"
        agg.add(src, dst)
        expected_edges.add((src, dst))

    f.flush_once()
    assert cap.failed_once, "the injected sender should have raised once"
    # The failed chunk was re-buffered, so it's NOT in the first flush's bodies...
    sent_after_first = cap.observed_edges()
    assert sent_after_first != expected_edges
    assert len(sent_after_first) == n - FLUSH_BATCH_SIZE  # 2 of 3 chunks landed
    # ...but a healthy error was recorded (no silent success).
    assert f.last_error is not None and "ConnectionResetError" in f.last_error

    # The re-buffered chunk ships on the next flush → union is now complete.
    f.flush_once()
    assert cap.observed_edges() == expected_edges, "re-buffered chunk must resend"


def test_coverage_is_not_discarded_when_there_are_no_observations() -> None:
    """The early-return bug: coverage drained but never sent because ``obs`` was
    empty. Coverage-only flushes must still POST (with an empty observations
    array, which the daemon route accepts)."""
    agg, cov, f = _make_flusher(_CapturingSender())
    cap: _CapturingSender = f._sender  # type: ignore[assignment]

    # No observations at all — only coverage.
    cov.add("t:test_x", "e:entity_x")
    cov.add("t:test_y", "e:entity_y")

    f.flush_once()

    assert cap.bodies, "coverage-only flush must still POST"
    assert cap.coverage_cells() == {
        ("t:test_x", "e:entity_x"),
        ("t:test_y", "e:entity_y"),
    }
    # Every coverage-only body still carries `observations` as an (empty) array,
    # so the daemon route (which requires an `observations` array) accepts it.
    for b in cap.bodies:
        assert "observations" in b
        assert isinstance(b["observations"], list)


def test_shutdown_flush_drains_everything_remaining() -> None:
    """``stop()`` must drain BOTH aggregators completely, in batches."""
    n = FLUSH_BATCH_SIZE + 250  # 2 chunks, forces batching on the final flush
    agg, cov, f = _make_flusher(_CapturingSender())
    cap: _CapturingSender = f._sender  # type: ignore[assignment]

    expected_edges = set()
    expected_cells = set()
    for i in range(n):
        src, dst = f"mod:caller_{i}", f"mod:callee_{i}"
        agg.add(src, dst)
        expected_edges.add((src, dst))
        test, entity = f"t:test_{i}", f"e:entity_{i}"
        cov.add(test, entity)
        expected_cells.add((test, entity))

    # The background thread never started; stop(flush=True) is the shutdown flush.
    f.stop(flush=True)

    assert agg.size() == 0, "observations aggregator must be empty after stop"
    assert cov.size() == 0, "coverage aggregator must be empty after stop"
    assert cap.observed_edges() == expected_edges
    assert cap.coverage_cells() == expected_cells


def test_partial_failure_during_shutdown_keeps_data_buffered() -> None:
    """If a chunk fails during the shutdown flush, the rest still ship and the
    failed rows stay buffered (not silently dropped)."""
    n = FLUSH_BATCH_SIZE * 2
    agg, cov, f = _make_flusher(_FlakyOnceSender())
    cap: _FlakyOnceSender = f._sender  # type: ignore[assignment]

    for i in range(n):
        agg.add(f"mod:caller_{i}", f"mod:callee_{i}")

    f.stop(flush=True)

    # One chunk failed and was re-buffered; the other shipped. The buffered rows
    # are NOT lost — they remain in the aggregator for a later flush.
    assert cap.failed_once
    sent = len(cap.all_observations())
    buffered = agg.size()
    assert sent + buffered == n, (sent, buffered)
    assert buffered > 0, "failed chunk must remain buffered, never dropped"
