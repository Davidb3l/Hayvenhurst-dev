"""Per-test coverage tests.

These exercise the real sys.settrace pathway end-to-end: a ``test_*``-named
*driver* (which the tracer's NAME-based detector recognises as the root-test
SELECTOR) calls "production" entities in the ``coverage_fixtures`` package, and
we assert the accumulated per-test coverage + the flushed ``test_coverage`` wire
array.

Detection is by FUNCTION NAME, not file path: the runtime selector must be the
actual test, so a non-test helper/callback — even one defined inside a test file
— is NOT a context and cannot steal attribution (this is what keeps click-style
``def cmd(): ...; runner.invoke(cmd)`` callbacks from being mis-recorded as the
"test"). The fixtures live in ``coverage_fixtures/`` purely for tidy imports;
their names (``root_a``/``mid_a``/``leaf_a``) are non-test, so they'd never be a
context regardless of location.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Tuple

# Make the off-tests fixtures package importable: its parent is trace/python.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PKG_ROOT = os.path.normpath(os.path.join(_HERE, ".."))
if _PKG_ROOT not in sys.path:
    sys.path.insert(0, _PKG_ROOT)

from hayven_trace.aggregator import Aggregator, CoverageAggregator  # noqa: E402
from hayven_trace.flusher import Flusher  # noqa: E402
from hayven_trace.tracer import HayvenTracer, TraceConfig  # noqa: E402

import coverage_fixtures.entities as ent  # noqa: E402

_FIXTURES_DIR = os.path.dirname(os.path.abspath(ent.__file__))


class _CapturingSender:
    """Sender that captures every POST body so tests can inspect it whole."""

    def __init__(self) -> None:
        self.bodies: List[Dict[str, Any]] = []

    def __call__(self, url: str, payload: bytes) -> None:
        self.bodies.append(json.loads(payload.decode("utf-8")))

    def merged_coverage(self) -> Dict[Tuple[str, str], int]:
        """All test_coverage rows across every captured body, summed."""
        out: Dict[Tuple[str, str], int] = {}
        for b in self.bodies:
            for r in b.get("test_coverage", []):
                key = (r["test"], r["entity"])
                out[key] = out.get(key, 0) + r["weight"]
        return out

    def edges(self) -> List[Tuple[str, str]]:
        """Every (src, dst) edge across all captured observation arrays.

        Used to prove edges stay SAMPLED while coverage stays COMPLETE: under a
        sample_rate > 1 the edge list is thinned, so a high-volume driver yields
        far fewer edge rows than its raw call count, while its coverage still
        names every entity it touched."""
        out: List[Tuple[str, str]] = []
        for b in self.bodies:
            for o in b.get("observations", []):
                out.append((o["src"], o["dst"]))
        return out

    def observed_for(self, dst_suffix: str) -> int:
        """Summed raw ``observed`` sample count for edges into the given dst.

        This is the SAMPLED quantity: at sample_rate N it should be roughly 1/N
        of the true number of calls into that entity — the proof that edges (the
        estimate) are still gated even though coverage (ground truth) is not."""
        total = 0
        for b in self.bodies:
            for o in b.get("observations", []):
                if o["dst"].endswith(dst_suffix):
                    total += o["observed"]
        return total

    def coverage_for(self, test_suffix: str) -> set[str]:
        """Set of entity ids covered by the test whose id ends with the given
        ``module:qualname`` suffix. Suffix-match keeps assertions independent of
        the absolute module path."""
        entities: set[str] = set()
        for (test, entity), _w in self.merged_coverage().items():
            if test.endswith(test_suffix):
                entities.add(entity)
        return entities


def _make_tracer(sample_rate: int = 1) -> Tuple[HayvenTracer, _CapturingSender]:
    """Tracer wired to a capturing sender, tracing BOTH the tests dir (so the
    test-driver frames are observed) and the fixtures dir (so entity calls are
    observed). Long flush interval → the only flush is the shutdown flush."""
    cfg = TraceConfig(
        daemon_url="http://daemon",
        sample_rate=sample_rate,
        flush_interval_seconds=600,
        project_paths=(_HERE, _FIXTURES_DIR),
    )
    agg = Aggregator()
    cov = CoverageAggregator()
    cap = _CapturingSender()
    f = Flusher(
        agg,
        daemon_url=cfg.daemon_url,
        interval_seconds=cfg.flush_interval_seconds,
        sample_rate=sample_rate,
        sender=cap,
        coverage=cov,
    )
    return HayvenTracer(cfg, aggregator=agg, flusher=f, coverage=cov), cap


# --- Driver tests run UNDER the tracer. Their frames are the SELECTOR. ---
# Named ``test_*`` so the tracer's NAME-based root-test detector recognises them
# as the coverage context (the runtime selector is strict: a real test function,
# not merely any function in a test file — a command callback defined inside a
# test must NOT steal attribution). pytest also collects these standalone; they
# assert nothing and return None, so that bare run is a harmless no-op.

def test_alpha_driver() -> None:
    # Runs root_a -> mid_a -> leaf_a (x2).
    ent.root_a()


def test_beta_driver() -> None:
    # Runs root_b -> mid_b -> leaf_b (x2). Disjoint subtree from alpha.
    ent.root_b()


def test_fanout_driver() -> None:
    # Runs fan_root -> {fan_one, fan_two, fan_three} many times (high call
    # volume) so sampling visibly thins the EDGE aggregate while coverage of
    # each distinct fan_* entity must remain COMPLETE.
    ent.fan_root()


def test_coverage_attributes_executed_entities_to_the_test() -> None:
    t, cap = _make_tracer(sample_rate=1)
    t.install()
    try:
        test_alpha_driver()
    finally:
        t.uninstall()

    covered = cap.coverage_for("test_coverage:test_alpha_driver")
    # The entities alpha actually executed must appear...
    assert any(e.endswith(":root_a") for e in covered), covered
    assert any(e.endswith(":mid_a") for e in covered), covered
    assert any(e.endswith(":leaf_a") for e in covered), covered
    # ...and entities from the OTHER subtree must NOT.
    assert not any(e.endswith(":leaf_b") for e in covered), covered
    assert not any(e.endswith(":mid_b") for e in covered), covered


def test_two_tests_have_disjoint_coverage_where_expected() -> None:
    """Run two distinct test funcs under one tracer; assert their coverage does
    not bleed: alpha's leaf_a-subtree and beta's leaf_b-subtree stay separate."""
    t, cap = _make_tracer(sample_rate=1)
    t.install()
    try:
        test_alpha_driver()
        test_beta_driver()
    finally:
        t.uninstall()

    alpha = cap.coverage_for("test_coverage:test_alpha_driver")
    beta = cap.coverage_for("test_coverage:test_beta_driver")

    assert any(e.endswith(":leaf_a") for e in alpha)
    assert any(e.endswith(":leaf_b") for e in beta)
    # The selector keys themselves differ, and the leaf_a/leaf_b worlds do not
    # cross-contaminate.
    assert not any(e.endswith(":leaf_b") for e in alpha), alpha
    assert not any(e.endswith(":leaf_a") for e in beta), beta


def test_context_stack_pops_and_does_not_bleed() -> None:
    """After each test driver returns, the context stack must be empty again,
    and a sequential driver must not inherit the previous one's context."""
    t, _cap = _make_tracer(sample_rate=1)
    t.install()
    try:
        assert t.current_test_context() is None
        test_alpha_driver()
        # alpha returned -> its frame popped -> stack empty.
        assert t.current_test_context() is None
        test_beta_driver()
        assert t.current_test_context() is None
    finally:
        t.uninstall()


def test_nested_test_to_helper_to_helper_attributes_to_root_test() -> None:
    """A test -> mid_a -> leaf_a chain attributes the deep callees to the ROOT
    test, since helpers are not test frames and so never become the context."""
    t, cap = _make_tracer(sample_rate=1)
    t.install()
    try:
        test_alpha_driver()
    finally:
        t.uninstall()

    merged = cap.merged_coverage()
    # leaf_a is two levels below the test (test -> root_a -> mid_a -> leaf_a)
    # yet still keyed under the root test context.
    leaf_rows = [
        (test, entity)
        for (test, entity) in merged
        if entity.endswith(":leaf_a")
    ]
    assert leaf_rows, merged
    for test, _entity in leaf_rows:
        assert test.endswith("test_coverage:test_alpha_driver"), test


def test_flush_body_has_well_formed_coverage_and_unchanged_observations() -> None:
    t, cap = _make_tracer(sample_rate=1)
    t.install()
    try:
        test_alpha_driver()
    finally:
        t.uninstall()  # shutdown flush

    assert cap.bodies, "expected at least one flushed body"
    body = next(b for b in cap.bodies if b.get("test_coverage"))

    # The global graph is still present and unchanged in shape.
    assert "observations" in body
    assert isinstance(body["observations"], list)
    assert body["observations"], "edges should still be recorded"
    for o in body["observations"]:
        assert set(o.keys()) == {"src", "dst", "ts", "observed", "weight", "kind"}

    # The additive coverage array is well-formed per the daemon's wire contract.
    cov = body["test_coverage"]
    assert isinstance(cov, list) and cov
    for r in cov:
        assert set(r.keys()) == {"test", "entity", "weight"}
        assert isinstance(r["test"], str) and r["test"]
        assert isinstance(r["entity"], str) and r["entity"]
        assert isinstance(r["weight"], int) and r["weight"] >= 1
        # Raw runtime names are "<module>:<qualname>".
        assert ":" in r["test"]
        assert ":" in r["entity"]


def test_coverage_is_complete_under_sampling_while_edges_stay_sampled() -> None:
    """The core decoupling guarantee: at sample_rate > 1, per-test COVERAGE is
    COMPLETE (every executed (test, entity) pair present — NOT thinned by the
    sample gate), while the edge AGGREGATE is correspondingly SPARSER (sampling
    still applies to edges, the estimate).

    Regression target: previously coverage rode behind the sample gate, so at
    sample_rate=10 a symbol executed only on un-sampled calls vanished from its
    test's coverage and recall collapsed. The driver below executes each fan_*
    entity 40 times, so under sampling NONE of them is guaranteed a sampled
    call individually — yet all must still appear in coverage."""
    sample_rate = 10
    t, cap = _make_tracer(sample_rate=sample_rate)
    t.install()
    try:
        test_fanout_driver()
    finally:
        t.uninstall()  # shutdown flush

    # (a) COVERAGE IS COMPLETE: every entity the driver executed appears under
    # the fan-out test, regardless of the sample rate. The driver itself is the
    # SELECTOR (not a covered entity); the covered set is the fan_* callees plus
    # the fan_root intermediate caller.
    covered = cap.coverage_for("test_coverage:test_fanout_driver")
    for name in (":fan_one", ":fan_two", ":fan_three", ":fan_root"):
        assert any(e.endswith(name) for e in covered), (name, covered)

    # The drained coverage multiset must include EVERY executed (test, entity)
    # pair — i.e. the per-entity coverage row exists even though, at
    # sample_rate=10, most of that entity's calls were never sampled.
    merged = cap.merged_coverage()
    fan_pairs = {
        (test, entity)
        for (test, entity) in merged
        if test.endswith("test_coverage:test_fanout_driver")
        and any(entity.endswith(n) for n in (":fan_one", ":fan_two", ":fan_three"))
    }
    assert len(fan_pairs) == 3, merged  # all three distinct fan_* leaves present

    # (b) EDGES STAY SAMPLED: the raw observed count of calls into a fan_* leaf
    # is far below the 40 true calls — the sample gate thinned the edge
    # aggregate (~1/sample_rate). This is the half that is INTENDED to be
    # sampled, in contrast to the complete coverage above.
    observed_one = cap.observed_for(":fan_one")
    # 40 true calls at sample_rate=10 → on the order of a handful of sampled
    # edges; strictly fewer than the true call count proves the gate still bites.
    assert observed_one < 40, observed_one
    # And sampling did not somehow drop the edge entirely (the graph is still an
    # estimate, just sparser) — at least one sampled call landed across the run.
    assert cap.edges(), "expected some sampled edges to be recorded"


def test_non_test_entry_point_records_edges_but_no_coverage() -> None:
    """Calling a non-test entity directly (no test on the stack) must still
    record call edges but produce ZERO coverage rows (context is None)."""
    t, cap = _make_tracer(sample_rate=1)
    t.install()
    try:
        # ent.root_a is NOT a test (qualname `root_a`, path off the tests tree).
        ent.root_a()
        assert t.current_test_context() is None
    finally:
        t.uninstall()

    # Edges were recorded...
    all_obs = [o for b in cap.bodies for o in b.get("observations", [])]
    assert any(o["dst"].endswith(":root_a") for o in all_obs), all_obs
    # ...but no coverage rows at all.
    for b in cap.bodies:
        assert b.get("test_coverage", []) == [], b.get("test_coverage")
