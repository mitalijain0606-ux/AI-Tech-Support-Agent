// Client-side credential redaction, applied to everything the extension
// uploads (evidence bundles and verification observations).
//
// The backend's tripwire (backend/operon_backend/tripwire.py) rejects any
// payload containing a credential-shaped string — the whole investigation
// cycle fails with a 422. Real pages do log tokens, signed URLs and JSON with
// secret fields, so the extension redacts them first and says so in
// `redaction_applied`. The backend tripwire stays the authority: this is a
// best-effort mirror of its rules, never a replacement for them. Keep the two
// rule sets in sync.

type Rule = [name: string, pattern: RegExp];

const RULES: Rule[] = [
  ["jwt_token", /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*\b/g],
  ["bearer_token", /\bbearer\s+[a-zA-Z0-9_\-.~+/]{12,}=*/gi],
  ["long_hex_secret", /\b[0-9a-fA-F]{32,}\b/g],
  ["basic_auth", /\bbasic\s+[a-zA-Z0-9+/=]{20,}/gi],
  [
    "sensitive_json_field",
    /\\?"(?:password|passwd|secret|client_secret|access_token|refresh_token|id_token|token|api_?key|authorization|private_key|session_?id|cookie)\\?"\s*:\s*\\?"[^"\\]{6,}/gi,
  ],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
  [
    "api_key",
    /\b(?:gsk_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g,
  ],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bMII[A-Za-z0-9+/]{50,}={0,2}/g],
  ["url_credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:?#]+:[^\s/@?#]+@/gi],
  [
    "url_query_credential",
    /[?&;#](?:access_token|id_token|refresh_token|token|api[_-]?key|apikey|client_secret|secret|password|passwd|auth|authorization|sig|signature|session[_-]?id|sessionid|sid|jwt)=[^&#\s"'<>]{6,}/gi,
  ],
  [
    "credential_assignment",
    /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?(?=[^\s"'&;,<>]*\d)[^\s"'&;,<>]{6,}/gi,
  ],
  ["cookie_header", /\b(?:set-)?cookie\s*:[^\r\n]*=[^\r\n]{6,}/gi],
];

const URL_RE = /https?:\/\/[^\s"'<>\\]+/g;
const GIT_KEYWORD_RE = /\b(?:commits?|sha(?:-?1|-?256)?|head|revision|tree|blob)(?:\s+(?:is|was|at|now))*[\s:#=`'"(]*$/i;
const GIT_PIN_RE = /(?:^|[\s"'(=:,])[\w.-]+(?:\/[\w.-]+)+@$/;
const SECRET_WORD_RE =
  /\b(?:pass(?:word|wd|phrase)?|pwd|secret|token|key|credential|auth\w*|api[_-]?key|hmac|signature|sig|salt|private)\b/i;

type Span = [start: number, end: number];

function urlSpans(text: string): { whole: Span[]; paths: Span[] } {
  const whole: Span[] = [];
  const paths: Span[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    const start = m.index!;
    whole.push([start, start + url.length]);
    const authorityStart = url.indexOf("://") + 3;
    let pathStart = url.length;
    for (const ch of "/?#") {
      const i = url.indexOf(ch, authorityStart);
      if (i !== -1) pathStart = Math.min(pathStart, i);
    }
    if (url.slice(authorityStart, pathStart).includes("@")) continue; // userinfo: exempt nothing
    let pathEnd = url.length;
    for (const ch of "?#") {
      const i = url.indexOf(ch, pathStart);
      if (i !== -1) pathEnd = Math.min(pathEnd, i);
    }
    paths.push([start + pathStart, start + pathEnd]);
  }
  return { whole, paths };
}

const within = (spans: Span[], s: number, e: number) => spans.some(([a, b]) => a <= s && e <= b);

// A 40/64-char hex string introduced as a git object id ("commit <sha>",
// "owner/repo@<sha>") is not a secret — same narrow rule as the backend.
function isGitObjectId(text: string, start: number, value: string): boolean {
  if (value.length !== 40 && value.length !== 64) return false;
  const before = text.slice(Math.max(0, start - 100), start);
  if (GIT_PIN_RE.test(before)) return true;
  const keyword = GIT_KEYWORD_RE.exec(before);
  if (!keyword) return false;
  const leadIn = before.slice(Math.max(0, keyword.index - 30), keyword.index);
  return !SECRET_WORD_RE.test(leadIn);
}

/** `text` with credential-shaped values replaced by `[REDACTED:<rule>]`, plus the rules that fired. */
export function redactText(text: string): { text: string; rules: string[] } {
  if (!text) return { text, rules: [] };
  const { whole, paths } = urlSpans(text);
  const hits: [number, number, string][] = [];
  for (const [name, pattern] of RULES) {
    for (const m of text.matchAll(pattern)) {
      const s = m.index!;
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
  const kept: [number, number, string][] = [];
  for (const h of hits) if (!kept.length || h[0] >= kept[kept.length - 1][1]) kept.push(h);
  let out = text;
  for (const [s, e, name] of [...kept].reverse()) out = `${out.slice(0, s)}[REDACTED:${name}]${out.slice(e)}`;
  return { text: out, rules: [...new Set(kept.map((k) => k[2]))] };
}

/** Deep-copies `value`, redacting every string in it. */
export function redactDeep<T>(value: T): { value: T; rules: string[] } {
  const rules = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactText(v);
      r.rules.forEach((x) => rules.add(x));
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value) as T, rules: [...rules] };
}
