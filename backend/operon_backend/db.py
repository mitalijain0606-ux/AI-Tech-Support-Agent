from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

from operon_backend.config import settings

connect_args = {"check_same_thread": False} if settings.is_sqlite else {}
# pool_pre_ping: a managed Postgres drops idle connections; check before reuse.
engine = create_engine(settings.sqlalchemy_url, connect_args=connect_args, pool_pre_ping=not settings.is_sqlite)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def _add_missing_columns() -> None:
    """Additive-only schema upgrade for databases created before a column
    existed (there is no migration tool yet — see production-architecture.md).
    Never drops or alters existing columns."""
    from operon_backend.db_models import Base

    inspector = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not inspector.has_table(table.name):
                continue
            existing = {c["name"] for c in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name not in existing:
                    column_type = column.type.compile(dialect=engine.dialect)
                    conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN "{column.name}" {column_type}'))


def alembic_config():
    from pathlib import Path

    from alembic.config import Config

    root = Path(__file__).resolve().parent.parent
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    return config


def schema_state(target_engine=None) -> tuple[str | None, str | None]:
    """(revision the database is at, latest revision the code knows)."""
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory

    head = ScriptDirectory.from_config(alembic_config()).get_current_head()
    with (target_engine or engine).connect() as connection:
        return MigrationContext.configure(connection).get_current_revision(), head


def init_db() -> None:
    """Development and tests: create the tables directly. Production: the schema
    is managed only by migrations (`alembic upgrade head`); the server refuses
    to start against a database that is behind rather than guessing."""
    from operon_backend.db_models import Base

    if settings.environment == "production":
        current, head = schema_state()
        if current != head:
            raise RuntimeError(
                f"Database schema is at revision {current or 'none'} but the code needs {head}. Run `alembic upgrade head` first."
            )
        return
    Base.metadata.create_all(bind=engine)
    _add_missing_columns()
    # Sessions created before tenants existed belong to the "public" tenant
    # (what a caller is when authentication is off). Idempotent.
    with engine.begin() as conn:
        conn.execute(text("UPDATE sessions SET tenant_id = 'public' WHERE tenant_id IS NULL"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
