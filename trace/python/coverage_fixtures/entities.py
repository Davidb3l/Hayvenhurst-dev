"""Synthetic non-test entities the coverage tests execute.

Defined at module scope so the tracer (configured with this package on its
``project_paths``) picks them up. Module/qualname runtime ids therefore look
like ``coverage_fixtures.entities:leaf_a`` etc. — none of which the test
detector classifies as a test (neither the qualname nor the path matches),
so they are attributed as COVERED entities under whichever test ran them.
"""

from __future__ import annotations


def leaf_a() -> int:
    return 1


def leaf_b() -> int:
    return 2


def mid_a() -> int:
    """Fan out into leaf_a so a test that calls this covers both."""
    return leaf_a() + leaf_a()


def mid_b() -> int:
    """Disjoint subtree from mid_a — used to prove coverage sets don't bleed."""
    return leaf_b() + leaf_b()


def root_a() -> int:
    return mid_a() + leaf_a()


def root_b() -> int:
    return mid_b()


def fan_one() -> int:
    return 10


def fan_two() -> int:
    return 20


def fan_three() -> int:
    return 30


def fan_root() -> int:
    """Drive MANY call events across SEVERAL distinct entities.

    Used by the completeness-under-sampling test: each ``fan_*`` is a distinct
    covered entity, and the loop generates far more `call` events than the
    sample rate, so the edge aggregate is provably thinned while coverage must
    still list every ``fan_*`` exactly once (coverage is ground truth, not a
    sample). The loop count is comfortably above any sample_rate the test uses.
    """
    total = 0
    for _ in range(40):
        total += fan_one() + fan_two() + fan_three()
    return total
