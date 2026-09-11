"""KnowledgeDocument — the restructured shape from AGENT_ARCHITECTURE.md's
knowledge-base section. This is deliberately richer than a FAQ entry: a
troubleshooting document carries the diagnostic procedure, not just an
answer.
"""

from pydantic import BaseModel, Field


class KnowledgeDocument(BaseModel):
    doc_id: str
    title: str
    symptoms: list[str] = Field(default_factory=list)
    causes: list[str] = Field(default_factory=list)
    diagnostic_checks: list[str] = Field(default_factory=list)
    evidence_patterns: list[str] = Field(default_factory=list)
    recommended_actions: list[str] = Field(default_factory=list)
    prerequisites: list[str] = Field(default_factory=list)
    contraindications: list[str] = Field(default_factory=list)
    verification_predicates: list[str] = Field(default_factory=list)
    escalation_conditions: list[str] = Field(default_factory=list)

    def to_embedding_text(self) -> str:
        """What actually gets embedded — symptoms and evidence patterns
        weighted most heavily, since that's what a query (a user complaint
        + observed evidence) most resembles."""
        parts = [
            self.title,
            "Symptoms: " + "; ".join(self.symptoms),
            "Evidence patterns: " + "; ".join(self.evidence_patterns),
            "Causes: " + "; ".join(self.causes),
        ]
        return "\n".join(p for p in parts if p.strip())


# Restructured from docs/plan/github-scenarios.md's two implemented
# scenarios — the content already existed, this just gives it the shape
# a diagnostic step can actually search against.
SEED_DOCUMENTS: list[KnowledgeDocument] = [
    KnowledgeDocument(
        doc_id="kb_corrupted_cache",
        title="Corrupted cached config in localStorage",
        symptoms=[
            "dashboard looks corrupted or blank",
            "page fails during initialization",
            "UI components that read cached config don't render",
        ],
        causes=[
            "a previous bad deploy or crash left a malformed JSON string in localStorage",
        ],
        diagnostic_checks=[
            "read the storage key and attempt to JSON.parse it",
            "check the browser console for a SyntaxError at page load",
        ],
        evidence_patterns=[
            "console error containing 'SyntaxError' and 'JSON'",
            "storage signal with parse_status == 'syntax_error'",
        ],
        recommended_actions=["clear_storage_key"],
        prerequisites=["the specific corrupted key must be known, not guessed"],
        contraindications=[
            "never clear all storage — only the specific key showing a parse failure",
        ],
        verification_predicates=[
            "the storage key either no longer exists or parses as valid JSON",
            "no SyntaxError appears in the console after reload",
        ],
        escalation_conditions=[
            "the same key becomes corrupted again immediately after clearing (likely a server-side bug, not a client-side cache issue)",
        ],
    ),
    KnowledgeDocument(
        doc_id="kb_blocked_by_client",
        title="Browser extension blocking network requests",
        symptoms=[
            "parts of the page never load",
            "some content silently missing with no visible error banner",
        ],
        causes=[
            "an ad blocker or privacy extension the user has installed is cancelling requests to this domain",
        ],
        diagnostic_checks=[
            "inspect network requests for ones that never received a response",
            "check for net::ERR_BLOCKED_BY_CLIENT or a CDP blockedReason",
        ],
        evidence_patterns=[
            "network entry with status == 0 and status_text mentioning 'blocked'",
        ],
        recommended_actions=[],
        prerequisites=[],
        contraindications=[
            "never attempt to disable another browser extension — this is not a capability Operon has",
        ],
        verification_predicates=[
            "the previously blocked request succeeds after the user adjusts their blocker settings",
        ],
        escalation_conditions=[
            "the user reports no ad blocker or privacy extension installed — the block may be server-side (CORS) instead",
        ],
    ),
]
