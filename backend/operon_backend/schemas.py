from typing import Any, Literal, get_args

from pydantic import BaseModel, Field

HypothesisStatus = Literal["candidate", "supported", "contradicted", "confirmed", "rejected"]

# The closed set of evidence collectors a provider can be asked to run.
# Each one maps onto a policy action (see evidence.COLLECTOR_POLICY_ACTION),
# so collecting evidence goes through the same policy engine as remediation.
Collector = Literal["console", "network", "storage", "cookies", "page", "reload_observe"]
COLLECTORS: tuple[str, ...] = get_args(Collector)


class Hypothesis(BaseModel):
    hypothesis_id: str
    description: str
    confidence: float
    supporting_evidence_ids: list[str] = Field(default_factory=list)
    contradicting_evidence_ids: list[str] = Field(default_factory=list)
    required_tests: list[str] = Field(default_factory=list)
    status: HypothesisStatus = "candidate"


class ToolCallLog(BaseModel):
    intent: str
    reason: str
    tool: str
    expected_information: str
    at: str | None = None


# ---- Evidence -----------------------------------------------------------------


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


class PageSignal(BaseModel):
    """Derived page state only — never page text beyond a truncated title."""
    id: str
    url_path: str
    title: str | None = None
    ready_state: str | None = None
    service_worker_controlled: bool = False
    service_worker_scopes: list[str] = Field(default_factory=list)  # scope paths only
    selector: str | None = None
    selector_matches: int | None = None


class EvidenceBundle(BaseModel):
    url: str
    timestamp: float
    # Provenance: which collection produced this bundle and in answer to
    # which backend evidence request. Filled in by the backend if absent.
    bundle_id: str | None = None
    request_id: str | None = None
    collectors: list[str] = Field(default_factory=list)
    collection_errors: list[str] = Field(default_factory=list)  # e.g. "debugger_unavailable"
    console: list[ConsoleEvidence] = Field(default_factory=list)
    network: list[NetworkEvidence] = Field(default_factory=list)
    cookies: list[CookieSignal] = Field(default_factory=list)
    storage: list[StorageSignal] = Field(default_factory=list)
    page: list[PageSignal] = Field(default_factory=list)
    redaction_applied: list[str] = Field(default_factory=list)

    def items(self) -> list[tuple[str, BaseModel]]:
        """Every evidence item with its kind."""
        return [
            *(("console", i) for i in self.console),
            *(("network", i) for i in self.network),
            *(("cookies", i) for i in self.cookies),
            *(("storage", i) for i in self.storage),
            *(("page", i) for i in self.page),
        ]

    def all_evidence_ids(self) -> set[str]:
        return {item.id for _, item in self.items()}


class EvidenceRequestParams(BaseModel):
    storage_keys: list[str] = Field(default_factory=list, max_length=10)
    selector: str | None = Field(default=None, max_length=200)
    observe_ms: int = Field(default=4000, ge=1000, le=8000)


class EvidenceRequest(BaseModel):
    """What the backend asks the provider to collect next. The provider
    collects exactly these collectors and nothing else."""
    request_id: str
    purpose: Literal["initial", "information", "retry"]
    collectors: list[Collector]
    params: EvidenceRequestParams = Field(default_factory=EvidenceRequestParams)
    reason: str
    requires_user_action: bool = False  # e.g. "reproduce the problem now"
    cycle: int = 0


class InformationRequest(BaseModel):
    """The model's structured way of saying "I don't have enough evidence
    yet" — validated and bounded before it becomes an EvidenceRequest."""
    collectors: list[str]
    params: dict[str, Any] = Field(default_factory=dict)
    reason: str
    requires_user_action: bool = False


# ---- Diagnosis + remediation ----------------------------------------------------


class ProposedAction(BaseModel):
    action_id: str
    params: dict[str, Any] = Field(default_factory=dict)


class Diagnosis(BaseModel):
    category: str
    root_cause: str
    reasoning: str
    evidence_ids: list[str] = Field(default_factory=list)
    # Retrieved knowledge chunk ids that informed this diagnosis — precedent,
    # never a substitute for evidence_ids. See AGENT_ARCHITECTURE.md's
    # "what retrieval does and does not get to do."
    knowledge_refs: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    resolvable_automatically: bool
    proposed_action: ProposedAction | None = None
    information_request: InformationRequest | None = None
    # Set by the backend, never by the model: "groq" or "rule_based".
    engine: str = "groq"


class CitedEvidence(BaseModel):
    """The exact evidence items a remediation claims to fix — embedded in the
    plan so verification never depends on a client-side baseline."""
    console: list[ConsoleEvidence] = Field(default_factory=list)
    network: list[NetworkEvidence] = Field(default_factory=list)
    cookies: list[CookieSignal] = Field(default_factory=list)
    storage: list[StorageSignal] = Field(default_factory=list)
    page: list[PageSignal] = Field(default_factory=list)

    def is_empty(self) -> bool:
        return not (self.console or self.network or self.cookies or self.storage or self.page)


VerificationStrategy = Literal["storage_recheck", "reobserve_cited", "service_worker_recheck"]


class VerificationPlan(BaseModel):
    strategy: VerificationStrategy
    cited_evidence: CitedEvidence
    storage_keys: list[str] = Field(default_factory=list)
    service_worker_scope: str | None = None
    observe_ms: int = 4000


class RemediationProposal(BaseModel):
    proposal_id: str = ""
    diagnosis: str
    evidence_ids: list[str] = Field(default_factory=list)
    knowledge_refs: list[str] = Field(default_factory=list)
    action_id: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    target: dict[str, Any] = Field(default_factory=dict)
    rationale: str = ""
    expected_effect: str
    risk: str = "unknown"
    verification_predicate: str
    verification: VerificationPlan | None = None
    requires_approval: bool = True  # informational only — policy.py decides for real
    attempt: int = 1
    retry_of: str | None = None
    retry_reason: str | None = None


# ---- Verification observation (submitted by the provider) ---------------------


class StorageState(BaseModel):
    key: str
    present: bool
    parse_status: str
    error_message: str | None = None


class VerificationObservation(BaseModel):
    """What the provider observed after an action. The backend — not the
    provider — decides whether this means the cited problem is gone."""
    console: list[ConsoleEvidence] = Field(default_factory=list, max_length=200)
    network: list[NetworkEvidence] = Field(default_factory=list, max_length=200)
    storage: list[StorageState] | None = None  # None: storage was not re-checked
    service_worker_scopes: list[str] | None = None  # None: not re-checked
    observed_ms: int | None = None
    error: str | None = None  # e.g. "debugger_unavailable", "tab_unreachable", "interrupted"


# ---- Legacy stateless API ----------------------------------------------------------


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


# ---- SupportSession API ----------------------------------------------------------


class CreateSessionRequest(BaseModel):
    user_issue: str = Field(min_length=1, max_length=4000)
    source: str = "github"
    # What this provider build can do. Stored on the session; the backend
    # evaluates policy against these, not against per-request claims.
    provider_capabilities: list[str] | None = None
    collectors: list[str] | None = None


class SubmitEvidenceRequest(BaseModel):
    bundle: EvidenceBundle


class SessionPolicyRequest(BaseModel):
    """The policy check always evaluates the session's own pending action.
    action_id/params, if sent, must match it."""
    action_id: str | None = None
    params: dict[str, Any] | None = None
    provider_capabilities: list[str] | None = None


class ApprovalRequest(BaseModel):
    approved: bool


class ActionResultRequest(BaseModel):
    action_id: str
    succeeded: bool
    detail: str = Field(default="", max_length=1000)


class VerifyRequest(BaseModel):
    action_id: str
    observation: VerificationObservation


class SessionOut(BaseModel):
    session_id: str
    phase: str
    user_issue: str
    issue_category: str | None = None
    hypotheses: list[dict[str, Any]] = Field(default_factory=list)
    current_hypothesis_id: str | None = None
    knowledge_references: list[str] = Field(default_factory=list)
    evidence_request: dict[str, Any] | None = None
    evidence_bundles: list[dict[str, Any]] = Field(default_factory=list)
    investigation_cycle: int = 0
    diagnoses: list[dict[str, Any]] = Field(default_factory=list)
    retrievals: list[dict[str, Any]] = Field(default_factory=list)
    pending_action: dict[str, Any] | None = None
    policy_decision: dict[str, Any] | None = None
    approval: dict[str, Any] | None = None
    verification_state: dict[str, Any] | None = None
    escalation_state: dict[str, Any] | None = None
    resolution_state: str | None = None
    confidence: float = 0.0
    phase_history: list[dict[str, Any]] = Field(default_factory=list)
    diagnostic_steps: list[dict[str, Any]] = Field(default_factory=list)
    attempted_actions: list[dict[str, Any]] = Field(default_factory=list)
    activity: list[dict[str, Any]] = Field(default_factory=list)
    step_count: int = 0
    tool_call_count: int = 0
    llm_call_count: int = 0
    action_attempt_count: int = 0
