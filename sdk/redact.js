// Credential redaction shared by the Operon SDK and the Chrome extension.
// SINGLE SOURCE OF TRUTH: extension/src/lib/sanitize.ts re-exports this file, so the two
// integrations can never drift apart. It mirrors the backend tripwire
// (backend/operon_backend/tripwire.py); keep the two rule sets in sync.
// Pattern-based redaction is a best-effort control, NOT a guarantee that every secret is found.

const RULES = [
  ["jwt_token", /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*\b/g],
  ["bearer_token", /\bbearer\s+[a-zA-Z0-9_\-.~+/]{12,}=*/gi],
  ["long_hex_secret", /\b[0-9a-fA-F]{32,}\b/g],
  ["basic_auth", /\bbasic\s+[a-zA-Z0-9+/=]{20,}/gi],
  [
    "sensitive_json_field",
    /\\?"(?:password|passwd|secret|client_secret|access_token|refresh_token|id_token|token|api_?key|authorization|private_key|session_?id|cookie)\\?"\s*:\s*\\?"[^"\\]{6,}/gi
  ],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
  [
    "api_key",
    /\b(?:gsk_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g
  ],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bMII[A-Za-z0-9+/]{50,}={0,2}/g],
  ["url_credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:?#]+:[^\s/@?#]+@/gi],
  [
    "url_query_credential",
    /[?&;#](?:access_token|id_token|refresh_token|token|api[_-]?key|apikey|client_secret|secret|password|passwd|auth|authorization|sig|signature|session[_-]?id|sessionid|sid|jwt)=[^&#\s"'<>]{6,}/gi
  ],
  [
    "credential_assignment",
    /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?(?=[^\s"'&;,<>]*\d)[^\s"'&;,<>]{6,}/gi
  ],
  ["cookie_header", /\b(?:set-)?cookie\s*:[^\r\n]*=[^\r\n]{6,}/gi]
];
const URL_RE = /https?:\/\/[^\s"'<>\\]+/g;
const GIT_KEYWORD_RE = /\b(?:commits?|sha(?:-?1|-?256)?|head|revision|tree|blob)(?:\s+(?:is|was|at|now))*[\s:#=`'"(]*$/i;
const GIT_PIN_RE = /(?:^|[\s"'(=:,])[\w.-]+(?:\/[\w.-]+)+@$/;
const SECRET_WORD_RE = /\b(?:pass(?:word|wd|phrase)?|pwd|secret|token|key|credential|auth\w*|api[_-]?key|hmac|signature|sig|salt|private)\b/i;
function urlSpans(text) {
  const whole = [];
  const paths = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    const start = m.index;
    whole.push([start, start + url.length]);
    const authorityStart = url.indexOf("://") + 3;
    let pathStart = url.length;
    for (const ch of "/?#") {
      const i = url.indexOf(ch, authorityStart);
      if (i !== -1) pathStart = Math.min(pathStart, i);
    }
    if (url.slice(authorityStart, pathStart).includes("@")) continue;
    let pathEnd = url.length;
    for (const ch of "?#") {
      const i = url.indexOf(ch, pathStart);
      if (i !== -1) pathEnd = Math.min(pathEnd, i);
    }
    paths.push([start + pathStart, start + pathEnd]);
  }
  return { whole, paths };
}
const within = (spans, s, e) => spans.some(([a, b]) => a <= s && e <= b);
function isGitObjectId(text, start, value) {
  if (value.length !== 40 && value.length !== 64) return false;
  const before = text.slice(Math.max(0, start - 100), start);
  if (GIT_PIN_RE.test(before)) return true;
  const keyword = GIT_KEYWORD_RE.exec(before);
  if (!keyword) return false;
  const leadIn = before.slice(Math.max(0, keyword.index - 30), keyword.index);
  return !SECRET_WORD_RE.test(leadIn);
}
function redactText(text) {
  if (!text) return { text, rules: [] };
  const { whole, paths } = urlSpans(text);
  const hits = [];
  for (const [name, pattern] of RULES) {
    for (const m of text.matchAll(pattern)) {
      const s = m.index;
      const e = s + m[0].length;
      if (name === "long_hex_secret") {
        if (within(paths, s, e)) continue;
        if (!within(whole, s, e) && isGitObjectId(text, s, m[0])) continue;
      }
      hits.push([s, e, name]);
    }
  }
  if (!hits.length) return { text, rules: [] };
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const kept = [];
  for (const h of hits) if (!kept.length || h[0] >= kept[kept.length - 1][1]) kept.push(h);
  let out = text;
  for (const [s, e, name] of [...kept].reverse()) out = `${out.slice(0, s)}[REDACTED:${name}]${out.slice(e)}`;
  return { text: out, rules: [...new Set(kept.map((k) => k[2]))] };
}
function redactDeep(value) {
  const rules = /* @__PURE__ */ new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      const r = redactText(v);
      r.rules.forEach((x) => rules.add(x));
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value), rules: [...rules] };
}
const FREE_TEXT_RULES = [
  ["vendor_key", /\b(?:[spr]k_(?:live|test)_[A-Za-z0-9]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|pypi-[A-Za-z0-9_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,})/g],
  [
    "stated_secret",
    /\b(?:pass(?:word|wd|code|phrase)?|pwd|pin|secret|token|api[ _-]?key|key|credential)s?\b\s*(?:is|was|are|=|:)\s*["'`]?(?=[^\s"'`]*\d)(?=[^\s"'`]*[A-Za-z])[^\s"'`,;]{6,}/gi
  ]
];
const TOKEN_RE = /[A-Za-z0-9_+/=-]{24,}/g;
function shannonEntropy(value) {
  const counts = /* @__PURE__ */ new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= n / value.length * Math.log2(n / value.length);
  return h;
}
function looksLikeRandomKey(token) {
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && shannonEntropy(token) >= 3.9;
}
function redactFreeText(text) {
  const base = redactText(text);
  let out = base.text;
  const rules = new Set(base.rules);
  for (const [name, pattern] of FREE_TEXT_RULES) {
    out = out.replace(pattern, () => (rules.add(name), `[REDACTED:${name}]`));
  }
  const { whole } = urlSpans(out);
  out = out.replace(TOKEN_RE, (token, offset) => {
    if (within(whole, offset, offset + token.length) || !looksLikeRandomKey(token)) return token;
    rules.add("high_entropy_token");
    return "[REDACTED:high_entropy_token]";
  });
  return { text: out, rules: [...rules] };
}
/**
 * A JSON parser's error message can quote the text it choked on ("Unexpected token 'x', \"{\\\"token\\\":\\\"abc…\" is not valid
 * JSON"). That text is a storage value, which must never leave the page, so everything between
 * double quotes is dropped and the rest is shortened.
 */
function scrubParseError(message) {
  return String(message ?? "")
    .replace(/"(?:[^"\\]|\\.)*"?/g, '"…"')
    .replace(/\s+/g, " ")
    .slice(0, 120);
}
/**
 * Free-text redaction deliberately leaves URLs alone (people paste links). A URL a PAGE reports as
 * evidence is different: a path segment that looks like a random key (long, mixed case, digits,
 * high entropy) is replaced. Short ids, UUIDs, Git SHAs and ordinary words are untouched.
 */
function scrubUrl(url) {
  return String(url ?? "").replace(/[A-Za-z0-9_+=-]{24,}/g, (token) => (looksLikeRandomKey(token) ? "[REDACTED:high_entropy_token]" : token));
}
export {
  scrubUrl,
  scrubParseError,
  redactDeep,
  redactFreeText,
  redactText,
  shannonEntropy
};
