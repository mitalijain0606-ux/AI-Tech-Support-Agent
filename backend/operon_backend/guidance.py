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

4. procedure order: when the guidance gives numbered steps and a cited knowledge entry has an
   ordered procedure (a numbered list, or "Diagnostic steps: a; b; c"), every guidance step
   that matches a procedure step must keep the procedure's order, and no procedure step may be
   skipped between the first and the last one the guidance uses. Guidance steps that match no
   procedure step (explanations) are allowed.
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


_STOP = set("""a an the to of in on for and or is are be it this that your you with from by as at if then
first next finally step steps after before when check make sure open go click""".split())
_GUIDE_STEP = re.compile(r"(?:^|\n|\s)(?:step\s*)?(\d{1,2})[.):]\s+(.+?)(?=(?:\n|\s)(?:step\s*)?\d{1,2}[.):]\s|$)", re.I | re.S)
_SEMI_LIST = re.compile(r"(?:Diagnostic steps|Remediation|Steps):\s*([^\n]+)", re.I)
MATCH_THRESHOLD = 0.34


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9_/.-]{3,}", text.lower()) if w not in _STOP}


def _numbered(text: str) -> list[list[str]]:
    """Every run of numbered items 1, 2, 3 ... in `text` (a new 1 starts a new list)."""
    lists: list[list[str]] = []
    for number, body in _GUIDE_STEP.findall(text or ""):
        if int(number) == 1 or not lists:
            lists.append([])
        lists[-1].append(body.strip())
    return [items for items in lists if len(items) >= 2]


def _procedures(content: str) -> list[list[str]]:
    found = _numbered(content)
    for raw in _SEMI_LIST.findall(content or ""):
        items = [i.strip() for i in raw.split(";") if i.strip()]
        if len(items) >= 2:
            found.append(items)
    return found


def _best_match(step: str, procedure: list[str]) -> int | None:
    sw = _words(step)
    best, best_score = None, 0.0
    for i, kb_step in enumerate(procedure):
        kw = _words(kb_step)
        if not sw or not kw:
            continue
        score = len(sw & kw) / min(len(sw), len(kw))
        if score > best_score:
            best, best_score = i, score
    return best if best_score >= MATCH_THRESHOLD else None


def procedure_problems(text: str, cited_chunks: list[dict]) -> list[str]:
    """Order and skipped-step violations of numbered guidance against cited procedures."""
    guide_lists = _numbered(text)
    if not guide_lists:
        return []
    steps = max(guide_lists, key=len)
    problems = []
    for chunk in cited_chunks:
        for procedure in _procedures(str(chunk.get("content", ""))):
            matches = [_best_match(step, procedure) for step in steps]
            used = [m for m in matches if m is not None]
            if len(used) < 2:
                continue  # this procedure is not what the guidance follows
            ref = chunk.get("chunk_id")
            if any(b < a for a, b in zip(used, used[1:])):
                order = " → ".join(str(m + 1) for m in used)
                problems.append(f"Guidance steps are out of order against the procedure in {ref} (uses its steps {order})")
            skipped = [i for i in range(min(used), max(used) + 1) if i not in used]
            if skipped:
                names = "; ".join(f"step {i + 1} ({procedure[i][:60]})" for i in skipped)
                problems.append(f"Guidance skips required {names} of the procedure in {ref}")
    return list(dict.fromkeys(problems))


def guidance_problems(root_cause: str, reasoning: str, knowledge_context: list[dict] | None = None, cited_refs: list[str] | None = None) -> list[str]:
    """Every reason the free-text guidance may not be shown as-is. Empty means acceptable."""
    text = f"{root_cause}\n{reasoning}"
    problems = [f"Guidance {name}; Operon must not recommend that" for name, pattern in _DANGEROUS if pattern.search(text)]
    if _CERTAINTY.search(text):
        problems.append("Guidance claims certainty (guaranteed/100%/definitely); no fix is certain before it is verified")
    cited = [c for c in (knowledge_context or []) if c.get("chunk_id") in set(cited_refs or [])]
    problems += _contradicted_rules(text, cited)
    problems += procedure_problems(text, cited)
    return problems
