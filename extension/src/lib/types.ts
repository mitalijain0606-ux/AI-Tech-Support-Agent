// Mirrors backend/operon_backend/schemas.py. The backend is authoritative for
// every session field; the extension only renders it and does what it asks.

// ---- Evidence -------------------------------------------------------------------

export interface ConsoleEvidence {
  id: string;
  level: "error" | "warn" | "info";
  text: string;
}

export interface NetworkEvidence {
  id: string;
  method: string;
  url: string;
  status: number;
  status_text?: string;
}

export interface CookieSignal {
  id: string;
  name: string;
  domain: string;
  path?: string;
  secure?: boolean;
  http_only?: boolean;
  same_site?: string;
  expires_at?: number;
  // NOTE: a cookie's value is intentionally never a field here — Contract 1a.
}

export type ParseStatus = "valid_json" | "syntax_error" | "not_json" | "empty";

export interface StorageSignal {
  id: string;
  key: string;
  present: boolean;
  parse_status: ParseStatus;
  error_message?: string;
  // NOTE: the raw stored value is intentionally never a field here — Contract 1a.
}

export interface PageSignal {
  id: string;
  url_path: string;
  title?: string | null;
  ready_state?: string | null;
  service_worker_controlled: boolean;
  service_worker_scopes: string[]; // scope paths only
  selector?: string | null;
  selector_matches?: number | null;
}

export type Collector = "console" | "network" | "storage" | "cookies" | "page" | "reload_observe";

export interface EvidenceBundle {
  url: string;
  timestamp: number;
  bundle_id: string;
  request_id: string | null;
  collectors: Collector[];
  collection_errors: string[];
  console: ConsoleEvidence[];
  network: NetworkEvidence[];
  cookies: CookieSignal[];
  storage: StorageSignal[];
  page: PageSignal[];
  redaction_applied: string[];
}

export interface EvidenceRequest {
  request_id: string;
  purpose: "initial" | "information" | "retry";
  collectors: Collector[];
  params: { storage_keys: string[]; selector: string | null; observe_ms: number };
  reason: string;
  requires_user_action: boolean;
  cycle: number;
  question?: string | null;
}

// ---- Diagnosis + remediation ------------------------------------------------------

export interface ProposedAction {
  action_id: string;
  params: Record<string, unknown>;
}

export type DiagnosisCategory =
  | "storage_corruption"
  | "auth_failure"
  | "network_error"
  | "blocked_by_client"
  | "dom_error"
  | "service_worker_stale"
  | "insufficient_evidence"
  | "unknown";

export interface Diagnosis {
  // The backend schema is a free string; these are the values it documents.
  category: DiagnosisCategory | (string & {});
  root_cause: string;
  reasoning: string;
  evidence_ids: string[];
  // Retrieved knowledge chunk ids cited as precedent — never evidence.
  knowledge_refs: string[];
  confidence: number;
  resolvable_automatically: boolean;
  proposed_action: ProposedAction | null;
  information_request: { collectors: string[]; reason: string; requires_user_action: boolean } | null;
  engine: "groq" | "rule_based" | (string & {});
}

export interface PolicyDecision {
  action_id: string;
  decision: "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
  reason: string;
  validated_params: Record<string, unknown>;
}

export interface CitedEvidence {
  console: ConsoleEvidence[];
  network: NetworkEvidence[];
  cookies: CookieSignal[];
  storage: StorageSignal[];
  page: PageSignal[];
}

export interface VerificationPlan {
  strategy: "storage_recheck" | "reobserve_cited" | "service_worker_recheck";
  cited_evidence: CitedEvidence;
  storage_keys: string[];
  service_worker_scope: string | null;
  observe_ms: number;
}

export interface RemediationProposal {
  proposal_id: string;
  diagnosis: string;
  evidence_ids: string[];
  knowledge_refs: string[];
  action_id: string;
  parameters: Record<string, unknown>;
  target: Record<string, unknown>;
  rationale: string;
  expected_effect: string;
  risk: string;
  verification_predicate: string;
  verification: VerificationPlan | null;
  requires_approval: boolean; // informational only — the Policy Engine decides
  attempt: number;
  retry_of: string | null;
  retry_reason: string | null;
}

export interface StorageState {
  key: string;
  present: boolean;
  parse_status: ParseStatus;
  error_message?: string;
}

// What the extension observed after an action. The backend decides what it means.
export interface VerificationObservation {
  console: ConsoleEvidence[];
  network: NetworkEvidence[];
  storage?: StorageState[] | null;
  service_worker_scopes?: string[] | null;
  observed_ms?: number | null;
  error?: string | null;
}

// ---- Backend SupportSession -----------------------------------------------------------

// backend/operon_backend/state_machine.py SessionPhase — the source of truth.
export const BACKEND_PHASES = [
  "UNDERSTANDING",
  "KNOWLEDGE_LOOKUP",
  "NEED_INFORMATION",
  "INVESTIGATING",
  "HYPOTHESIS_FORMED",
  "DIAGNOSING",
  "ACTION_PROPOSED",
  "WAITING_FOR_APPROVAL",
  "EXECUTING",
  "VERIFYING",
  "RESOLVED",
  "ESCALATED",
] as const;
export type BackendPhase = (typeof BACKEND_PHASES)[number];

export interface Hypothesis {
  hypothesis_id: string;
  description: string;
  confidence: number;
  supporting_evidence_ids: string[];
  contradicting_evidence_ids: string[];
  required_tests: string[];
  status: "candidate" | "supported" | "contradicted" | "confirmed" | "rejected";
}

export interface PhaseTransition {
  from: BackendPhase;
  to: BackendPhase;
  reason: string;
  at: string;
}

export interface AttemptedAction {
  proposal_id?: string;
  action_id: string | null;
  params?: Record<string, unknown>;
  succeeded: boolean;
  verified?: boolean | null;
  detail: string;
  at: string;
}

export interface VerificationRecord {
  outcome: "passed" | "failed" | "inconclusive" | "not_run";
  passed: boolean;
  message: string;
  at: string;
}

export interface EscalationRecord {
  reason: string;
  resolution_state: string;
  guidance: string | null;
  at: string;
}

export interface ActivityEntry {
  seq: number;
  at: string;
  kind: string;
  phase: BackendPhase;
  summary: string;
}

export interface SupportSession {
  session_id: string;
  phase: BackendPhase;
  user_issue: string;
  issue_category: string | null;
  hypotheses: Hypothesis[];
  current_hypothesis_id: string | null;
  knowledge_references: string[];
  evidence_request: EvidenceRequest | null;
  investigation_cycle: number;
  pending_action: RemediationProposal | null;
  policy_decision: (PolicyDecision & { proposal_id: string }) | null;
  verification_state: VerificationRecord | null;
  escalation_state: EscalationRecord | null;
  resolution_state: string | null;
  confidence: number;
  phase_history: PhaseTransition[];
  attempted_actions: AttemptedAction[];
  activity: ActivityEntry[];
  diagnostic_steps?: Array<{ request_id?: string; question?: string | null; answer?: string | null }>;
  action_attempt_count: number;
}

// POST /api/sessions/{id}/investigate. `diagnosis` is null when the session
// was escalated before any (grounded) diagnosis was produced.
export interface InvestigateResponse {
  diagnosis: Diagnosis | null;
  session: SupportSession;
}

// POST /api/sessions/{id}/policy
export interface PolicyResponse {
  policy: PolicyDecision;
  session: SupportSession;
}

// ---- Extension view state ---------------------------------------------------------------

// What the popup shows. The busy phases are the extension's own in-flight
// work; every other phase is derived from SupportSession.phase in
// background.ts (viewPhaseFor) — never decided independently.
export type ViewPhase =
  | "idle"
  | "seeded"
  | "collecting"
  | "investigating"
  | "checking_policy"
  | "needs_more_evidence"
  | "awaiting_approval"
  | "executing"
  | "verifying"
  | "resolved"
  | "escalated"
  | "error";

// One line of live progress shown while a step is running (from the backend's
// event stream, GET /api/sessions/{id}/events). Progress, not truth: the
// session returned when the step ends is what the extension acts on.
export interface ProgressLine {
  id: number;
  text: string;
}

export interface ExtensionState {
  phase: ViewPhase;
  session?: SupportSession;
  diagnosis?: Diagnosis | null;
  policy?: PolicyDecision;
  message?: string;
  progress?: ProgressLine[];
  // Whether an access token is saved (never the token itself).
  tokenSet?: boolean;
}

export type PopupCommand =
  | { type: "GET_STATE" }
  | { type: "SEED_BUG" }
  | { type: "RESET" }
  | { type: "ASK_OPERON"; message: string }
  | { type: "SET_TOKEN"; token: string }
  | { type: "INVESTIGATE_AGAIN" }
  | { type: "ANSWER"; text: string }
  | { type: "APPROVE" }
  | { type: "DENY" };

// ---- Content-script messages --------------------------------------------------------------

export interface StorageCheckResult {
  key: string;
  present: boolean;
  parse_status: ParseStatus;
  error_message?: string;
}

export interface PageInspection {
  url_path: string;
  title: string | null;
  ready_state: string;
  service_worker_controlled: boolean;
  service_worker_scopes: string[];
  selector: string | null;
  selector_matches: number | null;
}

export type ContentRequest =
  | { type: "SEED" }
  | { type: "RESET_STORAGE" }
  | { type: "CHECK_STORAGE"; keys?: string[] }
  | { type: "CLEAR_STORAGE_KEY"; key: string }
  | { type: "INSPECT_PAGE"; selector?: string | null }
  | { type: "UNREGISTER_SERVICE_WORKER"; scope?: string | null }
  | { type: "DISCOVER_APP_ACTIONS" }
  | { type: "INVOKE_APP_ACTION"; action: string; params: Record<string, unknown> };

export interface ContentResponse {
  storage?: StorageCheckResult[];
  page?: PageInspection;
  unregistered?: number;
  remaining_scopes?: string[];
  app_actions?: string[];
  app_result?: { ok: boolean; detail: string };
  error?: string;
}
