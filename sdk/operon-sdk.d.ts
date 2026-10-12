/** Operon SDK public API. See sdk/README.md. */
export const VERSION: string;
export const SUPPORTED_ACTIONS: readonly ["reset_user_preference"];
export const BUILTIN_ACTIONS: readonly ["clear_storage_key", "unregister_service_worker"];
export const RESETTABLE_PREFERENCES: readonly ["timezone", "locale", "currency", "date_format"];
export const HANDLER_TIMEOUT_MS: number;
export { redactDeep, redactFreeText, redactText } from "./redact.js";

export type OperonErrorCode =
  | "config_invalid" | "unsupported_environment" | "network_error" | "timeout" | "aborted" | "unauthorized"
  | "forbidden" | "not_found" | "conflict" | "rate_limited" | "request_rejected" | "server_error"
  | "malformed_response" | "invalid_state" | "unsupported_action" | "payload_too_large" | "busy" | "disposed";

export class OperonError extends Error {
  readonly name: "OperonError";
  readonly code: OperonErrorCode;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  constructor(code: OperonErrorCode, message: string, extra?: { status?: number; retryAfterSeconds?: number });
}

export interface OperonConfig {
  /** https://… (plain http only for localhost). No credentials, query or fragment. */
  backendUrl: string;
  /** Exactly one of `token` / `getToken`. Never put a server secret or an AI key here. */
  token?: string;
  getToken?: () => string | Promise<string>;
  appId?: string;
  /** localStorage keys the SDK may inspect (shape only, never values) and, if enabled, clear. */
  storageKeys?: string[];
  /** App-implemented fixes from SUPPORTED_ACTIONS. */
  actions?: { reset_user_preference?: (params: { preference: string }) => unknown | Promise<unknown> };
  /** SDK-implemented fixes the app opts into. */
  builtinActions?: Array<"clear_storage_key" | "unregister_service_worker">;
  /** Opt-in evidence capture. */
  capture?: { console?: boolean; network?: boolean };
  /** Re-runs the app's failing code path so a fix can be verified (required to verify console/network evidence). */
  reobserve?: () => unknown | Promise<unknown>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  investigateTimeoutMs?: number;
  maxEvidenceBytes?: number;
  maxCycles?: number;
  maxObserveMs?: number;
  evidenceWaitMs?: number;
}

export type OperonState = "proposal" | "needs_answer" | "needs_evidence" | "escalated" | "resolved" | "declined" | "in_progress";

export interface OperonProposal {
  proposal_id: string;
  action_id: string;
  parameters: Record<string, unknown>;
  diagnosis: string;
  rationale: string;
  expected_effect: string;
  [key: string]: unknown;
}

export interface OperonResult {
  state: OperonState;
  session: Record<string, any>;
  proposal: OperonProposal | null;
  question: string | null;
}

export interface OperonDecision extends OperonResult {
  executed: boolean;
  reason: "executed" | "execution_failed" | "rejected" | "denied_by_policy" | "cancelled_locally";
  verification?: { outcome: string; passed: boolean; message: string } | null;
}

export interface OperonClient {
  readonly version: string;
  readonly appId: string;
  readonly session: Record<string, any> | null;
  readonly disposed: boolean;
  on(event: "state", handler: (result: OperonResult) => void): () => void;
  on(event: "progress", handler: (p: { stage: string; status: string; detail?: string }) => void): () => void;
  on(event: "activity", handler: (a: { kind: string; summary: string }) => void): () => void;
  diagnose(issue: string, options?: { signal?: AbortSignal }): Promise<OperonResult>;
  continue(options?: { signal?: AbortSignal }): Promise<OperonResult>;
  answer(text: string, options?: { signal?: AbortSignal }): Promise<OperonResult>;
  decide(approve: boolean, options?: { signal?: AbortSignal }): Promise<OperonDecision>;
  dispose(): void;
}

export function init(config: OperonConfig): OperonClient;
export function validateBackendUrl(raw: string): string;
/** Extension carrier: declare closed-list actions for the Operon browser extension. Returns an idempotent unregister function. */
export function registerOperon(options: { appId?: string; actions: OperonConfig["actions"] }): () => void;
