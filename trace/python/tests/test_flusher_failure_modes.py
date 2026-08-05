"""Flusher failure-mode tests: permanent-vs-transient rejection, flush
serialization, and the version-sourced User-Agent header. All use an injected
sender or a patched urlopen (no network)."""

from __future__ import annotations

import io
import json
import logging
import pathlib
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any, List, Optional, Tuple

import pytest

from hayven_trace.aggregator import Aggregator
from hayven_trace.flusher import Flusher


def _authoritative_version() -> str:
    """Independent oracle for the expected package version.

    Deliberately does NOT call the flusher's own helper (that would make the
    test self-referential and vacuous). Mirrors the resolution a correct
    header must reflect: installed metadata when present, else the version
    field of this checkout's pyproject.toml.
    """
    try:
        from importlib.metadata import version

        return version("hayven-trace")
    except Exception:
        pass
    pyproject = pathlib.Path(__file__).resolve().parents[1] / "pyproject.toml"
    m = re.search(r'^version\s*=\s*"([^"]+)"', pyproject.read_text(), re.MULTILINE)
    assert m is not None, "pyproject.toml must declare a version"
    return m.group(1)


def _http_error(code: int) -> urllib.error.HTTPError:
    """Build an HTTPError like urllib raises for a non-2xx daemon response."""
    return urllib.error.HTTPError(
        url="http://daemon/api/traces/observations",
        code=code,
        msg="rejected",
        hdrs=None,  # type: ignore[arg-type]
        fp=io.BytesIO(b""),
    )


class _ScriptedSender:
    """Raises the scripted errors in order, then records successful sends."""

    def __init__(self, errors: List[Optional[Exception]]) -> None:
        self.errors = list(errors)
        self.calls: List[Tuple[str, bytes]] = []

    def __call__(self, url: str, payload: bytes) -> None:
        if self.errors:
            err = self.errors.pop(0)
            if err is not None:
                raise err
        self.calls.append((url, payload))


def test_transient_failures_rebuffer_and_resend() -> None:
    # Network errors, 5xx, 408 and 429 are all TRANSIENT: the rows must be
    # re-buffered and the next flush must resend the very same edge.
    transient_errors: List[Exception] = [
        urllib.error.URLError("connection refused"),
        _http_error(500),
        _http_error(408),
        _http_error(429),
    ]
    for boom in transient_errors:
        agg = Aggregator()
        agg.add("a", "b")
        fake = _ScriptedSender([boom])
        f = Flusher(agg, daemon_url="http://daemon", sample_rate=1, sender=fake)

        f.flush_once()  # fails, rows re-buffered
        assert f.last_error is not None
        assert not f.last_error.startswith("dropped-permanent")

        n = f.flush_once()  # retry succeeds with the SAME rows
        assert n == 1
        assert len(fake.calls) == 1
        body = json.loads(fake.calls[0][1].decode("utf-8"))
        assert body["observations"][0]["src"] == "a"
        assert f.last_error is None


def test_permanent_rejection_drops_instead_of_rebuffering(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # A 400 means the daemon rejected the payload itself; re-buffering would
    # re-POST the identical rejected rows every interval forever.
    agg = Aggregator()
    agg.add("a", "b")
    fake = _ScriptedSender([_http_error(400), _http_error(400)])
    f = Flusher(agg, daemon_url="http://daemon", sample_rate=1, sender=fake)

    with caplog.at_level(logging.WARNING, logger="hayven_trace.flusher"):
        f.flush_once()
        assert f.last_error is not None
        assert f.last_error.startswith("dropped-permanent: ")
        assert "400" in f.last_error

        # The rejected rows were NOT re-buffered: nothing left to send.
        assert agg.size() == 0
        assert f.flush_once() == 0

        # A second permanent rejection (fresh data) does not log again: the
        # warning is once per flusher, not once per interval.
        agg.add("c", "d")
        f.flush_once()

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "permanently rejected" in warnings[0].getMessage()


def test_flush_once_is_serialized_across_threads() -> None:
    # Two threads flushing at once (interval thread vs manual/stop caller)
    # must not interleave sends: the lock keeps at most one flush in the
    # sender at any moment.
    state = {"active": 0, "max_active": 0}
    state_lock = threading.Lock()

    def slow_sender(url: str, payload: bytes) -> None:
        with state_lock:
            state["active"] += 1
            state["max_active"] = max(state["max_active"], state["active"])
        time.sleep(0.02)  # stay in flight long enough for overlap to show
        with state_lock:
            state["active"] -= 1

    agg = Aggregator()
    f = Flusher(agg, daemon_url="http://daemon", sample_rate=1, sender=slow_sender)

    def flush_with_data() -> None:
        agg.add("a", "b")
        f.flush_once()

    threads = [threading.Thread(target=flush_with_data) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert state["max_active"] == 1


def test_default_sender_user_agent_tracks_package_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The header must be derived from the package version helper, never a
    # hardcoded string that can go stale across releases.
    captured: List[urllib.request.Request] = []

    class _Resp:
        def read(self, n: int) -> bytes:
            return b""

        def __enter__(self) -> "_Resp":
            return self

        def __exit__(self, *exc: Any) -> None:
            return None

    def fake_urlopen(req: urllib.request.Request, timeout: float = 0.0) -> _Resp:
        captured.append(req)
        return _Resp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    agg = Aggregator()
    agg.add("a", "b")
    f = Flusher(agg, daemon_url="http://daemon", sample_rate=1)  # default sender
    f.flush_once()

    assert len(captured) == 1
    ua = captured[0].get_header("User-agent")
    assert ua == f"hayven-trace/{_authoritative_version()}"
    # Tripwires: neither the historically stale hand-bumped constant nor the
    # total-failure fallback may ever reach the wire.
    assert ua is not None
    assert "0.0.4" not in ua
    assert not ua.endswith("/unknown")
