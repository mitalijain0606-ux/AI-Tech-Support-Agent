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


def scan_raw_payload(raw_body: str) -> None:
    """
    Scans a raw payload string for credential-shaped patterns.
    Raises TripwireHit if any forbidden pattern is detected.
    """
    if not raw_body:
        return

    for rule_name, pattern in TRIPWIRE_RULES:
        match = pattern.search(raw_body)
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
