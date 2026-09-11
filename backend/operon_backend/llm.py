import json

import httpx

from operon_backend.config import settings
from operon_backend.schemas import Diagnosis, EvidenceBundle, ProposedAction

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"

SYSTEM_PROMPT = """You are Operon, an automated AI technical-support diagnostician.
Your job is to diagnose technical issues on a web page using empirical evidence gathered from the browser.

RULES:
1. You MUST examine the evidence bundle (console logs, network requests, storage signals, cookies).
2. You MUST cite ONLY evidence IDs (e.g. "ev_001") that appear in the provided bundle. Do NOT invent IDs.
3. Before proposing anything, check whether the evidence you'd cite actually
   plausibly explains the user's stated complaint. An anomaly that has no
   sensible connection to what the user described is not your diagnosis just
   because it's the only anomaly present — evidence left over from unrelated
   past activity on this page is common and must not be misattributed.
   If nothing in the bundle plausibly relates to the complaint, set category
   to "insufficient_evidence", resolvable_automatically to false,
   proposed_action to null, evidence_ids to whatever you considered and
   ruled out (or empty if truly nothing stood out), and say so plainly in
   reasoning — including that a longer observation window or reproducing
   the issue again while attached may help. A confident-sounding wrong
   answer is worse than an honest "I don't see it yet."
4. If an action is required to fix the issue, you MUST only choose an action_id from this closed set:
   - "clear_storage_key" (requires params: {"key": "<storage_key_name>"})
   - "reload" (params: {"ignore_cache": boolean})
   - "unregister_service_worker" (params: {"scope": "<path>"})
   - "inspect_page" (params: {"selector": "<css_selector>"})
   If the issue cannot be resolved by these actions, set proposed_action to null and resolvable_automatically to false.
5. A network entry with status 0 and a status_text mentioning "blocked"
   (e.g. net::ERR_BLOCKED_BY_CLIENT) means a browser-side content blocker —
   an ad blocker or privacy extension the user has installed — cancelled
   that request before it ever reached the network. You have no capability
   to disable another browser extension, and must never propose one that
   isn't in the closed action set above to work around this. Set category
   to "blocked_by_client", resolvable_automatically to false, proposed_action
   to null, and in reasoning explain plainly that a browser extension
   appears to be blocking requests to this domain and the user should check
   their ad blocker / privacy extension settings for this site, then ask
   again once resolved.
6. Output strictly valid JSON matching this schema:
{
  "category": "storage_corruption" | "auth_failure" | "network_error" | "blocked_by_client" | "dom_error" | "service_worker_stale" | "insufficient_evidence" | "unknown",
  "root_cause": "<concise root cause>",
  "reasoning": "<explanation tying evidence to root cause>",
  "evidence_ids": ["ev_001", ...],
  "confidence": <float between 0.0 and 1.0>,
  "resolvable_automatically": <boolean>,
  "proposed_action": {
    "action_id": "<action_id>",
    "params": {}
  } | null
}
"""


class LLMError(Exception):
    """Raised when LLM invocation or parsing fails."""


def _rule_based_diagnosis(message: str, bundle: EvidenceBundle) -> Diagnosis:
    """Deterministic diagnosis fallback when GROQ_API_KEY is not configured."""
    valid_ids = bundle.all_evidence_ids()

    # Check for corrupted storage key (e.g. GitHub demo bug: operon_demo_cache)
    corrupted_storage = [s for s in bundle.storage if s.parse_status == "syntax_error"]
    if corrupted_storage:
        target = corrupted_storage[0]
        cited = [target.id]
        for c in bundle.console:
            if "syntaxerror" in c.text.lower() or "json" in c.text.lower():
                cited.append(c.id)

        return Diagnosis(
            category="storage_corruption",
            root_cause=f"Corrupted JSON payload in storage key '{target.key}'",
            reasoning=f"Storage signal indicates '{target.key}' failed JSON parsing ({target.error_message or 'syntax error'}). "
            f"Clearing this key will resolve the parse error on page load.",
            evidence_ids=[i for i in cited if i in valid_ids],
            confidence=0.95,
            resolvable_automatically=True,
            proposed_action=ProposedAction(
                action_id="clear_storage_key",
                params={"key": target.key},
            ),
        )

    # Check for network 4xx/5xx errors
    failed_network = [n for n in bundle.network if n.status >= 400]
    if failed_network:
        n = failed_network[0]
        return Diagnosis(
            category="network_error",
            root_cause=f"Network request to {n.url} returned status {n.status}",
            reasoning=f"Request failed with status {n.status} ({n.status_text or 'failed'}).",
            evidence_ids=[n.id] if n.id in valid_ids else [],
            confidence=0.85,
            resolvable_automatically=False,
            proposed_action=None,
        )

    # Check for console errors
    console_errors = [c for c in bundle.console if c.level == "error"]
    if console_errors:
        c = console_errors[0]
        return Diagnosis(
            category="dom_error",
            root_cause=f"Console error: {c.text[:100]}",
            reasoning=f"Runtime error detected in console: {c.text}",
            evidence_ids=[c.id] if c.id in valid_ids else [],
            confidence=0.8,
            resolvable_automatically=True,
            proposed_action=ProposedAction(
                action_id="reload",
                params={"ignore_cache": True},
            ),
        )

    return Diagnosis(
        category="unknown",
        root_cause="No anomalous evidence detected in browser bundle",
        reasoning="All signals in the bundle appear healthy.",
        evidence_ids=[],
        confidence=0.5,
        resolvable_automatically=False,
        proposed_action=None,
    )


async def diagnose(message: str, bundle: EvidenceBundle) -> Diagnosis:
    """
    Diagnoses an issue from a user message and EvidenceBundle.
    Uses Groq API if GROQ_API_KEY is set, otherwise falls back to deterministic rule-based diagnosis.
    Enforces that all cited evidence_ids exist in the bundle.
    """
    valid_ids = bundle.all_evidence_ids()

    if not settings.groq_api_key or settings.groq_api_key.strip() == "":
        return _rule_based_diagnosis(message, bundle)

    bundle_dict = bundle.model_dump()
    user_content = json.dumps(
        {
            "user_message": message,
            "evidence": bundle_dict,
            "valid_evidence_ids": list(valid_ids),
        },
        indent=2,
    )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                GROQ_API_URL,
                headers={
                    "Authorization": f"Bearer {settings.groq_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": settings.groq_model,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_content},
                    ],
                    "temperature": 0.1,
                    "response_format": {"type": "json_object"},
                },
            )

            if response.status_code != 200:
                raise LLMError(
                    f"Groq API error (status {response.status_code}): {response.text}"
                )

            data = response.json()
            raw_content = data["choices"][0]["message"]["content"]
            parsed_json = json.loads(raw_content)
            diagnosis = Diagnosis.model_validate(parsed_json)

    except Exception as e:
        if isinstance(e, LLMError):
            raise
        raise LLMError(f"Failed to generate or parse diagnosis: {e}") from e

    # Guardrail: Reject any evidence_ids not actually present in the submitted bundle
    hallucinated_ids = set(diagnosis.evidence_ids) - valid_ids
    if hallucinated_ids:
        raise LLMError(
            f"Diagnosis cited hallucinated evidence IDs not present in bundle: {sorted(hallucinated_ids)}"
        )

    return diagnosis
