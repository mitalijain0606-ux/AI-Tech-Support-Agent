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
