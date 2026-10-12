/** Credential redaction shared by the Operon SDK and the Chrome extension (see redact.js). */
export interface RedactionResult {
  text: string;
  rules: string[];
}
/** Replaces credential-shaped values with `[REDACTED:<rule>]`. Best effort; not a guarantee. */
export function redactText(text: string): RedactionResult;
/** Deep-copies `value`, redacting every string in it. */
export function redactDeep<T>(value: T): { value: T; rules: string[] };
/** `redactText` plus heuristics suited to a sentence a person typed (see redact.js). */
export function redactFreeText(text: string): RedactionResult;
export function shannonEntropy(value: string): number;
/** A JSON.parse error message with any quoted snippet of the parsed text removed (it could be a storage value). */
export function scrubParseError(message: unknown): string;
/** A URL reported as evidence with random-key-looking path segments replaced. */
export function scrubUrl(url: unknown): string;
