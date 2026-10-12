"""Authentication, tenant isolation and approval authorization.

The frontend is never the authority. Every session endpoint resolves a
*principal* from an API key on the server, and every read or write of a
session is checked against that principal:

- tenant   a session belongs to one tenant; a principal of another tenant
           gets 404 (the session does not exist for them — no existence leak)
- subject  within a tenant a session belongs to the user who created it;
           another user's session is 404 too, unless the caller is an admin
- role     viewer = read only · user = may drive their own sessions and
           approve/deny the actions proposed in them · admin = all sessions
           of their tenant

API keys are random, shown once, and stored only as a SHA-256 hash. With
AUTH_REQUIRED=false (local development only) every caller is the same
anonymous "public" principal.
"""

import hashlib
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session as DBSession

from operon_backend.config import settings
from operon_backend.db import get_db
from operon_backend.db_models import ApiKey, SessionRecord

TOKEN_PREFIX = "opk_"
ROLES = ("viewer", "user", "admin")
_NAME_RE = re.compile(r"^[A-Za-z0-9._@:-]{1,64}$")
PUBLIC_TENANT = "public"


@dataclass(frozen=True)
class Principal:
    tenant_id: str
    subject: str
    role: str
    key_id: str | None  # None only for the anonymous principal (auth disabled)

    @property
    def can_write(self) -> bool:
        return self.role in ("user", "admin")


ANONYMOUS = Principal(tenant_id=PUBLIC_TENANT, subject="anonymous", role="user", key_id=None)


# ---- keys ------------------------------------------------------------------------------------


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def generate_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def create_api_key(db: DBSession, tenant_id: str, subject: str, role: str = "user", label: str | None = None) -> tuple[str, ApiKey]:
    """Returns (token, row). The token is not recoverable afterwards."""
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    for name, value in (("tenant", tenant_id), ("subject", subject)):
        if not _NAME_RE.match(value):
            raise ValueError(f"{name} must match {_NAME_RE.pattern}")
    token = generate_token()
    row = ApiKey(
        id=uuid.uuid4().hex,
        key_hash=hash_token(token),
        key_prefix=token[: len(TOKEN_PREFIX) + 4],
        tenant_id=tenant_id,
        subject=subject,
        role=role,
        label=label,
    )
    db.add(row)
    db.commit()
    return token, row


def revoke_api_key(db: DBSession, key_id: str) -> bool:
    row = db.get(ApiKey, key_id)
    if row is None or row.revoked_at is not None:
        return False
    row.revoked_at = datetime.now(UTC)
    db.commit()
    return True


def authenticate(db: DBSession, token: str) -> Principal | None:
    """The principal for a valid, unrevoked token; None otherwise."""
    if not token.startswith(TOKEN_PREFIX) or len(token) > 200:
        return None
    row = db.query(ApiKey).filter(ApiKey.key_hash == hash_token(token)).one_or_none()
    if row is None or row.revoked_at is not None:
        return None
    row.last_used_at = datetime.now(UTC)
    db.commit()
    return Principal(tenant_id=row.tenant_id, subject=row.subject, role=row.role, key_id=row.id)


# ---- request dependency ---------------------------------------------------------------------------


def client_ip(request: Request) -> str:
    """The caller's address, for rate limiting. Behind a trusted proxy the client
    address is the entry that proxy *appended* to X-Forwarded-For (counting from
    the right, one per trusted hop). The leftmost entries are whatever the client
    chose to send and are never believed."""
    if settings.trust_forwarded_for:
        hops = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
        if len(hops) >= settings.trusted_proxy_hops:
            return hops[-settings.trusted_proxy_hops]
    return request.client.host if request.client else "unknown"


def _unauthorized() -> HTTPException:
    # One message for missing, malformed, unknown and revoked: no oracle.
    return HTTPException(status_code=401, detail="Authentication required", headers={"WWW-Authenticate": "Bearer"})


async def current_principal(request: Request, db: DBSession = Depends(get_db)) -> Principal:
    if not settings.auth_required:
        return ANONYMOUS
    from operon_backend.ratelimit import limiter  # local import: ratelimit imports Principal helpers

    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    principal = authenticate(db, token.strip()) if scheme.lower() == "bearer" and token.strip() else None
    if principal is None:
        allowed, retry_after = limiter.hit(f"authfail:{client_ip(request)}", settings.rate_limit_auth_failures_per_minute)
        if not allowed:
            raise HTTPException(status_code=429, detail="Too many failed authentication attempts", headers={"Retry-After": str(retry_after)})
        raise _unauthorized()
    request.state.principal = principal
    return principal


# ---- authorization ----------------------------------------------------------------------------------


def can_access(session: SessionRecord, principal: Principal, *, write: bool = False) -> bool:
    """Whether `principal` may see `session` (and, with write=True, change it)."""
    if session.tenant_id != principal.tenant_id:
        return False
    if write and not principal.can_write:
        return False
    return principal.role == "admin" or session.created_by == principal.subject


def require_session_access(session: SessionRecord | None, principal: Principal, *, write: bool, session_id: str = "") -> SessionRecord:
    """The session, or an error. A caller that may not see a session is told it
    does not exist (404) whether it is another tenant's, another user's, or
    absent. A caller that can see it but only holds a read-only key gets 403 on
    a write."""
    if session is None or not can_access(session, principal, write=False):
        raise HTTPException(status_code=404, detail=f"No session '{session_id or getattr(session, 'id', '')}'")
    if write and not principal.can_write:
        raise HTTPException(status_code=403, detail="This API key is read-only")
    return session
