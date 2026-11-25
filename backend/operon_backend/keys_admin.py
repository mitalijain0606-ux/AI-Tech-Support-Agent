"""Key management for a tenant's admins: list, create, rotate and revoke API keys.

Every route needs an admin key and only ever touches keys of the admin's own tenant;
another tenant's key id is answered with the same 404 as an unknown one. A token is
returned exactly once, when it is created (or rotated); only its hash is stored. An
admin cannot revoke or rotate the key making the request, so a mistake cannot lock
the tenant out. The CLI (scripts/manage_keys.py) remains for bootstrapping the first
admin key.
"""

from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session as DBSession

from operon_backend.auth import Principal, as_utc, create_api_key, is_expired, revoke_api_key
from operon_backend.db import get_db
from operon_backend.db_models import ApiKey
from operon_backend.ratelimit import rate_limited

PREFIX = "/api/admin/keys"


class CreateKeyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subject: str = Field(min_length=1, max_length=64)
    role: Literal["viewer", "user", "admin"] = "user"
    label: str | None = Field(default=None, max_length=100)
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)


class RotateKeyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)


def _iso(value: datetime | None) -> str | None:
    value = as_utc(value)
    return value.isoformat() if value else None


def summary(row: ApiKey) -> dict:
    """What an admin may see about a key: never the token or its hash."""
    state = "revoked" if row.revoked_at else "expired" if is_expired(row) else "active"
    return {
        "id": row.id,
        "prefix": row.key_prefix,
        "subject": row.subject,
        "role": row.role,
        "label": row.label,
        "state": state,
        "created_at": _iso(row.created_at),
        "last_used_at": _iso(row.last_used_at),
        "expires_at": _iso(row.expires_at),
        "revoked_at": _iso(row.revoked_at),
    }


def require_admin(principal: Principal = Depends(rate_limited())) -> Principal:
    if principal.role != "admin":
        raise HTTPException(status_code=403, detail="Managing API keys needs an admin key")
    return principal


def _tenant_key(db: DBSession, principal: Principal, key_id: str) -> ApiKey:
    row = db.get(ApiKey, key_id)
    if row is None or row.tenant_id != principal.tenant_id:
        raise HTTPException(status_code=404, detail="No such key")
    return row


def _expiry(days: int | None) -> datetime | None:
    return datetime.now(UTC) + timedelta(days=days) if days else None


def list_keys(db: DBSession = Depends(get_db), principal: Principal = Depends(require_admin)):
    rows = db.query(ApiKey).filter(ApiKey.tenant_id == principal.tenant_id).order_by(ApiKey.created_at).all()
    return {"keys": [summary(r) for r in rows]}


def create_key(body: CreateKeyRequest, db: DBSession = Depends(get_db), principal: Principal = Depends(require_admin)):
    try:
        token, row = create_api_key(db, principal.tenant_id, body.subject, body.role, body.label, _expiry(body.expires_in_days))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"key": summary(row), "token": token, "note": "Store this token now; it is not shown again."}


def revoke_key(key_id: str, db: DBSession = Depends(get_db), principal: Principal = Depends(require_admin)):
    row = _tenant_key(db, principal, key_id)
    if row.id == principal.key_id:
        raise HTTPException(status_code=409, detail="An admin cannot revoke the key it is using; use another admin key")
    if not revoke_api_key(db, row.id):
        raise HTTPException(status_code=409, detail="This key is already revoked")
    db.refresh(row)
    return {"key": summary(row)}


def rotate_key(key_id: str, body: RotateKeyRequest | None = None, db: DBSession = Depends(get_db), principal: Principal = Depends(require_admin)):
    """A new key for the same subject, role and label; the old one is revoked in the
    same step, so there is never a moment with neither or both active."""
    row = _tenant_key(db, principal, key_id)
    if row.id == principal.key_id:
        raise HTTPException(status_code=409, detail="An admin cannot rotate the key it is using; use another admin key")
    if row.revoked_at is not None:
        raise HTTPException(status_code=409, detail="This key is already revoked")
    days = body.expires_in_days if body else None
    row.revoked_at = datetime.now(UTC)  # committed together with the new key below
    token, new = create_api_key(db, row.tenant_id, row.subject, row.role, row.label, _expiry(days))
    db.refresh(row)
    return {"key": summary(new), "replaced": summary(row), "token": token, "note": "Store this token now; it is not shown again."}


def register(app: FastAPI) -> None:
    """Adds the routes directly to the app (not through an included router, so every entry
    of app.routes stays a plain route)."""
    app.add_api_route(PREFIX, list_keys, methods=["GET"], tags=["admin"])
    app.add_api_route(PREFIX, create_key, methods=["POST"], status_code=201, tags=["admin"])
    app.add_api_route(PREFIX + "/{key_id}/revoke", revoke_key, methods=["POST"], tags=["admin"])
    app.add_api_route(PREFIX + "/{key_id}/rotate", rotate_key, methods=["POST"], status_code=201, tags=["admin"])
