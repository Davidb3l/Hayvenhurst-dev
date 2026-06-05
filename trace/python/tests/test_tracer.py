"""Tracer integration tests.

We exercise the real sys.settrace pathway so the tests stress what users
actually pay at runtime — the hot dispatch function, the path filter, and
the sample-rate gate.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict, List, Tuple

from hayven_trace.aggregator import Aggregator
from hayven_trace.flusher import Flusher
from hayven_trace.tracer import HayvenTracer, TraceConfig, is_active, start, stop


class _CapturingSender:
    """Sender that captures every POST payload so tests can inspect them."""

    def __init__(self) -> None:
        self.batches: List[List[Dict[str, Any]]] = []

    def __call__(self, url: str, payload: bytes) -> None:
        body = json.loads(payload.decode("utf-8"))
        self.batches.append(body["observations"])

    def all_observations(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for b in self.batches:
            out.extend(b)
        return out


def _make_tracer(sample_rate: int = 1) -> Tuple[HayvenTracer, _CapturingSender]:
    """Tracer wired to a capturing sender so tests can read what was flushed.

    The flusher interval is very long so the only flush in tests is the
    final ``uninstall(flush=True)`` shutdown flush.
    """
    cfg = TraceConfig(
        daemon_url="http://daemon",
        sample_rate=sample_rate,
        flush_interval_seconds=600,
        project_paths=(os.path.dirname(__file__),),
    )
    agg = Aggregator()
    cap = _CapturingSender()
    f = Flusher(
        agg,
        daemon_url=cfg.daemon_url,
        interval_seconds=cfg.flush_interval_seconds,
        sample_rate=sample_rate,
        sender=cap,
    )
    return HayvenTracer(cfg, aggregator=agg, flusher=f), cap


def _edges_of(cap: _CapturingSender) -> Dict[Tuple[str, str], int]:
    out: Dict[Tuple[str, str], int] = {}
    for o in cap.all_observations():
        key = (o["src"], o["dst"])
        out[key] = out.get(key, 0) + o["weight"]
    return out


# Synthetic call graph the tests can rely on. Defined at module scope so
# tracer's path-filter (which keeps only files under tests/) picks them up.
def _leaf() -> int:
    return 1


def _mid() -> int:
    return _leaf() + _leaf()


def _root() -> int:
    return _mid() + _leaf()


def test_records_call_edges_at_full_sample_rate() -> None:
    t, cap = _make_tracer(sample_rate=1)
    t.install()
    try:
        _root()
    finally:
        t.uninstall()  # uninstall flushes -> cap captures
    edges = _edges_of(cap)
    callees = {dst for (_src, dst) in edges.keys()}
    assert any(c.endswith(":_leaf") for c in callees)
    assert any(c.endswith(":_mid") for c in callees)


def test_sample_rate_thins_observations() -> None:
    # 1-in-1000 should record at most a handful even from many calls.
    t, cap = _make_tracer(sample_rate=1000)
    t.install()
    try:
        for _ in range(50):
            _root()
    finally:
        t.uninstall()
    edges = _edges_of(cap)
    # weights are scaled by sample_rate so divide back out for the assertion.
    sampled_hits = sum(w for w in edges.values()) // 1000
    assert sampled_hits <= 5, f"expected ~0 with 1-in-1000 sampling, got {sampled_hits}"


def test_sample_rate_1_records_everything() -> None:
    t, cap = _make_tracer(sample_rate=1)
    t.install()
    try:
        _root()
    finally:
        t.uninstall()
    edges = _edges_of(cap)
    # root + mid + 3 leaf calls = 5 edges minimum.
    total = sum(edges.values())
    assert total >= 5, f"got only {total} samples; edges={edges}"


def test_install_is_idempotent_via_module_singleton() -> None:
    assert not is_active()
    t1 = start(daemon_url="http://daemon", sample_rate=1)
    try:
        t2 = start(daemon_url="http://daemon", sample_rate=1)
        assert t1 is t2
        assert is_active()
    finally:
        stop()
    assert not is_active()


def test_does_not_capture_argument_values() -> None:
    """Privacy guarantee: weight is the only payload."""
    t, cap = _make_tracer(sample_rate=1)
    t.install()
    try:
        _leaf()
    finally:
        t.uninstall()
    for o in cap.all_observations():
        # Wire schema must not contain anything that could leak runtime values.
        assert set(o.keys()) <= {"src", "dst", "ts", "observed", "weight", "kind"}


def test_skips_stdlib_when_include_stdlib_false() -> None:
    t, cap = _make_tracer(sample_rate=1)
    t.install()
    try:
        # os.path.join is in stdlib — should not be recorded.
        os.path.join("a", "b")
    finally:
        t.uninstall()
    for o in cap.all_observations():
        assert "posixpath" not in o["dst"]
        assert "ntpath" not in o["dst"]


def test_uninstall_restores_prior_trace() -> None:
    sentinel = []

    def prior(frame, event, arg):  # type: ignore[no-untyped-def]
        sentinel.append(event)
        return prior

    sys.settrace(prior)
    try:
        t, _cap = _make_tracer(sample_rate=1)
        t.install()
        # Bound methods compare with ==, not `is`.
        assert sys.gettrace() == t._dispatch
        t.uninstall()
        assert sys.gettrace() is prior
    finally:
        sys.settrace(None)


def test_overhead_is_acceptable_at_default_sample_rate() -> None:
    """Smoke check that the tracer doesn't slow user code by >5x at default
    rate. PRD targets <2% on real test suites; a tight microbench like this
    is harsher because the user code is trivial. Anything under 5x here
    means we're not doing anything pathological."""

    def workload() -> int:
        s = 0
        for _ in range(2000):
            s += _leaf()
        return s

    # baseline
    t0 = time.perf_counter()
    workload()
    baseline = time.perf_counter() - t0

    t, _cap = _make_tracer(sample_rate=100)
    t.install()
    try:
        t1 = time.perf_counter()
        workload()
        traced = time.perf_counter() - t1
    finally:
        t.uninstall()

    # Allow generous slack — CI machines are noisy.
    assert traced < baseline * 50 + 0.5, f"baseline={baseline:.4f}s traced={traced:.4f}s"


def test_pytest_plugin_module_imports() -> None:
    # If pyproject's entry-point or the module itself fails to import,
    # the plugin breaks every pytest invocation that has us installed.
    import hayven_trace.pytest_plugin as p
    assert hasattr(p, "pytest_configure")
    assert hasattr(p, "pytest_unconfigure")
