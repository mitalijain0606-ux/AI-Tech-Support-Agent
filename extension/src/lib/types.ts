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

export interface StorageSignal {
  id: string;
  key: string;
  present: boolean;
  parse_status: "valid_json" | "syntax_error" | "not_json" | "empty";
  error_message?: string;
  // NOTE: the raw stored value is intentionally never a field here — Contract 1a.
}

export interface EvidenceBundle {
  url: string;
  timestamp: number;
  console: ConsoleEvidence[];
  network: NetworkEvidence[];
  cookies: CookieSignal[];
  storage: StorageSignal[];
  redaction_applied: string[];
}

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
}

export interface PolicyDecision {
  action_id: string;
  decision: "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
  reason: string;
  validated_params: Record<string, unknown>;
}

// ---- Backend SupportSession (backend/operon_backend/schemas.py SessionOut) --

// backend/operon_backend/state_machine.py SessionPhase — the source of truth.
export type BackendPhase =
  | "UNDERSTANDING"
  | "KNOWLEDGE_LOOKUP"
  | "NEED_INFORMATION"
  | "INVESTIGATING"
  | "HYPOTHESIS_FORMED"
  | "DIAGNOSING"
  | "ACTION_PROPOSED"
  | "WAITING_FOR_APPROVAL"
  | "EXECUTING"
  | "VERIFYING"
  | "RESOLVED"
  | "ESCALATED";

export interface Hypothesis {
  hypothesis_id: string;
  description: string;
  confidence: number;
  supporting_evidence_ids: string[];
  contradicting_evidence_ids: string[];
  required_tests: string[];
  status: "candidate" | "supported" | "contradicted" | "confirmed" | "rejected";
}

export interface RemediationProposal {
  diagnosis: string;
  evidence_ids: string[];
  action_id: string;
  parameters: Record<string, unknown>;
  expected_effect: string;
  risk: string;
  verification_predicate: string;
  requires_approval: boolean; // informational only — the Policy Engine decides
}

export interface PhaseTransition {
  from: BackendPhase;
  to: BackendPhase;
  reason: string;
  at: string;
}

export interface AttemptedAction {
  action_id: string | null;
  params?: Record<string, unknown>;
  succeeded: boolean;
  verified?: boolean | null;
  detail: string;
  at: string;
}

export interface VerificationRecord {
  passed: boolean;
  message: string;
  at: string;
}

export interface SupportSession {
  session_id: string;
  phase: BackendPhase;
  user_issue: string;
  issue_category: string | null;
  hypotheses: Hypothesis[];
  current_hypothesis_id: string | null;
  knowledge_references: string[];
  pending_action: RemediationProposal | null;
  verification_state: VerificationRecord | null;
  resolution_state: string | null;
  confidence: number;
  phase_history: PhaseTransition[];
  diagnostic_steps: Record<string, unknown>[];
  attempted_actions: AttemptedAction[];
  step_count: number;
  tool_call_count: number;
  llm_call_count: number;
  action_attempt_count: number;
}

// POST /api/sessions/{id}/investigate. `diagnosis` is null when the session
// was escalated (hard limit) before any diagnosis was produced.
export interface InvestigateResponse {
  diagnosis: Diagnosis | null;
  session: SupportSession;
}

// POST /api/sessions/{id}/policy
export interface PolicyResponse {
  policy: PolicyDecision;
  session: SupportSession;
}

// ---- Extension view state -------------------------------------------------

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

export interface ExtensionState {
  phase: ViewPhase;
  session?: SupportSession;
  diagnosis?: Diagnosis | null;
  policy?: PolicyDecision;
  message?: string;
}

export type PopupCommand =
  | { type: "GET_STATE" }
  | { type: "SEED_BUG" }
  | { type: "RESET" }
  | { type: "ASK_OPERON"; message: string }
  | { type: "INVESTIGATE_AGAIN" }
  | { type: "APPROVE" }
  | { type: "DENY" };

export interface StorageCheckResult {
  key: string;
  present: boolean;
  parse_status: StorageSignal["parse_status"];
  error_message?: string;
}

export type ContentRequest =
  | { type: "SEED" }
  | { type: "RESET_STORAGE" }
  | { type: "CHECK_STORAGE" }
  | { type: "CLEAR_STORAGE_KEY"; key: string };

export interface ContentResponse {
  storage?: StorageCheckResult;
}
