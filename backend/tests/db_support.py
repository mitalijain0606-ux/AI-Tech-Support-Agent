"""Real PostgreSQL (with pgvector) and Redis for the tests that need them.

Resolution order, so the same tests run on a laptop, in CI and here:
  1. OPERON_TEST_POSTGRES_URL / OPERON_TEST_REDIS_URL  (CI service containers)
  2. the `pgserver` package (an embedded PostgreSQL that bundles pgvector) and a
     `redis-server` binary on PATH
  3. otherwise the test is skipped, with the reason.
"""

import argparse
import os
import shutil
import socket
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import pytest

from operon_backend.config import Settings
from operon_backend.db import alembic_config


def _postgres_admin_url() -> str:
    explicit = os.environ.get("OPERON_TEST_POSTGRES_URL")
    if explicit:
        return explicit
    try:
        import pgserver
    except ImportError:
        pytest.skip("no PostgreSQL: set OPERON_TEST_POSTGRES_URL or pip install pgserver")
    data = Path(tempfile.mkdtemp(prefix="operon-pg-"))
    server = pgserver.get_server(data, cleanup_mode="stop")
    return server.get_uri()


_admin_url: str | None = None


def new_postgres_database() -> str:
    """A fresh, empty database on a real PostgreSQL; returns its SQLAlchemy URL."""
    global _admin_url
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url

    if _admin_url is None:
        _admin_url = _postgres_admin_url()
    admin = make_url(Settings(database_url=_admin_url).sqlalchemy_url)
    name = f"operon_{uuid.uuid4().hex[:12]}"
    engine = create_engine(admin, isolation_level="AUTOCOMMIT")
    with engine.connect() as connection:
        connection.execute(text(f'CREATE DATABASE "{name}"'))
    engine.dispose()
    return admin.set(database=name).render_as_string(hide_password=False)


def migrate(url: str, revision: str = "head", *, downgrade: bool = False) -> None:
    """Runs the project's real Alembic migrations against `url`."""
    from alembic import command

    config = alembic_config()
    config.cmd_opts = argparse.Namespace(x=[f"url={url}"])
    (command.downgrade if downgrade else command.upgrade)(config, revision)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


_redis_proc = None
_redis_url: str | None = None


def redis_url() -> str:
    """URL of a real Redis (CI service, or a throwaway local redis-server)."""
    global _redis_proc, _redis_url
    explicit = os.environ.get("OPERON_TEST_REDIS_URL")
    if explicit:
        return explicit
    if _redis_url:
        return _redis_url
    binary = shutil.which("redis-server")
    if not binary:
        pytest.skip("no Redis: set OPERON_TEST_REDIS_URL or install redis-server")
    port = _free_port()
    _redis_proc = subprocess.Popen([binary, "--port", str(port), "--save", "", "--appendonly", "no", "--bind", "127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import redis

    for _ in range(100):
        try:
            redis.Redis(port=port).ping()
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.05)
    _redis_url = f"redis://127.0.0.1:{port}/0"
    return _redis_url


def stop_redis() -> None:
    if _redis_proc is not None:
        _redis_proc.terminate()
