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

export interface Diagnosis {
  category: string;
  root_cause: string;
  reasoning: string;
  evidence_ids: string[];
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

export type SessionPhase =
  | "idle"
  | "seeded"
  | "collecting"
  | "diagnosing"
  | "awaiting_approval"
  | "executing"
  | "verifying"
  | "resolved"
  | "escalated"
  | "error";

export interface SessionState {
  phase: SessionPhase;
  diagnosis?: Diagnosis;
  policy?: PolicyDecision;
  message?: string;
}

export type PopupCommand =
  | { type: "GET_STATE" }
  | { type: "SEED_BUG" }
  | { type: "RESET" }
  | { type: "ASK_OPERON"; message: string }
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
