"""pgvector: indexed similarity search on PostgreSQL

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-10

PostgreSQL only; a no-op on SQLite (which keeps the in-process scan).

The authoritative embedding stays the JSON list in knowledge_chunks.embedding,
so nothing about how chunks are written changes. This migration adds a
`vector(384)` mirror column, a trigger that keeps it in sync on every insert or
update of `embedding`, and an HNSW index for cosine distance. retrieval.search
uses the column for candidate generation when it exists and falls back to the
scan when it does not.

384 is the dimension of all-MiniLM-L6-v2 (embeddings.EMBEDDING_DIM). Changing
the model means a new migration, not an edit of this one.
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("ALTER TABLE knowledge_chunks ADD COLUMN embedding_vec vector(384)")
    # JSON '[0.1, 0.2]' and pgvector's text form '[0.1,0.2]' are the same notation.
    op.execute("UPDATE knowledge_chunks SET embedding_vec = embedding::text::vector")
    op.execute(
        """
        CREATE FUNCTION operon_sync_embedding_vec() RETURNS trigger AS $$
        BEGIN
            NEW.embedding_vec := NEW.embedding::text::vector;
            RETURN NEW;
        END
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        CREATE TRIGGER knowledge_chunks_sync_vec
        BEFORE INSERT OR UPDATE OF embedding ON knowledge_chunks
        FOR EACH ROW EXECUTE FUNCTION operon_sync_embedding_vec()
        """
    )
    op.execute("CREATE INDEX ix_knowledge_chunks_embedding_vec ON knowledge_chunks USING hnsw (embedding_vec vector_cosine_ops)")


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("DROP TRIGGER IF EXISTS knowledge_chunks_sync_vec ON knowledge_chunks")
    op.execute("DROP FUNCTION IF EXISTS operon_sync_embedding_vec()")
    op.execute("DROP INDEX IF EXISTS ix_knowledge_chunks_embedding_vec")
    op.execute("ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS embedding_vec")
