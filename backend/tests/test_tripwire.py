import json

import pytest

from operon_backend.schemas import (
    ConsoleEvidence,
    CookieSignal,
    EvidenceBundle,
    StorageSignal,
)
from operon_backend.tripwire import TripwireHit, redact_credentials, scan_raw_payload


def test_tripwire_allows_clean_bundle():
    bundle = EvidenceBundle(
        url="https://github.com",
        timestamp=1726000000.0,
        console=[
            ConsoleEvidence(
                id="ev_001",
                level="error",
                text="SyntaxError: Unexpected token in JSON at position 0",
            )
        ],
        storage=[
            StorageSignal(
                id="ev_002",
                key="operon_demo_cache",
                present=True,
                parse_status="syntax_error",
                error_message="Unexpected token",
            )
        ],
        cookies=[
            CookieSignal(
                id="ev_003",
                name="logged_in",
                domain="github.com",
                secure=True,
                http_only=True,
            )
        ],
    )
    raw_payload = json.dumps(bundle.model_dump())
    # Should not raise any exception
    scan_raw_payload(raw_payload)


def test_tripwire_rejects_jwt_shaped_string():
    fake_jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    raw_payload = json.dumps({"token": fake_jwt, "url": "https://github.com"})

    with pytest.raises(TripwireHit) as exc_info:
        scan_raw_payload(raw_payload)

    assert exc_info.value.rule == "jwt_token"


def test_tripwire_rejects_bearer_token():
    raw_payload = json.dumps({"header": "Bearer secret_access_token_123456789"})

    with pytest.raises(TripwireHit) as exc_info:
        scan_raw_payload(raw_payload)

    assert exc_info.value.rule == "bearer_token"


def test_tripwire_rejects_long_hex_string():
    hex_key = "4f53cda18c2d4e8b9a10123456789abc4f53cda18c2d4e8b9a10123456789abc"
    raw_payload = json.dumps({"api_hash": hex_key})

    with pytest.raises(TripwireHit) as exc_info:
        scan_raw_payload(raw_payload)

    assert exc_info.value.rule == "long_hex_secret"


def test_tripwire_rejects_sensitive_json_fields():
    raw_payload = json.dumps({"password": "SuperSecretPassword123"})

    with pytest.raises(TripwireHit) as exc_info:
        scan_raw_payload(raw_payload)

    assert exc_info.value.rule == "sensitive_json_field"


def test_tripwire_allows_commit_sha_in_url_path():
    sha = "0123456789abcdef0123456789abcdef01234567"
    bundle = EvidenceBundle(
        url=f"https://github.com/octo/repo/commit/{sha}",
        timestamp=1726000000.0,
        console=[ConsoleEvidence(id="ev_001", text=f"Failed to load https://github.com/octo/repo/blob/{sha}/a.js")],
    )
    scan_raw_payload(json.dumps(bundle.model_dump()))


def test_tripwire_allows_gist_id_in_url_path():
    scan_raw_payload(json.dumps({"url": "https://gist.github.com/octo/4f53cda18c2d4e8b9a10123456789abc"}))


def test_tripwire_still_rejects_long_hex_in_url_query():
    hex_key = "4f53cda18c2d4e8b9a10123456789abc4f53cda1"
    raw_payload = json.dumps({"url": f"https://api.example.com/v1/data?access_token={hex_key}"})

    with pytest.raises(TripwireHit) as exc_info:
        scan_raw_payload(raw_payload)

    assert exc_info.value.rule == "long_hex_secret"


def test_tripwire_rejects_bare_hex_even_when_a_url_is_also_present():
    sha = "0123456789abcdef0123456789abcdef01234567"
    raw_payload = json.dumps({"url": f"https://github.com/o/r/commit/{sha}", "note": f"key {sha}"})

    with pytest.raises(TripwireHit) as exc_info:
        scan_raw_payload(raw_payload)

    assert exc_info.value.rule == "long_hex_secret"


# ---- git object ids vs. credentials, and free-text redaction ---------------

SHA1 = "0123456789abcdef0123456789abcdef01234567"
SHA256 = "4f53cda18c2d4e8b9a10123456789abc4f53cda18c2d4e8b9a10123456789abc"


@pytest.mark.parametrize(
    "text",
    [
        f"broken since commit {SHA1}",
        f"Commit: {SHA1} broke the dashboard",
        f"after merging sha {SHA1}",
        f"HEAD is at {SHA1}",
        f"uses actions/checkout@{SHA1}",
        f"object sha256 {SHA256}",
    ],
)
def test_git_object_ids_in_free_text_are_not_credentials(text):
    scan_raw_payload(json.dumps({"console": text}))  # must not raise
    assert redact_credentials(text) == (text, [])


@pytest.mark.parametrize(
    "text,rule",
    [
        (f"my token is {SHA1}", "long_hex_secret"),  # 40-hex with no git word: treated as a secret
        (f"see commit {SHA1[:36]}", "long_hex_secret"),  # git word, but not a git object id length
        ("auth header Bearer ghp_abcdefghijklmnop1234567890", "bearer_token"),
        ("cookie eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij", "jwt_token"),
    ],
)
def test_credentials_in_free_text_are_redacted(text, rule):
    redacted, fired = redact_credentials(text)
    assert fired == [rule]
    assert f"[REDACTED:{rule}]" in redacted
    secret = text.split()[-1]
    assert secret not in redacted
    with pytest.raises(TripwireHit):
        scan_raw_payload(text)


def test_redaction_keeps_commit_sha_but_removes_token_in_same_text():
    text = f"since commit {SHA1} it asks for Bearer ghp_abcdefghijklmnop1234567890"
    redacted, fired = redact_credentials(text)
    assert SHA1 in redacted
    assert "ghp_abcdefghijklmnop1234567890" not in redacted
    assert fired == ["bearer_token"]


# ---- P0 review round 2: the git exemption must never weaken URL/secret detection ----

ALLOWED_GIT_REFERENCES = [
    f"commit {SHA1}",
    f"commit {SHA256}",
    f"HEAD is at {SHA1}",
    f"uses: actions/checkout@{SHA1}",
    f"pinned to octo-org/deploy-tool@{SHA256}",
]

STILL_REJECTED = [
    f"https://x.com/file?hash={SHA256}",
    f"https://x.com/file?sha={SHA1}",
    f"https://x.com/file?ref={SHA1}",
    f"https://x.com/file#rev={SHA1}",
    f"token@{SHA1}",
    f"user@{SHA1}",
    f"deploy@{SHA1}",
    f"password@{SHA1}",
    f"https://deploy@{SHA1}.example.com",
    f"password hash: {SHA256}",
    f"secret hash: {SHA256}",
    f"key hash: {SHA256}",
    f"password sha256: {SHA256}",
    f"the secret commit {SHA1}",
]


@pytest.mark.parametrize("text", ALLOWED_GIT_REFERENCES)
def test_legitimate_git_references_are_allowed(text):
    scan_raw_payload(json.dumps({"console": text}))
    assert redact_credentials(text) == (text, [])


@pytest.mark.parametrize("text", STILL_REJECTED)
def test_git_exemption_never_overrides_url_or_secret_detection(text):
    with pytest.raises(TripwireHit) as exc_info:
        scan_raw_payload(json.dumps({"evidence": text}))
    assert exc_info.value.rule == "long_hex_secret"
    redacted, fired = redact_credentials(text)
    assert fired == ["long_hex_secret"]
    assert SHA1 not in redacted and SHA256 not in redacted


def test_hex_in_url_path_is_still_allowed_but_not_in_its_query():
    scan_raw_payload(f"https://github.com/octo/repo/commit/{SHA1}")
    with pytest.raises(TripwireHit):
        scan_raw_payload(f"https://github.com/octo/repo/commit/{SHA1}?token={SHA256}")
