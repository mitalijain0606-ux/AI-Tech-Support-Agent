"""baseline schema: sessions, knowledge_chunks, api_keys

Revision ID: 0001
Revises:
Create Date: 2026-10-10

Generated from the models with `alembic revision --autogenerate` and reviewed.
A database created by the application's own create_all (development) has the
same schema; stamp it with `alembic stamp 0001` to adopt migrations.
"""
from alembic import op
import sqlalchemy as sa


revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('api_keys',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('key_hash', sa.String(), nullable=False),
    sa.Column('key_prefix', sa.String(), nullable=False),
    sa.Column('tenant_id', sa.String(), nullable=False),
    sa.Column('subject', sa.String(), nullable=False),
    sa.Column('role', sa.String(), nullable=False),
    sa.Column('label', sa.String(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.Column('last_used_at', sa.DateTime(), nullable=True),
    sa.Column('revoked_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('api_keys', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_api_keys_key_hash'), ['key_hash'], unique=True)
        batch_op.create_index(batch_op.f('ix_api_keys_tenant_id'), ['tenant_id'], unique=False)

    op.create_table('knowledge_chunks',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('source_type', sa.String(), nullable=False),
    sa.Column('source_id', sa.String(), nullable=False),
    sa.Column('content_text', sa.String(), nullable=False),
    sa.Column('embedding', sa.JSON(), nullable=False),
    sa.Column('chunk_metadata', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('sessions',
    sa.Column('id', sa.String(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.Column('source', sa.String(), nullable=True),
    sa.Column('tenant_id', sa.String(), nullable=False),
    sa.Column('created_by', sa.String(), nullable=True),
    sa.Column('user_issue', sa.String(), nullable=False),
    sa.Column('conversation_history', sa.JSON(), nullable=True),
    sa.Column('issue_category', sa.String(), nullable=True),
    sa.Column('issue_subcategory', sa.String(), nullable=True),
    sa.Column('user_context', sa.JSON(), nullable=True),
    sa.Column('environment_context', sa.JSON(), nullable=True),
    sa.Column('known_facts', sa.JSON(), nullable=True),
    sa.Column('missing_information', sa.JSON(), nullable=True),
    sa.Column('collected_evidence', sa.JSON(), nullable=True),
    sa.Column('hypotheses', sa.JSON(), nullable=True),
    sa.Column('current_hypothesis_id', sa.String(), nullable=True),
    sa.Column('knowledge_references', sa.JSON(), nullable=True),
    sa.Column('diagnostic_steps', sa.JSON(), nullable=True),
    sa.Column('attempted_actions', sa.JSON(), nullable=True),
    sa.Column('pending_action', sa.JSON(), nullable=True),
    sa.Column('verification_state', sa.JSON(), nullable=True),
    sa.Column('confidence', sa.Float(), nullable=True),
    sa.Column('escalation_state', sa.JSON(), nullable=True),
    sa.Column('resolution_state', sa.String(), nullable=True),
    sa.Column('phase', sa.String(), nullable=False),
    sa.Column('phase_history', sa.JSON(), nullable=True),
    sa.Column('step_count', sa.Integer(), nullable=True),
    sa.Column('tool_call_count', sa.Integer(), nullable=True),
    sa.Column('llm_call_count', sa.Integer(), nullable=True),
    sa.Column('action_attempt_count', sa.Integer(), nullable=True),
    sa.Column('evidence_request', sa.JSON(), nullable=True),
    sa.Column('investigation_cycle', sa.Integer(), nullable=True),
    sa.Column('diagnoses', sa.JSON(), nullable=True),
    sa.Column('retrievals', sa.JSON(), nullable=True),
    sa.Column('policy_decision', sa.JSON(), nullable=True),
    sa.Column('approval', sa.JSON(), nullable=True),
    sa.Column('activity', sa.JSON(), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_sessions_tenant_id'), ['tenant_id'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_sessions_tenant_id'))

    op.drop_table('sessions')
    op.drop_table('knowledge_chunks')
    with op.batch_alter_table('api_keys', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_api_keys_tenant_id'))
        batch_op.drop_index(batch_op.f('ix_api_keys_key_hash'))

    op.drop_table('api_keys')
