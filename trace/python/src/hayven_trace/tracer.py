"""sys.settrace-based call observer.

Hot path discipline:

* The trace callback is the single hottest function in the package.
  Everything inside it is either a comparison, an integer increment, or a
  hash lookup on a small dict. No allocations on the unsampled path.
* Sample-rate gating is "every Nth `call` event" using a per-tracer
  counter. This is cheaper than `random()` and deterministic for testing.
* We skip frames whose code object lives inside the stdlib or in the
  hayven_trace package itself — otherwise the trace amplifies its own cost.
"""

from __future__ import annotations

import logging
import os
import sys
import sysconfig
import threading
from dataclasses import dataclass, field
from types import FrameType
from typing import Any, Callable, Iterable, List, Optional, Set, Tuple

from .aggregator import Aggregator, CoverageAggregator
from .flusher import Flusher

log = logging.getLogger("hayven_trace.tracer")


@dataclass
class TraceConfig:
    """User-tunable knobs for the tracer.

    Attributes mirror the documented public arguments to :func:`start`.
    """

    daemon_url: str = "http://localhost:7777"
    sample_rate: int = 100
    """Capture 1 in every N `call` events. 100 = ~1% of all calls."""

    flush_interval_seconds: float = 30.0
    """How often the background flusher POSTs to the daemon."""

    include_stdlib: bool = False
    """If False (default), frames whose file lives inside the stdlib are
    skipped before aggregation. This is the dominant overhead control."""

    project_paths: Tuple[str, ...] = field(default_factory=tuple)
    """If non-empty, ONLY frames whose source path is under one of these
    prefixes are traced. Strongly recommended for production-ish use."""

    source: str = "python"
    """Tag attached to each flushed batch. Useful for daemons that ingest
    traces from multiple languages."""

    capture_arg_types: bool = False
    """If True, attach typed argument metadata (type names only, never
    values) to each observation. Off by default per PRD §9.4."""


# Module-level singleton — Python's settrace is itself global, so we
# discourage multiple Tracers in the same process.
_active: Optional["HayvenTracer"] = None


def is_active() -> bool:
    """Return True if a tracer is currently installed in this process."""
    return _active is not None


def start(
    daemon_url: str = "http://localhost:7777",
    sample_rate: int = 100,
    flush_interval_seconds: float = 30.0,
    project_paths: Optional[Iterable[str]] = None,
    include_stdlib: bool = False,
    capture_arg_types: bool = False,
) -> "HayvenTracer":
    """Start tracing the current process and return the active tracer.

    Subsequent calls return the existing tracer (idempotent). Use
    :func:`stop` to shut down and flush the final batch.
    """
    global _active
    if _active is not None:
        return _active
    cfg = TraceConfig(
        daemon_url=daemon_url,
        sample_rate=max(1, int(sample_rate)),
        flush_interval_seconds=float(flush_interval_seconds),
        include_stdlib=include_stdlib,
        project_paths=tuple(project_paths) if project_paths else (),
        capture_arg_types=capture_arg_types,
    )
    t = HayvenTracer(cfg)
    t.install()
    _active = t
    return t


def stop() -> None:
    """Stop the active tracer (if any) and flush the final batch."""
    global _active
    t = _active
    _active = None
    if t is not None:
        t.uninstall()


class HayvenTracer:
    """Owns the sys.settrace callback, the aggregator, and the flusher.

    Most users will not construct this directly — use :func:`start` /
    :func:`stop`. Tests do construct it directly so they can inject a
    fake sender.
    """

    def __init__(self, config: TraceConfig, aggregator: Optional[Aggregator] = None,
                 flusher: Optional[Flusher] = None,
                 coverage: Optional[CoverageAggregator] = None) -> None:
        self.config = config
        self.aggregator = aggregator or Aggregator()
        # Per-test coverage lives beside the edge aggregate. It records, per
        # root-test, the multiset of entities that specific test executed — so
        # the daemon can answer "which tests touched X" precisely instead of
        # reverse-walking the GLOBAL graph (which over-reports via shared hubs
        # like CliRunner.invoke). The edge aggregate is unchanged.
        self.coverage = coverage or CoverageAggregator()
        self.flusher = flusher or Flusher(
            self.aggregator,
            daemon_url=config.daemon_url,
            interval_seconds=config.flush_interval_seconds,
            sample_rate=config.sample_rate,
            source=config.source,
            coverage=self.coverage,
        )
        self._counter = 0  # sample counter
        self._installed = False
        self._prev_trace: Optional[Callable[..., Any]] = None

        # Context stack of the root-test frames currently on the call stack.
        # Each entry is (frame, node_id). A frame is pushed on its `call` event
        # when it looks like a test, and popped on its matching `return` (frame
        # identity match). The CURRENT test context is the top of the stack, or
        # None when empty. Maintained only on whatever thread is executing user
        # code; settrace is per-thread so a list is sufficient (no cross-thread
        # sharing of this stack).
        self._test_stack: List[Tuple[FrameType, str]] = []

        # Path-based filters: precompute the stdlib prefix once.
        self._stdlib_prefix = sysconfig.get_paths().get("stdlib") or ""
        self._stdlib_prefix2 = sysconfig.get_paths().get("platstdlib") or ""
        self._self_prefix = os.path.dirname(__file__)
        self._project_prefixes: Tuple[str, ...] = tuple(
            os.path.abspath(p) for p in config.project_paths
        )

        # Cache "should I skip this file?" lookups — file path strings are
        # interned by CPython so id-based caching is correct.
        self._skip_cache: Set[str] = set()
        self._keep_cache: Set[str] = set()

    # ----- public surface -----

    def install(self) -> None:
        if self._installed:
            return
        self._prev_trace = sys.gettrace()
        sys.settrace(self._dispatch)
        threading.settrace(self._dispatch)
        self.flusher.start()
        self._installed = True

    def uninstall(self) -> None:
        if not self._installed:
            return
        sys.settrace(self._prev_trace)
        # threading.settrace doesn't accept None on older Pythons; passing
        # a no-op is safer. New threads created after uninstall will
        # therefore install a no-op rather than the previous trace.
        threading.settrace(_noop_trace)
        self.flusher.stop(flush=True)
        self._installed = False

    # ----- inspection helpers (used by tests / pytest plugin) -----

    @property
    def installed(self) -> bool:
        return self._installed

    def observed_edges(self) -> int:
        return self.aggregator.size()

    def current_test_context(self) -> Optional[str]:
        """Return the runtime node-id of the active root test, or None.

        Used by tests to assert push/pop balance; cheap top-of-stack read.
        """
        return self._test_stack[-1][1] if self._test_stack else None

    # ----- the hot path -----

    def _should_skip_file(self, filename: str) -> bool:
        """Return True if frames in this file should be ignored entirely.

        Decision cached forever for the process — file paths don't change.
        """
        if filename in self._skip_cache:
            return True
        if filename in self._keep_cache:
            return False
        skip = False
        if not filename or filename.startswith("<"):
            # frozen importlib, eval(), etc.
            skip = True
        elif filename.startswith(self._self_prefix):
            skip = True
        elif not self.config.include_stdlib and (
            filename.startswith(self._stdlib_prefix)
            or (self._stdlib_prefix2 and filename.startswith(self._stdlib_prefix2))
            or "site-packages" in filename
        ):
            skip = True
        elif self._project_prefixes and not any(
            filename.startswith(p) for p in self._project_prefixes
        ):
            skip = True
        if skip:
            self._skip_cache.add(filename)
        else:
            self._keep_cache.add(filename)
        return skip

    def _is_test_node(self, frame: FrameType, node_id: str) -> bool:
        """Return True if this frame is a ROOT TEST (the coverage SELECTOR).

        The context must be the actual pytest/unittest TEST FUNCTION — the thing
        an agent would re-run — so detection is by NAME, not by file. A function
        counts as a test iff its qualname LEAF (the function/method name) is a
        test name: starts with ``test_`` or is exactly ``test`` (pytest collects
        ``test_*`` functions and ``test_*`` methods of ``Test*`` classes; the
        method name is the leaf either way).

        Crucially this is NOT file-based. A command callback defined *inside* a
        test (``def cmd(): ...`` then ``runner.invoke(cmd)`` — extremely common in
        click's suite) lives in a test FILE but is NOT a test; if we treated every
        function in a test file as a context, that callback would override the
        active test and coverage would be attributed to ``cmd`` instead of the
        real ``test_x``. Name-based detection keeps the root test as the context
        for its whole subtree (the callback never pushes, so calls it makes are
        still attributed to the test below it on the stack). File-based test-FILE
        classification still lives in db/test_nodes.ts for the *graph* side; this
        is the runtime SELECTOR and must be stricter.
        """
        qual = node_id.rsplit(":", 1)[-1]
        # A NESTED function (defined inside another function) is never a real
        # pytest test — pytest only collects MODULE-LEVEL `test_*` functions and
        # `test_*` methods of `Test*` classes. CPython marks a nested scope with
        # `<locals>` in co_qualname (`test_x.<locals>.test_callback`), so a nested
        # helper that happens to be named `test_*` (common in click: a command
        # callback or an inner assertion helper) must NOT become a context — it
        # would attribute coverage to an un-runnable node and pollute the run list.
        if "<locals>" in qual:
            return False
        # The leaf component of a (possibly class-qualified) qualname.
        leaf = qual.rsplit(".", 1)[-1]
        return leaf.startswith("test_") or leaf == "test"

    def _node_id(self, frame: FrameType) -> str:
        """Compute the stable id we record for this frame.

        Format: ``"<module>:<qualname>"``. Module is the dotted path or
        else the basename of the source file. Qualname uses Python's own
        co_qualname (3.11+) or falls back to co_name.
        """
        code = frame.f_code
        mod = frame.f_globals.get("__name__")
        if not isinstance(mod, str) or mod == "__main__":
            mod = os.path.splitext(os.path.basename(code.co_filename))[0] or "__unknown__"
        qual = getattr(code, "co_qualname", None) or code.co_name
        return f"{mod}:{qual}"

    def _dispatch(self, frame: FrameType, event: str, arg: Any) -> Optional[Callable[..., Any]]:
        # `return` events drive the context-stack POP. We must handle them
        # BEFORE the `call`-only early-return below, otherwise a test frame
        # would never leave the stack and bleed its context into whatever runs
        # next. The tracer returns self._dispatch as the local trace fn, so we
        # already RECEIVE return events for every traced frame — we just stop
        # short-circuiting on them. Identity (`is`) match against the top guards
        # against popping on inner-frame returns.
        if event == "return":
            if self._test_stack and self._test_stack[-1][0] is frame:
                self._test_stack.pop()
            return self._dispatch

        # We only act on `call` events otherwise. We MUST return self._dispatch
        # (not None) so that child frames are also traced — returning
        # None disables tracing for this frame's entire subtree.
        if event != "call":
            return self._dispatch

        # Skip frames in files we ignore. Returning self._dispatch still
        # lets us reach this frame's children if they are in tracked code.
        filename = frame.f_code.co_filename
        if self._should_skip_file(filename):
            return self._dispatch

        dst = self._node_id(frame)

        # PUSH: if this frame is itself a test, it becomes the new current
        # context for everything it (transitively) calls. Done unconditionally
        # on every test `call` (not gated by sample-rate) so the stack always
        # reflects the true call stack and pops stay balanced.
        if self._is_test_node(frame, dst):
            self._test_stack.append((frame, dst))

        # Caller (might be None for the top frame).
        caller = frame.f_back
        caller_skipped = caller is not None and self._should_skip_file(caller.f_code.co_filename)
        effective_caller = None if caller_skipped else caller
        src = self._node_id(effective_caller) if effective_caller is not None else "<entry>"

        # Per-test COVERAGE is recorded on EVERY call event, BEFORE — and
        # therefore INDEPENDENT of — the sample-rate gate below. Coverage is
        # GROUND TRUTH ("did this test execute this entity, yes/no"), not an
        # estimate: a single un-sampled call must still mark the entity covered,
        # or a test that only ever reaches a symbol on un-sampled calls would
        # silently vanish from its coverage and recall would collapse at any
        # sample_rate > 1. The edge GRAPH below may be sampled (it's an
        # estimate); per-test coverage may NOT. The node-ids (src/dst) needed
        # here are cheap string ops, so computing them on every call — rather
        # than only sampled ones — is an accepted cost.
        #
        # The current context is the top of the stack. The test frame is the
        # SELECTOR, not a covered entity, so we attribute the callee (dst) and
        # the intermediate caller (src) — skipping the synthetic "<entry>"
        # sentinel and the context's own node (it's neither a meaningful covered
        # entity here nor needed; the daemon excludes the changed symbol's own
        # root in the affected-tests query anyway).
        if self._test_stack:
            context = self._test_stack[-1][1]
            self.coverage.add(context, dst)
            if src != "<entry>" and src != context:
                self.coverage.add(context, src)

        # Sample-rate gate: increment counter, only record every Nth event.
        # ONLY the edge AGGREGATE lives behind this gate — sampling the global
        # call graph is fine and intended (it's an estimate the daemon scales
        # back up via the sample rate). Coverage above already ran unsampled.
        self._counter += 1
        if self._counter % self.config.sample_rate != 0:
            return self._dispatch

        self.aggregator.add(src, dst)

        # Continue tracing children of this frame.
        return self._dispatch


def _noop_trace(frame: FrameType, event: str, arg: Any) -> Optional[Callable[..., Any]]:
    return None
