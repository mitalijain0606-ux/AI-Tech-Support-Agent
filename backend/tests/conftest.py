import os
import pathlib

# Must happen before any `operon_backend.config` import anywhere — pydantic-
# settings reads this at Settings() construction time, which happens at
# module import. A dedicated file (not the dev operon.db, not :memory:,
# which is per-connection and breaks under SQLAlchemy's default pooling)
# keeps test runs isolated and repeatable.
_TEST_DB_PATH = pathlib.Path(__file__).parent.parent / "test_operon.db"
if _TEST_DB_PATH.exists():
    _TEST_DB_PATH.unlink()
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB_PATH}"

# Create tables directly rather than relying on FastAPI's lifespan handler
# firing — that only happens when TestClient is used as a context manager,
# which is an easy thing for a test file to forget.
from operon_backend.db import init_db

init_db()
