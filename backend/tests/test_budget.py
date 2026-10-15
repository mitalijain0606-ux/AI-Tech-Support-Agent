"""Evidence budgeting (budget.py): what the model is shown is bounded, deduplicated,
redacted and capped — without losing the evidence that explains the problem."""

from operon_backend.budget import DEFAULT_TOKEN_BUDGET, budget_evidence, estimate_tokens
from operon_backend.schemas import EvidenceBundle
from operon_backend.stages import classify


def bundle(**items) -> EvidenceBundle:
    return EvidenceBundle.model_validate({"url": "https://app.example/x", "timestamp": 1, **items})


def console(i, text, level="error", **kw):
    return {"id": f"ev_c{i}", "level": level, "text": text, **kw}


def net(i, status, url="https://app.example/api/x", method="GET"):
    return {"id": f"ev_n{i}", "method": method, "url": url, "status": status}


def test_a_small_bundle_passes_through_unchanged():
    b = bundle(console=[console(1, "TypeError: x is undefined")], network=[net(1, 500)])
    out, report = budget_evidence(b)
    assert out.all_evidence_ids() == b.all_evidence_ids()
    assert report["dropped"] == {} and report["deduplicated"] == 0 and report["within_budget"]


def test_repeated_console_lines_collapse_with_a_count():
    b = bundle(console=[console(i, "Uncaught SyntaxError: bad JSON") for i in range(10)])
    out, report = budget_evidence(b)
    assert [c.id for c in out.console] == ["ev_c0"]
    assert out.console[0].count == 10
    assert report["deduplicated"] == 9


def test_repeated_requests_keep_the_latest():
    b = bundle(network=[net(i, 503) for i in range(5)] + [net(9, 200)])
    out, _ = budget_evidence(b)
    assert [n.id for n in out.network] == ["ev_n4", "ev_n9"]


def test_long_text_is_truncated_and_marked():
    b = bundle(console=[console(1, "word " * 380, url="https://app.example/" + "p" * 1900)], page=[{"id": "ev_p1", "url_path": "/", "title": "T" * 190}])
    out, report = budget_evidence(b)
    assert len(out.console[0].text) == 600 and out.console[0].text.endswith("…")
    assert len(out.console[0].url) <= 300
    assert len(out.page[0].title) == 80
    assert report["truncated_fields"] == 3


def test_free_text_is_redacted_again():
    secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
    out, _ = budget_evidence(bundle(console=[console(1, f"auth failed with {secret}")]))
    assert secret not in out.console[0].text and "REDACTED" in out.console[0].text


def test_a_huge_window_is_capped_and_keeps_the_anomalies():
    noise = [console(i, f"info: render tick {i} " + "x" * 400, level="info") for i in range(60)]
    ok = [net(i, 200, url=f"https://app.example/asset/{i}.js?" + "q" * 200) for i in range(60)]
    cookies = [{"id": f"ev_k{i}", "name": f"pref_{i}", "domain": "app.example"} for i in range(40)]
    storage = [{"id": "ev_s1", "key": "app_settings", "present": True, "parse_status": "syntax_error", "error_message": "Unexpected token"}]
    errors = [console(100, "Uncaught SyntaxError: Unexpected token in JSON at position 1")]
    b = bundle(console=noise + errors, network=ok, cookies=cookies, storage=storage)
    assert estimate_tokens(b) > DEFAULT_TOKEN_BUDGET

    out, report = budget_evidence(b)
    assert report["within_budget"] and report["tokens_after"] <= DEFAULT_TOKEN_BUDGET
    assert {"ev_s1", "ev_c100"} <= out.all_evidence_ids()  # the explanation survives
    assert report["dropped"].get("console", 0) > 0  # noise went first
    # and the deterministic classification is unchanged by budgeting
    assert classify("settings page is blank", out).category == classify("settings page is blank", b).category == "storage_corruption"


def test_a_tiny_budget_still_leaves_the_strongest_evidence():
    errors = [console(i, f"TypeError number {i} " + "y" * 500) for i in range(20)]
    out, report = budget_evidence(bundle(console=errors, network=[net(1, 500)]), token_budget=50)
    assert len(out.all_evidence_ids()) >= 1
    assert out.all_evidence_ids() <= {f"ev_c{i}" for i in range(20)} | {"ev_n1"}


def test_the_filter_keeps_the_most_recent_items():
    b = bundle(console=[console(i, f"TypeError {i}") for i in range(80)])
    out, report = budget_evidence(b, token_budget=10**6)
    assert len(out.console) == 60 and out.console[-1].id == "ev_c79"
    assert report["filtered"] == 20


def test_budgeting_is_deterministic_and_never_invents_ids():
    b = bundle(console=[console(i, f"warn {i} " + "z" * 300, level="warn") for i in range(60)], network=[net(i, 404 + (i % 2)) for i in range(60)])
    one, r1 = budget_evidence(b, token_budget=2000)
    two, r2 = budget_evidence(b, token_budget=2000)
    assert one == two and r1 == r2
    assert one.all_evidence_ids() <= b.all_evidence_ids()


def test_every_cycle_records_what_budgeting_did(monkeypatch):
    from starlette.testclient import TestClient

    from flow_helpers import CAPABILITIES, corrupt_storage, new_session, submit
    from operon_backend.config import settings
    from operon_backend.main import app

    monkeypatch.setattr(settings, "auth_required", False)
    monkeypatch.setattr(settings, "groq_api_key", "")
    monkeypatch.setattr(settings, "evidence_token_budget", 300)
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])
    client = TestClient(app)
    s = new_session(client, capabilities=CAPABILITIES)
    noise = [console(i, f"info tick {i} " + "n" * 300, level="info") for i in range(30)]
    body = submit(client, s, console=noise, storage=[corrupt_storage()]).json()
    entry = next(a for a in body["session"]["activity"] if a["kind"] == "evidence_budget")
    assert entry["data"]["items_before"] == 31 and entry["data"]["items_after"] < 31
    assert entry["data"]["dropped"]["console"] > 0
    # the corrupted key still drove the diagnosis
    assert body["session"]["phase"] == "ACTION_PROPOSED"
    assert body["session"]["pending_action"]["action_id"] == "clear_storage_key"
