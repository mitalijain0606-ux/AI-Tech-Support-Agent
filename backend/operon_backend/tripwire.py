import re


class TripwireHit(Exception):
    """Raised when a credential or sensitive string is detected in a raw payload."""

    def __init__(self, rule: str, detail: str):
        super().__init__(f"Credential tripwire triggered [{rule}]: {detail}")
        self.rule = rule
        self.detail = detail


# Regex rules for scanning credential patterns
TRIPWIRE_RULES: list[tuple[str, re.Pattern[str]]] = [
    (
        "jwt_token",
        re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*\b"),
    ),
    (
        "bearer_token",
        re.compile(r"(?i)\bbearer\s+[a-zA-Z0-9_\-\.~+/]{12,}=*"),
    ),
    (
        "long_hex_secret",
        re.compile(r"\b[0-9a-fA-F]{32,}\b"),
    ),
    (
        "basic_auth",
        re.compile(r"(?i)\bbasic\s+[a-zA-Z0-9+/=]{20,}"),
    ),
    (
        "sensitive_json_field",
        re.compile(r'(?i)"(?:password|secret|access_token|private_key)":\s*"[^"]{6,}"'),
    ),
]


# Rules whose matches are tolerated when they sit inside a URL's *path* —
# e.g. a 40-char commit SHA in https://github.com/o/r/commit/<sha>, or a
# gist id. Matches in a URL's query string, fragment, or userinfo are still
# rejected, since that's where tokens actually leak (?access_token=...).
URL_PATH_EXEMPT_RULES = {"long_hex_secret"}

_URL_RE = re.compile(r"https?://[^\s\"'<>\\]+")


def _url_path_spans(raw_body: str) -> list[tuple[int, int]]:
    """(start, end) offsets in raw_body of the path component of each URL."""
    spans: list[tuple[int, int]] = []
    for m in _URL_RE.finditer(raw_body):
        url = m.group(0)
        authority_start = url.index("://") + 3
        path_start = len(url)
        for ch in "/?#":
            i = url.find(ch, authority_start)
            if i != -1:
                path_start = min(path_start, i)
        if "@" in url[authority_start:path_start]:
            continue  # userinfo present — don't exempt anything in this URL
        path_end = len(url)
        for ch in "?#":
            i = url.find(ch, path_start)
            if i != -1:
                path_end = min(path_end, i)
        spans.append((m.start() + path_start, m.start() + path_end))
    return spans


def _url_spans(text: str) -> list[tuple[int, int]]:
    """(start, end) offsets of every whole URL in text."""
    return [(m.start(), m.end()) for m in _URL_RE.finditer(text)]


def _within(spans: list[tuple[int, int]], match: re.Match[str]) -> bool:
    return any(start <= match.start() and match.end() <= end for start, end in spans)


# Outside URLs, a 40- or 64-char hex string is a git object id (SHA-1 /
# SHA-256), not a secret, when it is unambiguously introduced as one:
#   "commit <sha>", "sha256: <sha>", "HEAD is at <sha>", "owner/repo@<sha>".
# Deliberately narrow: no generic words like "hash" or "ref", and never when
# a secret-ish word sits just before it ("password sha256 <hex>").
# Inside a URL this exemption never applies — only the URL-path rule above
# does — so hex in a query string, fragment or userinfo is always detected.
_GIT_OBJECT_ID_LENGTHS = {40, 64}
_GIT_KEYWORD_RE = re.compile(
    r"(?i)\b(?:commits?|sha(?:-?1|-?256)?|head|revision|tree|blob)"
    r"(?:\s+(?:is|was|at|now))*[\s:#=`'\"(]*$"
)
_GIT_PIN_RE = re.compile(r"(?:^|[\s\"'(=:,])[\w.-]+(?:/[\w.-]+)+@$")  # owner/repo@<sha>
_SECRET_WORD_RE = re.compile(
    r"(?i)\b(?:pass(?:word|wd|phrase)?|pwd|secret|token|key|credential|auth\w*|api[_-]?key|hmac|signature|sig|salt|private)\b"
)


def _is_git_object_id(text: str, match: re.Match[str]) -> bool:
    if len(match.group(0)) not in _GIT_OBJECT_ID_LENGTHS:
        return False
    before = text[max(0, match.start() - 100) : match.start()]
    if _GIT_PIN_RE.search(before):
        return True
    keyword = _GIT_KEYWORD_RE.search(before)
    if not keyword:
        return False
    # "password sha256: <hex>", "secret commit <hex>" — the hex is still a secret.
    lead_in = before[max(0, keyword.start() - 30) : keyword.start()]
    return not _SECRET_WORD_RE.search(lead_in)


def find_credentials(text: str) -> list[tuple[str, re.Match[str]]]:
    """Every credential-shaped match in `text`, as (rule name, match),
    after the URL-path and git-object-id exemptions for long hex strings."""
    if not text:
        return []

    url_paths = _url_path_spans(text)
    urls = _url_spans(text)
    found: list[tuple[str, re.Match[str]]] = []
    for rule_name, pattern in TRIPWIRE_RULES:
        for candidate in pattern.finditer(text):
            if rule_name in URL_PATH_EXEMPT_RULES:
                if _within(url_paths, candidate):
                    continue
                if not _within(urls, candidate) and _is_git_object_id(text, candidate):
                    continue
            found.append((rule_name, candidate))
    return found


def redact_credentials(text: str) -> tuple[str, list[str]]:
    """Returns `text` with every credential-shaped value replaced by
    `[REDACTED:<rule>]`, plus the names of the rules that fired. For free
    text (e.g. a user's own description of the problem) that must be kept
    and passed on, rather than rejected outright like an evidence payload."""
    matches = find_credentials(text)
    if not matches:
        return text, []

    # Replace from the end so earlier offsets stay valid; skip overlaps.
    spans: list[tuple[int, int, str]] = []
    for rule_name, m in sorted(matches, key=lambda rm: (rm[1].start(), -rm[1].end())):
        if spans and m.start() < spans[-1][1]:
            continue
        spans.append((m.start(), m.end(), rule_name))
    redacted = text
    for start, end, rule_name in reversed(spans):
        redacted = f"{redacted[:start]}[REDACTED:{rule_name}]{redacted[end:]}"
    return redacted, list(dict.fromkeys(rule for _, _, rule in spans))


def scan_raw_payload(raw_body: str) -> None:
    """
    Scans a raw payload string for credential-shaped patterns.
    Raises TripwireHit if any forbidden pattern is detected.
    """
    matches = find_credentials(raw_body)
    if matches:
        rule_name, match = matches[0]
        # Truncate snippet for safe logging without exposing full secret
        matched_str = match.group(0)
        redacted_snippet = (
            matched_str[:4] + "..." + matched_str[-4:]
            if len(matched_str) > 8
            else "***"
        )
        raise TripwireHit(
            rule=rule_name,
            detail=f"Detected pattern matching '{rule_name}' (sample: {redacted_snippet})",
        )
