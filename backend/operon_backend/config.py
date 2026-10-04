from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"
    # Per-request timeout for the Groq chat/completions call.
    groq_timeout_seconds: float = 30.0

    # After the embedding model fails to load (no network, blocked host,
    # corrupt cache), don't retry the download for this long: retrieval is
    # optional precedent, and a hanging download must not slow every cycle.
    embedding_retry_cooldown_seconds: float = 60.0

    # SQLite by default so this runs with zero external accounts. Point this
    # at a real Postgres/Neon URL later — the ORM code doesn't change.
    database_url: str = "sqlite:///./operon.db"


settings = Settings()
