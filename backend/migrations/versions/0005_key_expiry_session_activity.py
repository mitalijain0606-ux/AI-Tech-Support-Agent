"""api_keys.expires_at, sessions.updated_at, sessions.additional_issues, inflight_model_calls

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-25

Key expiry, idle-session expiry and multi-issue complaints. All three columns are
nullable, so existing rows stay valid: a key without expires_at never expires, and a
session without updated_at is measured from created_at. inflight_model_calls lets a model
call cut off by a restart count against the session's budget.
"""
from alembic import op
import sqlalchemy as sa


revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'inflight_model_calls',
        sa.Column('session_id', sa.String(), nullable=False),
        sa.Column('started_at', sa.DateTime(), nullable=False),
        sa.Column('process_id', sa.String(), nullable=False),
        sa.PrimaryKeyConstraint('session_id'),
    )
    with op.batch_alter_table('api_keys', schema=None) as batch_op:
        batch_op.add_column(sa.Column('expires_at', sa.DateTime(), nullable=True))
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.add_column(sa.Column('updated_at', sa.DateTime(), nullable=True))
        batch_op.add_column(sa.Column('additional_issues', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_table('inflight_model_calls')
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.drop_column('additional_issues')
        batch_op.drop_column('updated_at')
    with op.batch_alter_table('api_keys', schema=None) as batch_op:
        batch_op.drop_column('expires_at')
