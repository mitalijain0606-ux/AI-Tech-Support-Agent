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


def scan_raw_payload(raw_body: str) -> None:
    """
    Scans a raw payload string for credential-shaped patterns.
    Raises TripwireHit if any forbidden pattern is detected.
    """
    if not raw_body:
        return

    url_paths = _url_path_spans(raw_body)

    for rule_name, pattern in TRIPWIRE_RULES:
        match = None
        for candidate in pattern.finditer(raw_body):
            if rule_name in URL_PATH_EXEMPT_RULES and any(
                start <= candidate.start() and candidate.end() <= end for start, end in url_paths
            ):
                continue
            match = candidate
            break
        if match:
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
