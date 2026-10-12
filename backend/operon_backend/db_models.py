"""The SupportSession from AGENT_ARCHITECTURE.md, as a real table — this
is what "persist important state server-side, don't put it only in a
prompt" means concretely. Field names match that doc's model directly.
"""

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, Float, Integer, String
from sqlalchemy.ext.mutable import MutableDict, MutableList
from sqlalchemy.orm import declarative_base
from sqlalchemy.types import JSON

Base = declarative_base()


class SessionRecord(Base):
    __tablename__ = "sessions"

    id = Column(String, primary_key=True)
    created_at = Column(DateTime, default=lambda: datetime.now(UTC))
    source = Column(String, default="github")

    # Who owns this session. Every read and write is checked against these on
    # the server (auth.py); a session of another tenant does not exist as far
    # as a caller is concerned.
    tenant_id = Column(String, nullable=False, default="public", index=True)
    created_by = Column(String, nullable=True)  # the creating principal's subject

    user_issue = Column(String, nullable=False)
    conversation_history = Column(MutableList.as_mutable(JSON), default=list)

    issue_category = Column(String, nullable=True)
    issue_subcategory = Column(String, nullable=True)
    user_context = Column(MutableDict.as_mutable(JSON), default=dict)
    environment_context = Column(MutableDict.as_mutable(JSON), default=dict)

    known_facts = Column(MutableList.as_mutable(JSON), default=list)
    missing_information = Column(MutableList.as_mutable(JSON), default=list)

    collected_evidence = Column(MutableList.as_mutable(JSON), default=list)
    hypotheses = Column(MutableList.as_mutable(JSON), default=list)
    current_hypothesis_id = Column(String, nullable=True)

    knowledge_references = Column(MutableList.as_mutable(JSON), default=list)

    diagnostic_steps = Column(MutableList.as_mutable(JSON), default=list)
    attempted_actions = Column(MutableList.as_mutable(JSON), default=list)
    pending_action = Column(MutableDict.as_mutable(JSON), nullable=True)
    verification_state = Column(MutableDict.as_mutable(JSON), nullable=True)

    confidence = Column(Float, default=0.0)
    escalation_state = Column(MutableDict.as_mutable(JSON), nullable=True)
    resolution_state = Column(String, nullable=True)

    phase = Column(String, nullable=False, default="UNDERSTANDING")
    phase_history = Column(MutableList.as_mutable(JSON), default=list)

    step_count = Column(Integer, default=0)
    tool_call_count = Column(Integer, default=0)
    llm_call_count = Column(Integer, default=0)
    action_attempt_count = Column(Integer, default=0)

    # Investigation loop (see investigation.py). Each has one producer and is
    # read back by the next stage, the API, or the history view:
    # - evidence_request: issued by the backend, answered by the provider
    # - investigation_cycle: evidence submissions so far (hard-limited)
    # - diagnoses / retrievals: per-cycle records, fed back to the model as history
    # - policy_decision / approval: gate execution of the pending action
    # - activity: append-only, secret-free record of every stage
    evidence_request = Column(MutableDict.as_mutable(JSON), nullable=True)
    investigation_cycle = Column(Integer, default=0)
    diagnoses = Column(MutableList.as_mutable(JSON), default=list)
    retrievals = Column(MutableList.as_mutable(JSON), default=list)
    policy_decision = Column(MutableDict.as_mutable(JSON), nullable=True)
    approval = Column(MutableDict.as_mutable(JSON), nullable=True)
    activity = Column(MutableList.as_mutable(JSON), default=list)


class KnowledgeChunk(Base):
    """The RAG store from production-architecture.md. `embedding` is a
    plain JSON float list for now — similarity is computed in Python
    (embeddings.py), not in the database. Moving to real Postgres +
    pgvector later is a column-type change and a query change, not a
    reshape of this table or of what gets embedded."""

    __tablename__ = "knowledge_chunks"

    id = Column(String, primary_key=True)
    source_type = Column(String, nullable=False)  # "kb" | "history"
    source_id = Column(String, nullable=False)
    content_text = Column(String, nullable=False)
    embedding = Column(MutableList.as_mutable(JSON), nullable=False)
    chunk_metadata = Column(MutableDict.as_mutable(JSON), default=dict)
    created_at = Column(DateTime, default=lambda: datetime.now(UTC))


class ApiKey(Base):
    """A credential for the Operon API. Only a SHA-256 hash of the token is
    stored (the token itself is shown once, when it is created), so a leaked
    database does not leak usable keys. See auth.py."""

    __tablename__ = "api_keys"

    id = Column(String, primary_key=True)
    key_hash = Column(String, nullable=False, unique=True, index=True)
    key_prefix = Column(String, nullable=False)  # first characters, to recognise a key in a list
    tenant_id = Column(String, nullable=False, index=True)
    subject = Column(String, nullable=False)  # the user this key acts as
    role = Column(String, nullable=False, default="user")  # viewer | user | admin
    label = Column(String, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(UTC))
    last_used_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)
