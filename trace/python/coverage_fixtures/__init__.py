"""Fixture entities for per-test coverage tests.

This package lives OUTSIDE the ``tests/`` tree on purpose: the tracer's
test-frame detector also keys off the file path (any path containing
``/test`` is treated as a test), so helper "production" code used to prove
per-test coverage attribution must live somewhere that does NOT match a test
pattern. ``coverage_fixtures`` contains none of ``/test``, ``_test.``,
``test_``, ``.spec.`` — so its functions are seen as ordinary entities, never
as their own test context.
"""
