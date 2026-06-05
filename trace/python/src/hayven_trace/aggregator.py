"""In-process aggregation of (src, dst) call observations.

The aggregator is the only piece of state that the trace hot path touches
besides the sample counter. It must be cheap to update — a dict[bytes, int]
keyed by a packed (src, dst) tuple is currently the simplest fast option.

Concurrency: the trace callback runs on whatever thread is executing user
code. We take a coarse lock around aggregation writes; flush also grabs it
to atomically swap counters. Contention is bounded because we only write
on sampled frames (1 in N).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, NamedTuple, Tuple


@dataclass(frozen=True)
class CallKey:
    """Identifies an observed edge in the call graph.

    `src` and `dst` are stable node-id strings derived from
    ``"<module>:<qualname>"``. The daemon resolves these to graph nodes.
    """

    src: str
    dst: str
    kind: str = "call"


@dataclass
class Observation:
    """A flush-ready observation: src → dst, ts, raw sample count.

    Only ``observed`` (the raw sampled count) is carried at the aggregator
    layer. ``weight`` — the scaled estimate of total invocations — is added
    by the flusher when it builds the wire payload, because only the flusher
    knows the sample rate that the daemon will use to verify the conversion
    (PRD §4.6 vertical-integration discipline: send both the ground truth and
    the convenience value, no hidden scaling).
    """

    src: str
    dst: str
    ts: int
    observed: int
    kind: str = "call"

    def to_dict(self) -> Dict[str, object]:
        return {
            "src": self.src,
            "dst": self.dst,
            "ts": self.ts,
            "observed": self.observed,
            "kind": self.kind,
        }


@dataclass
class Aggregator:
    """Accumulates call counts in memory, flushed atomically by `drain()`."""

    counts: Dict[CallKey, int] = field(default_factory=dict)
    started_at: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def add(self, src: str, dst: str, kind: str = "call", weight: int = 1) -> None:
        """Record a single sampled call edge."""
        k = CallKey(src=src, dst=dst, kind=kind)
        with self.lock:
            self.counts[k] = self.counts.get(k, 0) + weight

    def add_many(self, edges: Iterable[Tuple[str, str]]) -> None:
        with self.lock:
            for src, dst in edges:
                k = CallKey(src=src, dst=dst)
                self.counts[k] = self.counts.get(k, 0) + 1

    def size(self) -> int:
        with self.lock:
            return len(self.counts)

    def drain(self) -> List[Observation]:
        """Atomically return all aggregated observations and reset state.

        Returned observations carry the current Unix timestamp as ``ts`` and
        the raw sample count as ``observed``. Sample-rate scaling is applied
        downstream by the flusher.
        """
        ts = int(time.time())
        with self.lock:
            counts = self.counts
            self.counts = {}
        return [Observation(src=k.src, dst=k.dst, ts=ts, observed=w, kind=k.kind) for k, w in counts.items()]


class CoverageKey(NamedTuple):
    """Identifies a (test, entity) coverage cell.

    Both fields are raw runtime node-ids (``"<module>:<qualname>"``). ``test``
    is the SELECTOR — the root-test context that was active — and ``entity`` is
    a symbol that test actually executed. Kept separate from :class:`CallKey`
    because coverage is a *per-test* multiset, not an edge: the global call
    graph (edges) is unchanged by this feature; coverage is purely additive so
    the daemon can answer "which tests truly touched X" without reverse-walking
    a shared hub (e.g. ``CliRunner.invoke``) that links ~every test to ~every
    symbol.
    """

    test: str
    entity: str


class CoverageRow(NamedTuple):
    """A flush-ready per-test coverage cell: (test, entity, weight)."""

    test: str
    entity: str
    weight: int


@dataclass
class CoverageAggregator:
    """Accumulates, per root-test, the multiset of entities that test ran.

    Lifecycle mirrors :class:`Aggregator` exactly: cheap thread-safe
    increments on the hot path, atomic ``drain()`` that resets state so the
    flusher clears coverage on the same cadence as the edge aggregate. We use
    a flat ``Dict[CoverageKey, int]`` rather than a nested
    ``Dict[test, Counter]`` so the drain is a single dict swap (no per-test
    Counter copying) and the wire row shape falls straight out of the items.
    """

    counts: Dict[CoverageKey, int] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def add(self, test: str, entity: str, weight: int = 1) -> None:
        """Increment coverage of ``entity`` under the root-test ``test``."""
        k = CoverageKey(test=test, entity=entity)
        with self.lock:
            self.counts[k] = self.counts.get(k, 0) + weight

    def size(self) -> int:
        with self.lock:
            return len(self.counts)

    def drain(self) -> List[CoverageRow]:
        """Atomically return all (test, entity, weight) rows and reset.

        One row per distinct (test, entity) pair; ``weight`` is the accumulated
        count. Called by the flusher on the same lifecycle as the edge drain so
        the coverage map is cleared after a successful flush.
        """
        with self.lock:
            counts = self.counts
            self.counts = {}
        return [CoverageRow(test=k.test, entity=k.entity, weight=w) for k, w in counts.items()]
