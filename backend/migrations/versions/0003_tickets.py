"""tickets: escalation hand-off records

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-14

One row per escalated session, holding the structured (redacted) escalation
report and its triage status. See operon_backend/tickets.py.
"""
from alembic import op
import sqlalchemy as sa


revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('tickets',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('session_id', sa.String(), nullable=False),
    sa.Column('tenant_id', sa.String(), nullable=False),
    sa.Column('created_by', sa.String(), nullable=True),
    sa.Column('status', sa.String(), nullable=False),
    sa.Column('resolution_state', sa.String(), nullable=True),
    sa.Column('reason', sa.String(), nullable=True),
    sa.Column('category', sa.String(), nullable=True),
    sa.Column('report', sa.JSON(), nullable=False),
    sa.Column('status_history', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.Column('updated_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('tickets', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_tickets_session_id'), ['session_id'], unique=True)
        batch_op.create_index(batch_op.f('ix_tickets_tenant_id'), ['tenant_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('tickets', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_tickets_tenant_id'))
        batch_op.drop_index(batch_op.f('ix_tickets_session_id'))

    op.drop_table('tickets')
