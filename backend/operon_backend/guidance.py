"""Deterministic checks on the free-text guidance a diagnosis shows to people.

The structured fields of a diagnosis (cited evidence, knowledge refs, the action and its
parameters) are validated in llm.validate_grounding. The free text — `root_cause` and `reasoning`,
which the popup, the SDK widget and escalation messages display as guidance — was not. These checks
close the part of that gap that can be checked without trusting a model to grade itself:

1. dangerous instructions: telling the user to wipe all site data/cookies/storage, reinstall the
   browser, disable security software, hand over credentials, or paste code into the console;
2. certainty claims: "guaranteed", "100%", "will definitely fix" — no fix is guaranteed before the
   backend has verified it;
3. contradiction of a cited knowledge entry: a "never …" rule in a cited knowledge chunk whose
   forbidden act the guidance then tells the user to do.

A violation is a grounding problem like any other: the answer is regenerated once with the problem
stated, and a second failure fails the cycle safe (the session escalates; nothing is shown as
authoritative guidance).

Not covered (see docs/FEATURE_AUDIT_REPORT.md): step-by-step adherence to a multi-step knowledge
procedure (mandatory steps and their order). Operon's actions come from a closed set and are
verified server-side; the guidance text is explanatory.
"""

import re

# (name, pattern) — imperative or recommending phrasing only, so describing what happened
# ("the app cleared its cache") is not flagged.
_DANGEROUS: list[tuple[str, re.Pattern[str]]] = [
    ("wipes all browser data", re.compile(
        r"\b(clear|delete|wipe|erase|remove|reset)\b[^.]{0,30}\b(all|every|entire|whole)\b[^.]{0,25}"
        r"\b(storage|localstorage|local storage|cookies?|cache|site data|browser data|browsing data|history)\b", re.I)),
    ("reinstalls the browser", re.compile(r"\b(reinstall|uninstall)\b[^.]{0,20}\b(browser|chrome|firefox|edge|safari)\b", re.I)),
    ("disables security", re.compile(
        r"\b(disable|turn off|switch off|deactivate|bypass)\b[^.]{0,25}\b(antivirus|anti-virus|firewall|security|https|two-factor|2fa|mfa|safe browsing)\b", re.I)),
    ("asks for credentials", re.compile(
        r"\b(share|send|give|paste|enter|provide|tell us|type)\b[^.]{0,25}\b(password|passcode|api key|access token|token|credentials|2fa code|one-time code|card number|cvv)\b", re.I)),
    ("runs code in the console", re.compile(r"\b(run|paste|execute|type)\b[^.]{0,30}\b(code|script|command|snippet)\b[^.]{0,30}\b(console|devtools|developer tools)\b", re.I)),
    ("deletes the account", re.compile(r"\b(delete|close|remove)\b[^.]{0,15}\byour (account|workspace)\b", re.I)),
]
_CERTAINTY = re.compile(r"\bguarantee(d|s)?\b|\b100\s?%|\bwill (definitely|certainly|always)\b|\b(always|certainly) (fix|fixes|work|works)\b|\bcannot fail\b|\bno risk\b", re.I)
_NEVER = re.compile(r"\bnever\b([^.;\n]{4,120})", re.I)


def _contradicted_rules(text: str, knowledge_context: list[dict]) -> list[str]:
    """Cited knowledge rules ("never …") whose forbidden act the guidance itself recommends."""
    found = []
    for chunk in knowledge_context:
        for rule in _NEVER.findall(str(chunk.get("content", ""))):
            rule = rule.strip()
            for name, pattern in _DANGEROUS:
                if pattern.search(rule) and pattern.search(text):
                    found.append(f"guidance contradicts {chunk.get('chunk_id')}: 'never {rule[:80]}'")
    return list(dict.fromkeys(found))


def guidance_problems(root_cause: str, reasoning: str, knowledge_context: list[dict] | None = None, cited_refs: list[str] | None = None) -> list[str]:
    """Every reason the free-text guidance may not be shown as-is. Empty means acceptable."""
    text = f"{root_cause}\n{reasoning}"
    problems = [f"Guidance {name}; Operon must not recommend that" for name, pattern in _DANGEROUS if pattern.search(text)]
    if _CERTAINTY.search(text):
        problems.append("Guidance claims certainty (guaranteed/100%/definitely); no fix is certain before it is verified")
    cited = [c for c in (knowledge_context or []) if c.get("chunk_id") in set(cited_refs or [])]
    problems += _contradicted_rules(text, cited)
    return problems
