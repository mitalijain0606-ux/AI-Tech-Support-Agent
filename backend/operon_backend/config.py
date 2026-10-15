from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # "production" turns configuration problems that would be unsafe or broken
    # into a refusal to start (see `problems()`); development only warns.
    environment: Literal["development", "test", "production"] = "development"

    # Authentication. On by default: every session endpoint needs an API key
    # (see auth.py). Turn it off only for local development.
    auth_required: bool = True

    # Browser origins allowed to call the API from page JavaScript, comma
    # separated. Empty = none: the extension is not subject to CORS because its
    # manifest lists the backend's origin in host_permissions. "*" is for local
    # development only and is rejected in production.
    cors_allow_origins: str = ""

    # Requests per minute per caller (API key, else client IP). The LLM-backed
    # endpoints have their own, lower budget because each call costs money.
    rate_limit_per_minute: int = 120
    rate_limit_llm_per_minute: int = 20
    rate_limit_auth_failures_per_minute: int = 10
    # Read the client IP from X-Forwarded-For (only behind a proxy you trust), taking
    # the entry added by the Nth proxy from the right. Render: 1 hop.
    trust_forwarded_for: bool = False
    trusted_proxy_hops: int = 1
    # Shared state (rate limits, live events) across instances. Empty = in-process.
    redis_url: str = ""

    log_format: Literal["text", "json"] = "text"
    log_level: str = "INFO"

    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"
    # Per-request timeout for the Groq chat/completions call.
    groq_timeout_seconds: float = 30.0

    # After the embedding model fails to load (no network, blocked host,
    # corrupt cache), don't retry the download for this long: retrieval is
    # optional precedent, and a hanging download must not slow every cycle.
    embedding_retry_cooldown_seconds: float = 60.0

    # "combined": one grounded diagnose call per cycle (fewest calls — the free
    # tier is rate limited). "staged": separate Classify, Diagnose and Plan
    # calls, each scored on its own by eval.py. See staged.py.
    llm_pipeline: Literal["combined", "staged"] = "combined"

    # A remediation is only proposed when the diagnosis is at least this
    # confident; below it the session escalates to a human instead of acting
    # on a guess ("confidence thresholds routing to escalation").
    min_action_confidence: float = 0.5

    # Approximate token budget for the evidence shown to the model per cycle
    # (budget.py: filter, dedupe, truncate, prune, redact, then cap).
    evidence_token_budget: int = 8000

    # SQLite by default so this runs with zero external accounts. Any
    # SQLAlchemy URL works; `postgres://` / `postgresql://` URLs (what Neon and
    # Render hand out) are rewritten to the installed psycopg driver.
    database_url: str = "sqlite:///./operon.db"

    @property
    def sqlalchemy_url(self) -> str:
        url = self.database_url.strip()
        for prefix in ("postgres://", "postgresql://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url[len(prefix) :]
        return url

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]

    @property
    def is_sqlite(self) -> bool:
        return self.sqlalchemy_url.startswith("sqlite")

    def problems(self) -> list[tuple[str, str]]:
        """Configuration problems as (level, message); level is "error" (unsafe
        or broken: refuse to start in production) or "warning". Messages name
        the variable, never its value."""
        found: list[tuple[str, str]] = []
        prod = self.environment == "production"
        if prod and not self.auth_required:
            found.append(("error", "AUTH_REQUIRED is false: production must authenticate every session endpoint"))
        if prod and "*" in self.cors_origins:
            found.append(("error", "CORS_ALLOW_ORIGINS contains '*': production must list explicit origins (or none)"))
        if prod and not self.redis_url:
            found.append(("warning", "REDIS_URL is not set: rate limits and live events are per-instance (fine for one instance only)"))
        if prod and self.is_sqlite:
            found.append(("warning", "DATABASE_URL is SQLite: fine for a demo, but sessions are lost with the container's disk (use Postgres)"))
        if not self.groq_api_key.strip():
            found.append(("warning", "GROQ_API_KEY is not set: diagnoses use the labelled offline rule_based engine, not a language model"))
        return found


settings = Settings()
