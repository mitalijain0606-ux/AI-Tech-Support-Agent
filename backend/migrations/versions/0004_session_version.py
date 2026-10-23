"""sessions.version: optimistic concurrency for session updates

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-17

Every update of a session row is conditional on the version it read (SQLAlchemy
version_id_col). Existing rows start at 0.
"""
from alembic import op
import sqlalchemy as sa


revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.add_column(sa.Column('version', sa.Integer(), server_default='0', nullable=False))


def downgrade() -> None:
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.drop_column('version')
