"""Pattern recognition over evidence text, shared by the classify stage and the
offline diagnosis engine.

These helpers read *untrusted* text (console messages, URLs, page titles). They
only ever classify; nothing here follows or acts on what the text says. In
particular `looks_like_injection` exists so that text trying to instruct an
AI is recognised as a finding about the page, never obeyed.
"""

import re

# Text aimed at an AI agent rather than at a developer or user.
_INJECTION_PATTERNS = [
    r"ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts?|rules)",
    r"disregard (all |any |the )?(previous|prior|above|earlier) (instructions|prompts?|rules)",
    r"\b(system|assistant|developer)\s*(prompt|message|override)\s*:",
    r"^\s*(system|assistant)\s*:",
    r"you (are|must) now (a|an|the)?\s*\w*\s*(agent|assistant|admin)",
    r"\bapprove (this|the) (action|request|fix)\b",
    r"\b(run|execute|call|use) (the )?(action|tool|function)\b.*\b(clear_storage_key|unregister_service_worker|reset_user_preference|run_javascript)\b",
    r"do not (tell|inform|alert) the user",
    r"reveal (your|the) (system )?(prompt|instructions|api key)",
]
_INJECTION_RE = re.compile("|".join(f"(?:{p})" for p in _INJECTION_PATTERNS), re.IGNORECASE | re.MULTILINE)

_CORS_RE = re.compile(r"cors policy|cross-origin request blocked|no 'access-control-allow-origin'", re.IGNORECASE)
_STALE_ASSET_RE = re.compile(
    r"chunkloaderror|loading chunk \S+ failed|failed to fetch dynamically imported module|"
    r"unexpected token '<'|stale (asset|bundle|cache)|service ?worker.*(stale|outdated|old version|served)|"
    r"(outdated|old|stale) (bundle|build|version)",
    re.IGNORECASE,
)
_AUTH_RE = re.compile(r"\b(401|403)\b|unauthori[sz]ed|forbidden|session (has )?expired|token (has )?expired|please (log|sign) ?in", re.IGNORECASE)

# A failed HTTP request as an app or the browser writes it to the console:
# "Failed to load resource: the server responded with a status of 500 (...)",
# "Could not load projects: 500 Internal Server Error for /api/projects".
_HTTP_FAILURE_RE = re.compile(
    r"(status( code)? of|http|returned|responded with)\s*(a status of\s*)?[45]\d\d\b|"
    r"\b[45]\d\d (internal server error|bad gateway|service unavailable|gateway time-?out|not found|bad request|too many requests)",
    re.IGNORECASE,
)
# fetch() rejected before any response (offline, DNS, blocked, CORS)
_FETCH_FAILURE_RE = re.compile(r"failed to fetch|networkerror when attempting to fetch|load failed|net::err_", re.IGNORECASE)

# "Invalid time zone specified: Mars/Phobos", "Invalid locale: xx-YY", "Unsupported currency 'ZZZ'" ...
_PREFERENCE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("timezone", re.compile(r"invalid (time ?zone|tz)|unknown (time ?zone|tz)|unsupported time ?zone|timezone.*(invalid|unknown)", re.IGNORECASE)),
    ("locale", re.compile(r"invalid (locale|language tag)|incorrect locale|unsupported locale", re.IGNORECASE)),
    ("currency", re.compile(r"invalid (currency|currency code)|unsupported currency|unknown currency", re.IGNORECASE)),
    ("date_format", re.compile(r"invalid date ?format|unsupported date ?format", re.IGNORECASE)),
]


def looks_like_injection(text: str) -> bool:
    """True for text that addresses an AI agent / tries to override its instructions."""
    return bool(text) and bool(_INJECTION_RE.search(text))


def is_cors_failure(text: str) -> bool:
    return bool(_CORS_RE.search(text or ""))


def is_stale_asset_error(text: str) -> bool:
    return bool(_STALE_ASSET_RE.search(text or ""))


def is_http_failure(text: str) -> bool:
    return bool(_HTTP_FAILURE_RE.search(text or ""))


def is_fetch_failure(text: str) -> bool:
    return bool(_FETCH_FAILURE_RE.search(text or ""))


def is_auth_failure(text: str) -> bool:
    return bool(_AUTH_RE.search(text or ""))


def invalid_preference(text: str) -> str | None:
    """The user preference an error message says is invalid ("timezone", ...), or None."""
    for name, pattern in _PREFERENCE_PATTERNS:
        if pattern.search(text or ""):
            return name
    return None


def normalise(text: str) -> str:
    """Lower-case with spaces / underscores / hyphens removed, for 'is this
    identifier mentioned in that text' comparisons ("time zone" ~ "timezone")."""
    return re.sub(r"[\s_\-]+", "", (text or "").lower())


# ---- questions the agent may put to the user ------------------------------------------------

QUESTION_MAX_CHARS = 300
_URL_RE = re.compile(r"https?://|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|ru|cn|xyz|top)\b", re.IGNORECASE)
_SECRET_REQUEST_RE = re.compile(
    r"pass(word|code|phrase)|\btokens?\b|\bsecrets?\b|api[ _-]?keys?|credit ?card|card number|\bcvv\b|\bssn\b|"
    r"social security|private key|\b2fa\b|one[- ]time (code|password)|verification code|cookie (value|contents)|recovery (code|phrase)|seed phrase",
    re.IGNORECASE,
)


def question_problems(question: str) -> list[str]:
    """Why a model-written question must not be shown to a user. The text comes
    out of a model that has read untrusted page content, so it is held to the
    same standard as an action: plain, short, and never an attempt to get a secret
    out of the person or to send them somewhere."""
    problems: list[str] = []
    text = (question or "").strip()
    if not text:
        problems.append("the question is empty")
    if len(text) > QUESTION_MAX_CHARS:
        problems.append(f"the question is longer than {QUESTION_MAX_CHARS} characters")
    if _URL_RE.search(text):
        problems.append("the question contains a link or web address")
    if _SECRET_REQUEST_RE.search(text):
        problems.append("the question asks for a credential or other secret")
    if looks_like_injection(text):
        problems.append("the question contains text that reads as an instruction to an AI")
    if "\n\n\n" in text or any(ord(ch) < 32 and ch not in "\n\t" for ch in text):
        problems.append("the question contains control characters")
    return problems
