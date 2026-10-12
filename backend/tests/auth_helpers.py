"""Helpers for the authentication / tenant tests."""

from operon_backend.auth import create_api_key
from operon_backend.db import SessionLocal


def mint(tenant: str, subject: str, role: str = "user") -> dict[str, str]:
    """A fresh API key; returns the Authorization header for it."""
    db = SessionLocal()
    try:
        token, _ = create_api_key(db, tenant, subject, role, label="test")
    finally:
        db.close()
    return {"Authorization": f"Bearer {token}"}
