"""Aggregator unit tests."""

from __future__ import annotations

import threading

from hayven_trace.aggregator import Aggregator


def test_add_single_edge() -> None:
    a = Aggregator()
    a.add("mod:foo", "mod:bar")
    a.add("mod:foo", "mod:bar")
    a.add("mod:foo", "mod:baz")
    obs = a.drain()
    edges = {(o.src, o.dst): o.observed for o in obs}
    assert edges[("mod:foo", "mod:bar")] == 2
    assert edges[("mod:foo", "mod:baz")] == 1


def test_drain_resets_state() -> None:
    a = Aggregator()
    a.add("a", "b")
    a.drain()
    assert a.size() == 0
    a.add("a", "b")
    assert a.size() == 1


def test_observation_to_dict_shape() -> None:
    a = Aggregator()
    a.add("mod:caller", "mod:callee")
    obs = a.drain()
    assert len(obs) == 1
    d = obs[0].to_dict()
    # The aggregator-layer dict carries `observed` (raw sample count). The
    # scaled `weight` is added by the flusher when it builds the wire payload.
    assert set(d.keys()) == {"src", "dst", "ts", "observed", "kind"}
    assert d["src"] == "mod:caller"
    assert d["dst"] == "mod:callee"
    assert d["kind"] == "call"
    assert d["observed"] == 1
    assert isinstance(d["ts"], int)


def test_concurrent_adds_are_consistent() -> None:
    a = Aggregator()
    THREADS = 8
    PER = 5000
    barrier = threading.Barrier(THREADS)

    def hammer() -> None:
        barrier.wait()
        for i in range(PER):
            a.add("src", f"dst{i % 4}")

    threads = [threading.Thread(target=hammer) for _ in range(THREADS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    obs = a.drain()
    total = sum(o.observed for o in obs)
    assert total == THREADS * PER
    # 4 distinct dsts.
    assert len({(o.src, o.dst) for o in obs}) == 4


def test_add_many_helper() -> None:
    a = Aggregator()
    a.add_many([("x", "y"), ("x", "y"), ("x", "z")])
    obs = {(o.src, o.dst): o.observed for o in a.drain()}
    assert obs[("x", "y")] == 2
    assert obs[("x", "z")] == 1
