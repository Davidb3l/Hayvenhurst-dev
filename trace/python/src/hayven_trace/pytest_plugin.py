"""Pytest plugin that auto-starts the tracer for a test session.

Activated by either:

    pytest -p hayven_trace ...           # explicit
    HAYVEN_TRACE=1 pytest ...            # env-var opt-in

Configuration knobs read from environment so users don't have to write a
conftest:

    HAYVEN_TRACE_URL          daemon base url (default http://localhost:7777)
    HAYVEN_TRACE_RATE         sample rate, 1-in-N (default 100)
    HAYVEN_TRACE_INTERVAL     flush interval seconds (default 30)
    HAYVEN_TRACE_PROJECT      colon-separated path prefixes to include
    HAYVEN_TRACE_INCLUDE_STDLIB  set to "1" to include stdlib frames

The plugin is also registered as a pytest entry-point in pyproject.toml
under ``project.entry-points.pytest11``, so `pip install hayven-trace` is
all a user needs to opt in via ``HAYVEN_TRACE=1``.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Iterable, Optional

from .tracer import is_active, start, stop

if TYPE_CHECKING:  # pragma: no cover
    import pytest


def _split_paths(raw: str) -> Iterable[str]:
    for p in raw.split(os.pathsep):
        p = p.strip()
        if p:
            yield p


def _enabled() -> bool:
    return os.environ.get("HAYVEN_TRACE", "").strip() in ("1", "true", "yes", "on")


def pytest_addoption(parser: "pytest.Parser") -> None:  # pragma: no cover - pytest API
    g = parser.getgroup("hayven-trace")
    g.addoption(
        "--hayven-trace",
        action="store_true",
        default=False,
        help="Enable the Hayvenhurst trace collector for this run.",
    )
    g.addoption(
        "--hayven-trace-url",
        default=None,
        help="Daemon URL (default $HAYVEN_TRACE_URL or http://localhost:7777).",
    )
    g.addoption(
        "--hayven-trace-rate",
        default=None,
        type=int,
        help="Sample rate (1-in-N). Default 100 or $HAYVEN_TRACE_RATE.",
    )


def pytest_configure(config: "pytest.Config") -> None:
    """Start the tracer if env-var or CLI flag asks us to."""
    cli_enabled = bool(config.getoption("--hayven-trace", default=False))
    if not (cli_enabled or _enabled()):
        return
    if is_active():
        return
    url: Optional[str] = config.getoption("--hayven-trace-url", default=None) or os.environ.get(
        "HAYVEN_TRACE_URL", "http://localhost:7777"
    )
    rate: Optional[int] = config.getoption("--hayven-trace-rate", default=None)
    if rate is None:
        try:
            rate = int(os.environ.get("HAYVEN_TRACE_RATE", "100"))
        except ValueError:
            rate = 100
    interval = float(os.environ.get("HAYVEN_TRACE_INTERVAL", "30") or "30")
    project_paths = list(_split_paths(os.environ.get("HAYVEN_TRACE_PROJECT", "")))
    include_stdlib = os.environ.get("HAYVEN_TRACE_INCLUDE_STDLIB", "").strip() in ("1", "true", "yes", "on")
    start(
        daemon_url=url or "http://localhost:7777",
        sample_rate=rate or 100,
        flush_interval_seconds=interval,
        project_paths=project_paths or None,
        include_stdlib=include_stdlib,
    )
    # Report intent in the header so it's visible in test output.
    config._hayven_trace_started = True  # type: ignore[attr-defined]


def pytest_report_header(config: "pytest.Config") -> Optional[str]:
    if getattr(config, "_hayven_trace_started", False):
        return f"hayven-trace: enabled (sample 1-in-{os.environ.get('HAYVEN_TRACE_RATE', '100')})"
    return None


def pytest_unconfigure(config: "pytest.Config") -> None:
    if getattr(config, "_hayven_trace_started", False):
        stop()
