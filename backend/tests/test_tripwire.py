import json

import pytest

from operon_backend.schemas import (
    ConsoleEvidence,
    CookieSignal,
    EvidenceBundle,
    StorageSignal,
)
from operon_backend.tripwire import TripwireHit, scan_raw_payload


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
