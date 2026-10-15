from typing import Annotated, Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

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

# Bounds on every provider-supplied string. The extension already truncates
# far below these (500 chars); the backend enforces them anyway so no client
# can push megabytes into storage or the model prompt. Over-long → 422.
Id = Annotated[str, StringConstraints(max_length=64)]
Short = Annotated[str, StringConstraints(max_length=200)]
Text = Annotated[str, StringConstraints(max_length=2000)]


class ConsoleEvidence(BaseModel):
    id: Id
    level: Short = "error"  # "error", "warn", "info"
    text: Text
    url: Text | None = None
    line: int | None = None
    column: int | None = None
    count: int = 1


class NetworkEvidence(BaseModel):
    id: Id
    method: Short
    url: Text
    status: int
    status_text: Short | None = None
    duration_ms: float | None = None
    failure_reason: Text | None = None


class CookieSignal(BaseModel):
    """Metadata only — cookie values MUST NEVER be included."""
    id: Id
    name: Short
    domain: Short
    path: Text = "/"
    secure: bool = False
    http_only: bool = False
    same_site: Short | None = None
    expires_at: float | None = None


class StorageSignal(BaseModel):
    """Storage shape and parse status only — raw values MUST NEVER be included."""
    id: Id
    storage_type: Short = "localStorage"  # "localStorage" | "sessionStorage"
    key: Short
    present: bool = True
    parse_status: Short = "valid_json"  # "valid_json" | "syntax_error" | "not_json" | "empty"
    error_message: Text | None = None


class PageSignal(BaseModel):
    """Derived page state only — never page text beyond a truncated title."""
    id: Id
    url_path: Text
    title: Short | None = None
    ready_state: Short | None = None
    service_worker_controlled: bool = False
    service_worker_scopes: list[Text] = Field(default_factory=list, max_length=20)  # scope paths only
    selector: Short | None = None
    selector_matches: int | None = None


class EvidenceBundle(BaseModel):
    url: Text
    timestamp: float
    # Provenance: which collection produced this bundle and in answer to
    # which backend evidence request. Filled in by the backend if absent.
    bundle_id: Id | None = None
    request_id: Id | None = None
    collectors: list[Short] = Field(default_factory=list, max_length=20)
    collection_errors: list[Short] = Field(default_factory=list, max_length=20)  # e.g. "debugger_unavailable"
    console: list[ConsoleEvidence] = Field(default_factory=list)
    network: list[NetworkEvidence] = Field(default_factory=list)
    cookies: list[CookieSignal] = Field(default_factory=list)
    storage: list[StorageSignal] = Field(default_factory=list)
    page: list[PageSignal] = Field(default_factory=list)
    redaction_applied: list[Short] = Field(default_factory=list, max_length=50)

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
    # An optional free-text question for the user, shown with the request. The
    # answer (POST /api/sessions/{id}/answer) is context for the next diagnosis;
    # the evidence collection never waits on it.
    question: str | None = Field(default=None, max_length=300)


class InformationRequest(BaseModel):
    """The model's structured way of saying "I don't have enough evidence
    yet" — validated and bounded before it becomes an EvidenceRequest."""
    collectors: list[str]
    params: dict[str, Any] = Field(default_factory=dict)
    reason: str
    requires_user_action: bool = False
    question: str | None = None  # validated by signals.question_problems before use


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
    key: Short
    present: bool
    parse_status: Short
    error_message: Text | None = None


class VerificationObservation(BaseModel):
    """What the provider observed after an action. The backend — not the
    provider — decides whether this means the cited problem is gone.
    Unknown fields are rejected: a provider can't slip in "passed" or "outcome"."""
    model_config = ConfigDict(extra="forbid")

    console: list[ConsoleEvidence] = Field(default_factory=list, max_length=200)
    network: list[NetworkEvidence] = Field(default_factory=list, max_length=200)
    storage: list[StorageState] | None = Field(default=None, max_length=25)  # None: storage was not re-checked
    service_worker_scopes: list[Text] | None = Field(default=None, max_length=20)  # None: not re-checked
    observed_ms: int | None = None
    error: Short | None = None  # e.g. "debugger_unavailable", "tab_unreachable", "interrupted"


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


class AnswerRequest(BaseModel):
    """The user's reply to the question attached to the outstanding evidence request."""
    request_id: str = Field(max_length=64)
    answer: str = Field(min_length=1, max_length=1000)


class ApprovalRequest(BaseModel):
    approved: bool
    # The plan this decision is about. Optional for older clients; when given,
    # a decision on a plan that has since been replaced is rejected (409).
    proposal_id: str | None = Field(default=None, max_length=64)


class TicketStatusRequest(BaseModel):
    """An admin's triage decision on an escalation ticket."""
    model_config = ConfigDict(extra="forbid")
    status: Literal["open", "acknowledged", "closed"]
    note: str | None = Field(default=None, max_length=500)


class ActionResultRequest(BaseModel):
    action_id: str
    succeeded: bool
    detail: str = Field(default="", max_length=1000)


class VerifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")  # the verdict is the backend's: no client "passed"/"outcome"

    action_id: str
    observation: VerificationObservation


class SessionOut(BaseModel):
    session_id: str
    phase: str
    user_issue: str
    # Which integration created the session ("extension", "sdk", ...) and what that provider
    # declared it can do. Informational: policy is evaluated against the stored capabilities.
    source: str | None = None
    provider_capabilities: list[str] = Field(default_factory=list)
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
