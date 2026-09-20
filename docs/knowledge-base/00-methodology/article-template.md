# Troubleshooting article template

Every troubleshooting article follows this structure. The front matter
maps onto the repository's existing `KnowledgeDocument` model
(`backend/operon_backend/knowledge.py`) so articles can be embedded and
retrieved by the same pipeline.

```yaml
---
doc_id: kb_gh_<short_slug>
title: <human title>
severity: low | medium | high | critical
# --- maps to KnowledgeDocument ---
symptoms: []                  # what the user reports / what is observable
causes: []                    # likely root causes, most probable first
diagnostic_checks: []         # what to inspect to confirm or eliminate
evidence_patterns: []         # concrete signal shapes (status codes, log lines, headers)
recommended_actions: []       # tool names from the registry, never free-form code
prerequisites: []             # what must be true before acting (incl. permissions)
contraindications: []         # when NOT to take the action
verification_predicates: []   # deterministic checks that prove it worked
escalation_conditions: []     # when to stop and hand to a human
# --- freshness (see research-methodology.md) ---
sources: []                   # ids from source-registry.yaml
last_verified: 2026-09-20
api_version: "2022-11-28"
stability: stable | versioned | volatile
confidence: high | medium | low
---
```

## Body sections (in order)

1. **Problem** — one paragraph in the user's terms.
2. **Symptoms**
3. **Affected systems**
4. **Severity**
5. **Prerequisites / required permissions** — App permission names with access level; flag `UNVERIFIED` where applicable.
6. **Likely causes** — ranked, each with the evidence that would distinguish it from the others. *Explain how to tell similar errors apart*; a list of causes without discriminating evidence is not acceptable.
7. **Diagnostic procedure** — ordered tool calls. Read-only first.
8. **Evidence collection** — exactly which fields/headers/log lines to capture and store as evidence ids.
9. **Decision tree** — ASCII tree; every leaf is a cause, a next diagnostic, or an escalation.
10. **Resolution** — smallest safe remediation; states whether approval is required (see `08-agent/`).
11. **Verification** — the deterministic predicate. Never "the command returned 200".
12. **Rollback**
13. **Prevention**
14. **Automation opportunities** — what the agent may do unattended vs. what needs a human.
15. **Common mistakes**
16. **Related problems**
17. **API references** — endpoint + method + required permission, linking to `07-tools/`.
18. **Official documentation** — URLs from the registry.

## Style rules

- Every GitHub-behavior claim carries `[src:<id>]`. Design recommendations are labelled *Design*.
- Never invent endpoints, permissions, headers or error strings. If not verified, write `UNVERIFIED`.
- Examples must be runnable or clearly marked illustrative.
- No filler. If a section has nothing substantive to say for this problem, write "n/a — <reason>" rather than padding.
