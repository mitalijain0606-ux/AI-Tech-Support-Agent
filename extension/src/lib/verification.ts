import type { ConsoleEvidence, EvidenceBundle, NetworkEvidence, StorageCheckResult } from "./types";

// What the debugger saw on the page after a remediation ran, plus the
// storage re-check taken afterwards (null when none was taken).
export interface Observation {
  console: ConsoleEvidence[];
  network: NetworkEvidence[];
  storage: StorageCheckResult[] | null;
}

export interface VerificationResult {
  passed: boolean;
  message: string;
}

function normalizeText(text: string): string {
  // Numbers (line/col, ids, timestamps) vary between occurrences of the
  // same error; the rest of the message identifies it.
  return text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

// A stable identity for "the same signal", independent of its ev_ id.
export function signatureOf(item: ConsoleEvidence | NetworkEvidence): string {
  if ("text" in item) return `console:${item.level}:${normalizeText(item.text)}`;
  return `network:${item.method.toUpperCase()} ${stripQuery(item.url)} ${item.status}`;
}

// The storage keys a cited storage signal refers to, so the caller knows
// what to re-check after the action.
export function citedStorageKeys(baseline: EvidenceBundle | null, citedIds: string[]): string[] {
  return (baseline?.storage ?? []).filter((s) => citedIds.includes(s.id)).map((s) => s.key);
}

function inconclusive(reason: string): VerificationResult {
  return { passed: false, message: `Verification inconclusive — ${reason}` };
}

// Decides deterministically whether a remediation fixed what it was proposed
// for. Every piece of evidence the proposal cites must be positively shown to
// be gone; anything cited that can't be re-checked makes the result
// inconclusive (not passed). Only when nothing is cited does a clean
// observation window count as success.
export function verifyAgainstEvidence(
  baseline: EvidenceBundle | null,
  citedIds: string[],
  after: Observation,
): VerificationResult {
  if (citedIds.length === 0) {
    const errors = after.console.filter((c) => c.level === "error").length + after.network.length;
    return errors > 0
      ? {
          passed: false,
          message: `Verification failed — no cited evidence to compare against, and ${errors} error signal(s) were observed after the action.`,
        }
      : { passed: true, message: "Verified — no console errors or failed requests were observed after the action." };
  }

  if (!baseline) {
    return inconclusive(
      `the proposal cites ${citedIds.join(", ")}, but the evidence bundle those ids refer to is unavailable.`,
    );
  }

  const cited = {
    signals: [...baseline.console, ...baseline.network].filter((item) => citedIds.includes(item.id)),
    storage: baseline.storage.filter((item) => citedIds.includes(item.id)),
    cookies: baseline.cookies.filter((item) => citedIds.includes(item.id)),
  };
  const known = new Set(
    [...cited.signals, ...cited.storage, ...cited.cookies].map((item) => item.id),
  );
  const unknown = citedIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return inconclusive(`cited evidence ${unknown.join(", ")} is not in the evidence bundle it was proposed from.`);
  }
  if (cited.cookies.length > 0) {
    return inconclusive(
      `cookie evidence (${cited.cookies.map((c) => c.id).join(", ")}) can't be re-checked after this action.`,
    );
  }

  const failures: string[] = [];

  const observed = new Set([...after.console, ...after.network].map(signatureOf));
  for (const item of cited.signals) {
    if (observed.has(signatureOf(item))) failures.push(`${item.id} reappeared`);
  }

  for (const item of cited.storage) {
    const now = after.storage?.find((s) => s.key === item.key);
    if (!now) {
      return inconclusive(`storage evidence ${item.id} ('${item.key}') was not re-checked after the action.`);
    }
    if (now.present && now.parse_status !== "valid_json") {
      failures.push(`${item.id} ('${item.key}') is still ${now.parse_status}`);
    }
  }

  const total = cited.signals.length + cited.storage.length;
  if (failures.length > 0) {
    return {
      passed: false,
      message: `Verification failed — ${failures.length} of ${total} cited signal(s) still present after the action (${failures.join("; ")}).`,
    };
  }
  return { passed: true, message: `Verified — none of the ${total} cited signal(s) are present after the action.` };
}
