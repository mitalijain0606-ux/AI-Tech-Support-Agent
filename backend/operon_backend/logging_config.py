"""Structured logging and per-request tracing.

- One JSON object per line when LOG_FORMAT=json (what a log aggregator wants),
  readable text otherwise.
- Every request gets an id (honouring a sane inbound X-Request-ID), returned
  in the X-Request-ID response header and attached to every log line written
  while handling it.
- One access-log line per request: method, route template, status, duration,
  tenant and key id. Never the query string, headers or body.
- Every message passes through the credential redactor, so a secret that ends
  up in an exception message or a log argument is masked before it is written.
- An unhandled error is logged (exception type and a redacted message, with a
  traceback in the log only) and answered with a generic 500 that carries the
  request id, so a user can quote it and an operator can find the line.

Implemented as pure ASGI middleware because BaseHTTPMiddleware interferes with
streaming responses such as the SSE event stream.
"""

import json
import logging
import re
import sys
import time
import uuid
from contextvars import ContextVar

from operon_backend.tripwire import redact_credentials

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
_EXTRA_FIELDS = ("method", "route", "status", "duration_ms", "tenant_id", "key_id", "error_type")

logger = logging.getLogger("operon.request")


class _Formatter(logging.Formatter):
    def __init__(self, as_json: bool) -> None:
        super().__init__()
        self.as_json = as_json

    def format(self, record: logging.LogRecord) -> str:
        message = redact_credentials(record.getMessage())[0]
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S") + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "message": message,
            "request_id": request_id_var.get(),
        }
        for name in _EXTRA_FIELDS:
            if hasattr(record, name):
                payload[name] = getattr(record, name)
        if record.exc_info:
            # The traceback stays in the log only; it is also redacted.
            payload["traceback"] = redact_credentials(self.formatException(record.exc_info))[0]
        if self.as_json:
            return json.dumps(payload, separators=(",", ":"), default=str)
        extras = " ".join(f"{k}={payload[k]}" for k in _EXTRA_FIELDS if k in payload)
        text = f"{payload['ts']} {payload['level']:<7} {payload['logger']} [{payload['request_id']}] {message}"
        text = f"{text} {extras}".rstrip()
        return f"{text}\n{payload['traceback']}" if "traceback" in payload else text


def configure_logging(level: str = "INFO", fmt: str = "text") -> None:
    """Idempotent: replaces only the handler this module installed."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_operon", False):
            root.removeHandler(handler)
    handler = logging.StreamHandler(sys.stdout)
    handler._operon = True  # type: ignore[attr-defined]
    handler.setFormatter(_Formatter(as_json=fmt == "json"))
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))


class RequestLogMiddleware:
    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        inbound = headers.get("x-request-id", "")
        request_id = inbound if _REQUEST_ID_RE.match(inbound) else uuid.uuid4().hex
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        status = {"code": 500, "started": False}

        async def send_with_id(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
                status["started"] = True
                message = {**message, "headers": [*message.get("headers", []), (b"x-request-id", request_id.encode())]}
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception as exc:  # noqa: BLE001 — the last line of defence
            logger.error(
                "unhandled error handling the request: %s",
                redact_credentials(str(exc))[0][:200],
                exc_info=True,
                extra={"error_type": type(exc).__name__},
            )
            if not status["started"]:
                body = json.dumps({"detail": "Internal error", "request_id": request_id}).encode()
                await send_with_id(
                    {"type": "http.response.start", "status": 500, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]}
                )
                await send_with_id({"type": "http.response.body", "body": body})
        finally:
            route = scope.get("route")
            principal = (scope.get("state") or {}).get("principal")
            logger.info(
                "%s %s -> %s",
                scope["method"],
                getattr(route, "path", "(no route)"),
                status["code"],
                extra={
                    "method": scope["method"],
                    "route": getattr(route, "path", "(no route)"),
                    "status": status["code"],
                    "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                    "tenant_id": getattr(principal, "tenant_id", None),
                    "key_id": getattr(principal, "key_id", None),
                },
            )
            request_id_var.reset(token)
