// Client-side credential redaction, applied to everything the extension uploads
// (evidence bundles, verification observations, free text).
//
// The implementation lives in sdk/redact.js and is shared with the Operon SDK, so the
// two integrations cannot drift apart. The backend's tripwire
// (backend/operon_backend/tripwire.py) stays the authority; this is a best-effort
// mirror of its rules, never a replacement.
export { redactDeep, redactFreeText, redactText, scrubParseError, scrubUrl, shannonEntropy } from "../../../sdk/redact.js";
export type { RedactionResult } from "../../../sdk/redact.js";
