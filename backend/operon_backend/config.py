from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"

    # SQLite by default so this runs with zero external accounts. Point this
    # at a real Postgres/Neon URL later — the ORM code doesn't change.
    database_url: str = "sqlite:///./operon.db"


settings = Settings()
