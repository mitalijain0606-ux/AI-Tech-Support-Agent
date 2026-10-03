"""Server-side verification decisions (ported from the reviewed P0 extension
logic: cited-evidence recurrence, storage re-check, missing-data safety,
clean-window fallback only when nothing is cited)."""

import pytest

from operon_backend.schemas import (
    CitedEvidence,
    ConsoleEvidence,
    CookieSignal,
    NetworkEvidence,
    PageSignal,
    StorageSignal,
    VerificationObservation,
    VerificationPlan,
)
from operon_backend.verification import evaluate, signature_of

ERR = ConsoleEvidence(id="ev_001", level="error", text="TypeError: cannot read properties of undefined (reading 'x') at app.js:12:5")
NET = NetworkEvidence(id="ev_002", method="GET", url="https://github.com/api/items?page=2", status=500)
STORE = StorageSignal(id="ev_003", key="operon_demo_cache", present=True, parse_status="syntax_error")
COOKIE = CookieSignal(id="ev_004", name="user_session", domain="github.com")
PAGE = PageSignal(id="ev_005", url_path="/", service_worker_controlled=True, service_worker_scopes=["/app/"])


def plan(strategy="reobserve_cited", storage_keys=(), scope=None, **cited) -> VerificationPlan:
    return VerificationPlan(strategy=strategy, cited_evidence=CitedEvidence(**cited), storage_keys=list(storage_keys),
                            service_worker_scope=scope)


def obs(console=(), network=(), storage=None, sw=None, error=None) -> VerificationObservation:
    return VerificationObservation(console=list(console), network=list(network), storage=storage,
                                   service_worker_scopes=sw, error=error)


def gone(key="operon_demo_cache"):
    return [{"key": key, "present": False, "parse_status": "empty"}]


def still_corrupt(key="operon_demo_cache"):
    return [{"key": key, "present": True, "parse_status": "syntax_error"}]


# console / network ------------------------------------------------------------------

def test_console_fixed_passes():
    assert evaluate(plan(console=[ERR]), obs()).outcome == "passed"


def test_console_persists_fails_even_with_different_line_numbers():
    again = ConsoleEvidence(id="ev_9", level="error", text="TypeError: cannot read properties of undefined (reading 'x') at app.js:14:9")
    r = evaluate(plan(console=[ERR]), obs(console=[again]))
    assert r.outcome == "failed" and "ev_001 reappeared" in r.message


def test_network_issue_persists_with_a_different_query_string_fails():
    again = NetworkEvidence(id="ev_9", method="get", url="https://github.com/api/items?page=3", status=500)
    assert evaluate(plan(network=[NET]), obs(network=[again])).outcome == "failed"


def test_unrelated_new_error_does_not_fail_the_cited_signal():
    other = ConsoleEvidence(id="ev_9", level="error", text="ReferenceError: foo is not defined")
    assert evaluate(plan(console=[ERR]), obs(console=[other])).outcome == "passed"


# storage --------------------------------------------------------------------------

def test_storage_fixed_passes():
    assert evaluate(plan("storage_recheck", ["operon_demo_cache"], storage=[STORE]), obs(storage=gone())).outcome == "passed"
    valid = [{"key": "operon_demo_cache", "present": True, "parse_status": "valid_json"}]
    assert evaluate(plan("storage_recheck", ["operon_demo_cache"], storage=[STORE]), obs(storage=valid)).outcome == "passed"


def test_storage_unchanged_fails():
    r = evaluate(plan("storage_recheck", ["operon_demo_cache"], storage=[STORE]), obs(storage=still_corrupt()))
    assert r.outcome == "failed" and "syntax_error" in r.message


@pytest.mark.parametrize("strategy", ["reobserve_cited", "storage_recheck"])
def test_storage_only_citation_with_quiet_page_never_passes_without_a_recheck(strategy):
    """The P0 false-positive path: cited storage + quiet page must not pass."""
    r = evaluate(plan(strategy, storage=[STORE]), obs(storage=None))
    assert r.outcome == "inconclusive"


def test_storage_key_missing_from_the_recheck_is_inconclusive():
    r = evaluate(plan(storage=[STORE]), obs(storage=gone("some_other_key")))
    assert r.outcome == "inconclusive"


# missing data / inconclusive ----------------------------------------------------------

def test_missing_plan_is_inconclusive():
    assert evaluate(None, obs()).outcome == "inconclusive"


@pytest.mark.parametrize("error", ["debugger_unavailable", "tab_unreachable", "interrupted"])
def test_provider_observation_error_is_inconclusive(error):
    assert evaluate(plan(console=[ERR]), obs(error=error)).outcome == "inconclusive"


def test_cookie_citation_is_inconclusive():
    assert evaluate(plan(cookies=[COOKIE]), obs()).outcome == "inconclusive"


def test_page_citation_without_a_page_check_is_inconclusive():
    assert evaluate(plan(page=[PAGE]), obs()).outcome == "inconclusive"


def test_mixed_citation_passes_only_when_everything_is_gone():
    p = plan(console=[ERR], storage=[STORE])
    assert evaluate(p, obs(storage=gone())).outcome == "passed"
    assert evaluate(p, obs(console=[ERR.model_copy(update={"id": "ev_9"})], storage=gone())).outcome == "failed"
    assert evaluate(p, obs(storage=None)).outcome == "inconclusive"


# service worker ---------------------------------------------------------------------

def test_service_worker_recheck():
    p = plan("service_worker_recheck", scope="/app/", page=[PAGE])
    assert evaluate(p, obs(sw=[])).outcome == "passed"
    assert evaluate(p, obs(sw=["/app/"])).outcome == "failed"
    assert evaluate(p, obs(sw=None)).outcome == "inconclusive"


# clean-window fallback is only for plans that cite nothing --------------------------------

def test_clean_window_only_when_nothing_cited():
    assert evaluate(plan(), obs()).outcome == "passed"
    assert evaluate(plan(), obs(console=[ERR])).outcome == "failed"


def test_signatures_ignore_volatile_numbers_and_query_strings():
    assert signature_of(ConsoleEvidence(id="a", text="Error at line 10")) == signature_of(ConsoleEvidence(id="b", text="Error  at line 99"))
    assert signature_of(NetworkEvidence(id="a", method="GET", url="https://x.test/p?q=1", status=404)) == signature_of(
        NetworkEvidence(id="b", method="GET", url="https://x.test/p#frag", status=404)
    )
