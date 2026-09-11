from typing import Any

from pydantic import BaseModel, Field


class ConsoleEvidence(BaseModel):
    id: str
    level: str = "error"  # "error", "warn", "info"
    text: str
    url: str | None = None
    line: int | None = None
    column: int | None = None
    count: int = 1


class NetworkEvidence(BaseModel):
    id: str
    method: str
    url: str
    status: int
    status_text: str | None = None
    duration_ms: float | None = None
    failure_reason: str | None = None


class CookieSignal(BaseModel):
    """Metadata only — cookie values MUST NEVER be included."""
    id: str
    name: str
    domain: str
    path: str = "/"
    secure: bool = False
    http_only: bool = False
    same_site: str | None = None
    expires_at: float | None = None


class StorageSignal(BaseModel):
    """Storage shape and parse status only — raw values MUST NEVER be included."""
    id: str
    storage_type: str = "localStorage"  # "localStorage" | "sessionStorage"
    key: str
    present: bool = True
    parse_status: str = "valid_json"  # "valid_json" | "syntax_error" | "not_json" | "empty"
    error_message: str | None = None


class EvidenceBundle(BaseModel):
    url: str
    timestamp: float
    console: list[ConsoleEvidence] = Field(default_factory=list)
    network: list[NetworkEvidence] = Field(default_factory=list)
    cookies: list[CookieSignal] = Field(default_factory=list)
    storage: list[StorageSignal] = Field(default_factory=list)
    redaction_applied: list[str] = Field(default_factory=list)

    def all_evidence_ids(self) -> set[str]:
        ids: set[str] = set()
        for item in self.console:
            ids.add(item.id)
        for item in self.network:
            ids.add(item.id)
        for item in self.cookies:
            ids.add(item.id)
        for item in self.storage:
            ids.add(item.id)
        return ids


class ProposedAction(BaseModel):
    action_id: str
    params: dict[str, Any] = Field(default_factory=dict)


class Diagnosis(BaseModel):
    category: str
    root_cause: str
    reasoning: str
    evidence_ids: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    resolvable_automatically: bool
    proposed_action: ProposedAction | None = None


class DiagnoseRequest(BaseModel):
    message: str
    bundle: EvidenceBundle


class PolicyRequest(BaseModel):
    action_id: str
    params: dict[str, Any] = Field(default_factory=dict)
    provider_capabilities: list[str] = Field(default_factory=list)


class PolicyDecision(BaseModel):
    action_id: str
    decision: str  # "ALLOW" | "REQUIRE_APPROVAL" | "DENY"
    reason: str
    validated_params: dict[str, Any] = Field(default_factory=dict)
