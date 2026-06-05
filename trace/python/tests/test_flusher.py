"""Flusher unit tests using an injected sender (no network)."""

from __future__ import annotations

import json
import threading
import time
from typing import List, Optional, Tuple

from hayven_trace.aggregator import Aggregator
from hayven_trace.flusher import Flusher


class _FakeSender:
    def __init__(self) -> None:
        self.calls: List[Tuple[str, bytes]] = []
        self.lock = threading.Lock()
        self.error: Optional[Exception] = None

    def __call__(self, url: str, payload: bytes) -> None:
        with self.lock:
            if self.error is not None:
                raise self.error
            self.calls.append((url, payload))


def test_flush_once_with_observations() -> None:
    agg = Aggregator()
    agg.add("a", "b")
    agg.add("a", "b")
    agg.add("a", "c")
    fake = _FakeSender()
    f = Flusher(agg, daemon_url="http://daemon", sample_rate=10, sender=fake)

    n = f.flush_once()
    assert n == 2  # two distinct edges
    assert len(fake.calls) == 1
    url, payload = fake.calls[0]
    assert url == "http://daemon/api/traces/observations"

    body = json.loads(payload.decode("utf-8"))
    assert body["source"] == "python"
    assert body["sample_rate"] == 10
    # Wire format carries both ground-truth `observed` and scaled `weight`
    # so the daemon can verify the conversion (PRD §4.6).
    by_edge = {(o["src"], o["dst"]): o for o in body["observations"]}
    ab = by_edge[("a", "b")]
    assert ab["observed"] == 2
    assert ab["weight"] == 2 * 10
    ac = by_edge[("a", "c")]
    assert ac["observed"] == 1
    assert ac["weight"] == 1 * 10

    # Drained — second flush is a no-op.
    assert f.flush_once() == 0


def test_flush_once_swallows_sender_errors() -> None:
    agg = Aggregator()
    agg.add("x", "y")
    fake = _FakeSender()
    fake.error = ConnectionRefusedError("daemon down")
    f = Flusher(agg, daemon_url="http://daemon", sender=fake)

    # Must not raise into user code.
    n = f.flush_once()
    assert n == 1  # we drained it
    assert f.last_error is not None
    assert "ConnectionRefusedError" in f.last_error


def test_background_flusher_drains_periodically() -> None:
    agg = Aggregator()
    fake = _FakeSender()
    f = Flusher(agg, daemon_url="http://daemon", interval_seconds=0.05, sender=fake)
    f.start()
    try:
        for _ in range(50):
            agg.add("a", "b")
            time.sleep(0.001)
        time.sleep(0.2)
    finally:
        f.stop(flush=True)

    # At least one network call should have happened.
    assert len(fake.calls) >= 1
    total = 0
    for _, payload in fake.calls:
        body = json.loads(payload.decode("utf-8"))
        for o in body["observations"]:
            if o["src"] == "a" and o["dst"] == "b":
                total += o["weight"]
    # weight is scaled by sample_rate (default 100). 50 sampled calls
    # → 50 * 100 = 5000 reported.
    assert total == 50 * 100


def test_wire_invariant_weight_equals_observed_times_sample_rate() -> None:
    """The daemon enforces `weight == observed * sample_rate` and 400s
    mismatched payloads. Lock the invariant client-side so we never ship a
    bad batch."""
    agg = Aggregator()
    for _ in range(7):
        agg.add("alpha", "beta")
    for _ in range(3):
        agg.add("alpha", "gamma")
    fake = _FakeSender()
    f = Flusher(agg, daemon_url="http://daemon", sample_rate=50, sender=fake)
    f.flush_once()
    assert len(fake.calls) == 1
    body = json.loads(fake.calls[0][1].decode("utf-8"))
    assert body["sample_rate"] == 50
    for o in body["observations"]:
        assert o["weight"] == o["observed"] * body["sample_rate"]


def test_stop_without_flush_does_not_send() -> None:
    agg = Aggregator()
    agg.add("a", "b")
    fake = _FakeSender()
    f = Flusher(agg, daemon_url="http://daemon", interval_seconds=10, sender=fake)
    f.start()
    f.stop(flush=False)
    assert len(fake.calls) == 0
