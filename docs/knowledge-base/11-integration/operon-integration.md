# Integration with the existing Operon codebase

This KB specifies an **API-based GitHub agent**. The repository today
contains a **browser-extension** support agent. They are two
*providers* on the same spine; this note says exactly what carries over
and what does not, so nobody rebuilds what exists or assumes something
transfers that doesn't.

## What carries over unchanged (already built and tested)

| Existing piece | Location | Reuse |
|---|---|---|
| `SupportSession` + 12-phase state machine with logged transitions | `backend/operon_backend/state_machine.py`, `session_service.py`, `db_models.py` | The GitHub agent's lifecycle as-is (see `08-agent/agent-architecture.md` §2) |
| Policy engine returning `ALLOW / REQUIRE_APPROVAL / DENY` from a **closed action set**, deterministic, provider-capability-aware | `backend/operon_backend/policy.py` | Same design; the action set becomes the tool registry (`07-tools/`). The existing rule "empty capabilities ⇒ deny everything" is exactly what permission-aware planning needs |
| Evidence-citation guardrail (`evidence_ids` must exist in the submitted bundle; also applied to `knowledge_refs`) | `backend/operon_backend/llm.py` | Unchanged — the core anti-hallucination control |
| Credential tripwire on inbound payloads | `backend/operon_backend/tripwire.py` | Basis of the log/tool-output scrubber (`08-agent/` §10); extend with GitHub token shapes (unverified formats) |
| Retrieval store (`knowledge_chunks`, MiniLM embeddings via `fastembed`, cosine search, `KnowledgeDocument`) | `embeddings.py`, `retrieval.py`, `knowledge.py`, `scripts/seed_kb.py` | KB articles are ingested through this exact pipeline (§ below) |
| Bounded loop limits, hypothesis model, remediation-proposal step, deterministic verification, "never claim success without verification" | `AGENT_ARCHITECTURE.md` | The GitHub agent is another instantiation of it |

## What does not carry over

| Browser-agent piece | Why not | GitHub-agent replacement |
|---|---|---|
| `chrome.debugger`, content script, `EvidenceBundle` of console/network/storage/cookies | Browser-only evidence | A new typed API `EvidenceBundle` (run/job/step records, scrubbed log excerpts, headers, status codes, file hashes, PR/branch state) — same `ev_` id + citation rule |
| Actions `clear_storage_key`, `reload`, … | Browser actions | `github.*` registry tools |
| Extension popup approval UI | Different surface | Web console approval card (`08-agent/` §4) |
| Statelessness of the extension provider | The GitHub agent needs webhooks, queues, tenants | Async workers + durable state (`04-webhooks/`) |
| Per-customer locked extension build | Not applicable | GitHub App installation = per-tenant boundary |

## Ingesting KB articles into retrieval

1. Articles with a `doc_id` in front matter load into `KnowledgeDocument`
   unchanged — **proven by `backend/tests/test_kb_articles.py`**, which
   loads every such article's front matter into the real model and
   asserts the freshness fields exist.
2. Note the honest gap: only the two playbooks
   (`10-playbooks/`) carry the full `symptoms / causes /
   evidence_patterns / …` lists that make retrieval effective. The
   chapter-style articles have a title and freshness metadata only, so
   they embed on title text. Converting chapters into retrieval-shaped
   *article units* (one problem per document, per the template) is
   backlog work, not done here.
3. Error entries (`06-errors/errors.yaml`) are a natural second corpus:
   one chunk per error id, embedded from `message_patterns +
   distinguish_from + common_causes`, retrieved when a tool result
   carries a status/message. Loader **PLANNED**.
4. Retrieval must be tenant- and freshness-aware: filter out articles
   past their staleness window; never let one tenant's *history* chunks
   surface for another (`08-agent/` §12).
5. Retrieved KB text is *precedent, not evidence*: it can raise
   confidence in an interpretation but never justifies citing evidence
   that isn't in the current investigation — the existing
   `knowledge_refs` rule.

## Suggested build order given what already exists

1. GitHub App skeleton + installation-token service (`03-auth/`) with
   tested JWT and renewal.
2. Webhook ingress with signature verification + delivery dedup
   (`04-webhooks/`) — code samples there are tested.
3. Rate-limit-aware API client (`02-platform/` §3.4).
4. Read-only tool set from the registry + API `EvidenceBundle` +
   log scrubber/normaliser.
5. Wire tools into the existing session/policy/verification spine;
   ship the failed-Actions diagnosis playbook (read-only MVP).
6. Evaluation harness with a fake GitHub server (`09-evaluation/`) —
   **before** any write tool.
7. Write tools by risk tier, each gated on its eval scenarios.
