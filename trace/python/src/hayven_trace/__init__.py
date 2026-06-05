"""Hayven runtime trace collector for Python.

Public surface:

    >>> import hayven_trace
    >>> hayven_trace.start(daemon_url="http://localhost:7777", sample_rate=100)
    >>> # ... user code runs ...
    >>> hayven_trace.stop()

Or via the pytest plugin:

    pytest -p hayven_trace ...
    HAYVEN_TRACE=1 pytest ...

Design notes (see PRD §9):

* Hooks ``sys.settrace`` (with ``threading.settrace`` for new threads).
* Captures only the **structure** of execution — caller → callee — never
  argument values or return values.
* Aggregates observations in-process; flushes to the daemon every 30s.
* Sample rate is "1 in N" — at the default of 100 we observe ~1% of calls,
  which keeps overhead under 2% on the typical test suite.
"""

from .tracer import (
    HayvenTracer,
    TraceConfig,
    is_active,
    start,
    stop,
)

__all__ = [
    "HayvenTracer",
    "TraceConfig",
    "is_active",
    "start",
    "stop",
]

__version__ = "0.0.4"
