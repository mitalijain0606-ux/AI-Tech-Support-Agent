"""Schema migrations (Alembic) on SQLite and on a real PostgreSQL with pgvector."""

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text

import db_support
from operon_backend import db as db_module
from operon_backend.config import settings
from operon_backend.db_models import Base

EXPECTED_TABLES = {"sessions", "knowledge_chunks", "api_keys"}


@pytest.fixture
def sqlite_url(tmp_path):
    return f"sqlite:///{tmp_path / 'migrated.db'}"


def tables(url):
    engine = create_engine(url)
    try:
        return set(inspect(engine).get_table_names())
    finally:
        engine.dispose()


# ---- SQLite ---------------------------------------------------------------------------------------


def test_migrations_build_exactly_the_schema_the_models_describe(sqlite_url):
    db_support.migrate(sqlite_url)
    assert tables(sqlite_url) >= EXPECTED_TABLES
    engine = create_engine(sqlite_url)
    with engine.connect() as connection:
        diff = compare_metadata(MigrationContext.configure(connection), Base.metadata)
    engine.dispose()
    assert diff == [], f"models and migrations disagree: {diff}"


def test_migrations_can_be_undone(sqlite_url):
    db_support.migrate(sqlite_url)
    db_support.migrate(sqlite_url, "base", downgrade=True)
    assert tables(sqlite_url) - {"alembic_version"} == set()


def test_applying_migrations_twice_is_harmless(sqlite_url):
    db_support.migrate(sqlite_url)
    db_support.migrate(sqlite_url)
    engine = create_engine(sqlite_url)
    assert db_module.schema_state(engine)[0] == db_module.schema_state(engine)[1]
    engine.dispose()


def test_a_production_server_refuses_a_database_that_is_behind(sqlite_url, monkeypatch):
    engine = create_engine(sqlite_url)
    monkeypatch.setattr(db_module, "engine", engine)
    monkeypatch.setattr(settings, "environment", "production")
    with pytest.raises(RuntimeError, match="alembic upgrade head"):
        db_module.init_db()
    assert tables(sqlite_url) == set()  # and it created nothing behind the operator's back

    db_support.migrate(sqlite_url)
    db_module.init_db()  # at head: starts
    engine.dispose()


def test_development_creates_tables_directly(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'dev.db'}"
    engine = create_engine(url)
    monkeypatch.setattr(db_module, "engine", engine)
    monkeypatch.setattr(settings, "environment", "development")
    db_module.init_db()
    assert tables(url) >= EXPECTED_TABLES
    engine.dispose()


def test_legacy_sessions_without_a_tenant_are_assigned_to_public(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'legacy.db'}"
    engine = create_engine(url)
    with engine.begin() as connection:  # a pre-tenant database
        connection.execute(text("CREATE TABLE sessions (id VARCHAR PRIMARY KEY, user_issue VARCHAR NOT NULL, phase VARCHAR NOT NULL)"))
        connection.execute(text("INSERT INTO sessions VALUES ('old', 'x', 'RESOLVED')"))
    monkeypatch.setattr(db_module, "engine", engine)
    db_module.init_db()
    with engine.connect() as connection:
        assert connection.execute(text("SELECT tenant_id FROM sessions WHERE id = 'old'")).scalar() == "public"
    engine.dispose()


# ---- PostgreSQL + pgvector ----------------------------------------------------------------------------------------


@pytest.fixture
def pg_url():
    return db_support.new_postgres_database()


def test_postgres_migrations_create_the_schema_and_pgvector(pg_url):
    db_support.migrate(pg_url)
    engine = create_engine(pg_url)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).scalar()
        udt = connection.execute(
            text("SELECT udt_name FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'embedding_vec'")
        ).scalar()
        assert udt == "vector"
        indexes = connection.execute(text("SELECT indexdef FROM pg_indexes WHERE tablename = 'knowledge_chunks'")).scalars().all()
        assert any("hnsw" in d and "vector_cosine_ops" in d for d in indexes)
    assert tables(pg_url) >= EXPECTED_TABLES
    engine.dispose()


def test_the_vector_column_follows_the_json_embedding_automatically(pg_url):
    db_support.migrate(pg_url)
    engine = create_engine(pg_url)
    first = [1.0] + [0.0] * 383
    second = [0.0, 1.0] + [0.0] * 382
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO knowledge_chunks (id, source_type, source_id, content_text, embedding) VALUES ('c', 'kb', 's', 't', CAST(:e AS json))"), {"e": str(first).replace("'", "")})
        assert connection.execute(text("SELECT embedding_vec::text FROM knowledge_chunks WHERE id = 'c'")).scalar().startswith("[1,0,0")
        connection.execute(text("UPDATE knowledge_chunks SET embedding = CAST(:e AS json) WHERE id = 'c'"), {"e": str(second).replace("'", "")})
        assert connection.execute(text("SELECT embedding_vec::text FROM knowledge_chunks WHERE id = 'c'")).scalar().startswith("[0,1,0")
        # a vector of the wrong size is refused by the database, not silently stored
        with pytest.raises(Exception, match="dimension"):
            with connection.begin_nested():
                connection.execute(text("UPDATE knowledge_chunks SET embedding = CAST('[1,2,3]' AS json) WHERE id = 'c'"))
    engine.dispose()


def test_postgres_migrations_downgrade_cleanly(pg_url):
    db_support.migrate(pg_url)
    db_support.migrate(pg_url, "0001", downgrade=True)
    engine = create_engine(pg_url)
    with engine.connect() as connection:
        assert "embedding_vec" not in {c["name"] for c in inspect(connection).get_columns("knowledge_chunks")}
    assert tables(pg_url) >= EXPECTED_TABLES
    engine.dispose()


def test_a_production_server_checks_the_postgres_schema_too(pg_url, monkeypatch):
    engine = create_engine(pg_url)
    monkeypatch.setattr(db_module, "engine", engine)
    monkeypatch.setattr(settings, "environment", "production")
    with pytest.raises(RuntimeError, match="alembic upgrade head"):
        db_module.init_db()
    db_support.migrate(pg_url)
    db_module.init_db()
    engine.dispose()
