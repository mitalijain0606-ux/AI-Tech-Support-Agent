"""Per-caller request rate limiting.

A fixed one-minute window per key. In-process by default; with REDIS_URL set
the counters live in Redis so several instances share one budget. The limiter
fails *open* if Redis is unreachable (an outage of the cache must not take the
API down) and logs it.
"""

import logging
import math
import threading
import time
from collections import deque

from fastapi import Depends, HTTPException, Request

from operon_backend.auth import Principal, client_ip, current_principal
from operon_backend.config import settings

logger = logging.getLogger(__name__)

WINDOW_SECONDS = 60


class RateLimiter:
    def __init__(self, redis_client=None, clock=time.time) -> None:
        self._redis = redis_client
        self._clock = clock
        self._lock = threading.Lock()
        self._hits: dict[str, deque[float]] = {}

    def hit(self, key: str, limit: int) -> tuple[bool, int]:
        """Counts one request. Returns (allowed, seconds until the budget frees up)."""
        if limit <= 0:
            return True, 0
        if self._redis is not None:
            try:
                return self._hit_redis(key, limit)
            except Exception as exc:  # noqa: BLE001 — never let the cache take the API down
                logger.warning("rate limiter: redis unavailable (%s); allowing the request", type(exc).__name__)
                return True, 0
        return self._hit_memory(key, limit)

    def _hit_memory(self, key: str, limit: int) -> tuple[bool, int]:
        now = self._clock()
        with self._lock:
            window = self._hits.setdefault(key, deque())
            while window and now - window[0] >= WINDOW_SECONDS:
                window.popleft()
            if len(window) >= limit:
                return False, max(1, math.ceil(WINDOW_SECONDS - (now - window[0])))
            window.append(now)
            if len(self._hits) > 10_000:  # keep memory bounded under key churn
                for stale in [k for k, w in self._hits.items() if not w or now - w[-1] >= WINDOW_SECONDS][:5_000]:
                    self._hits.pop(stale, None)
            return True, 0

    def _hit_redis(self, key: str, limit: int) -> tuple[bool, int]:
        now = int(self._clock())
        bucket = now // WINDOW_SECONDS
        name = f"operon:rl:{key}:{bucket}"
        pipe = self._redis.pipeline()
        pipe.incr(name)
        pipe.expire(name, WINDOW_SECONDS * 2)
        count = int(pipe.execute()[0])
        if count > limit:
            return False, WINDOW_SECONDS - (now % WINDOW_SECONDS)
        return True, 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


def _make_limiter() -> RateLimiter:
    if settings.redis_url:
        try:
            import redis

            client = redis.Redis.from_url(settings.redis_url, socket_timeout=1, socket_connect_timeout=1, decode_responses=True)
            return RateLimiter(client)
        except Exception as exc:  # noqa: BLE001
            logger.warning("rate limiter: could not set up redis (%s); using the in-process limiter", type(exc).__name__)
    return RateLimiter()


limiter = _make_limiter()


def _caller_key(request: Request, principal: Principal) -> str:
    return f"key:{principal.key_id}" if principal.key_id else f"ip:{client_ip(request)}"


def rate_limited(kind: str = "default"):
    """FastAPI dependency: authenticate, then charge one request to the caller's
    budget ("llm" has the lower, cost-bearing budget). Returns the principal."""
    limit_name = "rate_limit_llm_per_minute" if kind == "llm" else "rate_limit_per_minute"

    async def dependency(request: Request, principal: Principal = Depends(current_principal)) -> Principal:
        allowed, retry_after = limiter.hit(f"{kind}:{_caller_key(request, principal)}", getattr(settings, limit_name))
        if not allowed:
            raise HTTPException(status_code=429, detail="Rate limit exceeded; slow down and retry", headers={"Retry-After": str(retry_after)})
        return principal

    return dependency
