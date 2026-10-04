"""Gating for tests that need a real external service.

By default a live test whose service is unreachable is SKIPPED, with the
exact reason, so a plain `pytest` run is green offline. Set
OPERON_REQUIRE_LIVE (comma-separated: embeddings, groq, or all) to make an
unavailable service a FAILURE instead — use that wherever "skipped" would
hide a regression (a release check, or a machine that should have network).
"""

import os

import pytest

REQUIRED = {part.strip() for part in os.environ.get("OPERON_REQUIRE_LIVE", "").split(",") if part.strip()}


def unavailable(service: str, reason: str):
    if service in REQUIRED or "all" in REQUIRED:
        pytest.fail(f"{service} is required (OPERON_REQUIRE_LIVE) but unavailable: {reason}")
    pytest.skip(f"{service} unavailable: {reason}")


def real_groq_key() -> str:
    """The configured key, read fresh so the suite-wide test override of the
    settings singleton (which blanks it) doesn't hide it. Never printed."""
    from operon_backend.config import Settings

    return Settings().groq_api_key.strip()
