# GitHub AI Troubleshooting Agent — Knowledge Base & Engineering Specification

**Status: foundation release (v0.1), written 2026-09-20.** This is the start of
a large, versioned, source-verified knowledge base — not the finished
1000-page document. Read this section first so nobody mistakes the scope.

## What this is, and what it deliberately is not

The brief asked for a 1000+ page production knowledge base. Two things
in that brief conflict: *every technically important claim verified
against current primary sources* and *1000+ pages*. Verified content
grows at the rate research grows; padding to hit a page count would
produce exactly the "generic filler" and "unverified assumptions" the
brief forbids. So this KB is built as a **growing, machine-readable
system**, and every chapter carries a status:

| Status | Meaning |
|---|---|
| `WRITTEN` | Written and sourced in this release. Claims tagged with a source id from `00-methodology/source-registry.yaml`. |
| `DESIGN` | Architecture/design recommendation authored here. Not a GitHub fact; judged on engineering merit, not citation. |
| `UNVERIFIED` | A claim we believe is true but did **not** confirm against a primary source in this pass. Must be verified before anyone builds on it. |
| `PLANNED` | Chapter exists in the table of contents, not yet written. |

`01-architecture/table-of-contents.md` lists every planned Part and its
current status. Nothing marked `PLANNED` should be treated as covered.

## Actual size of this release

About **23,700 words across 21 files** (≈ 55–60 printed pages, counting the
YAML registries): 19 registered sources, 17 error entries, 14 fully
specified tools, 2 complete playbooks, 20 red-team scenarios, and a
linter that fails the build on any dangling citation
(`python docs/knowledge-base/scripts/kb_lint.py`). That is roughly **5%
of a 1000-page target**, and the table of contents marks exactly which
parts are still unwritten. The gap is real; it is closed by verified
content and by *generating* reference appendices from GitHub's OpenAPI
description, not by padding.

## Read this before trusting a number

Sources were fetched from `docs.github.com` with an automated page
fetcher that returns a *model-generated summary* of the page, not the
raw HTML. That is good enough to establish structure and cross-check
claims, but numeric limits, header names, and permission names should
be **re-verified against the live page (or GitHub's OpenAPI spec)
before being hard-coded into production**. The source registry records
this per source. In particular, three cases where the fetcher could not
see what we needed are flagged rather than guessed:

1. Per-endpoint **fine-grained token permission sections** are not
   visible to the fetcher on the REST reference pages (it only saw
   classic `repo`/`workflow` scope language). The permission matrix
   therefore uses GitHub's *"Permissions required for GitHub Apps"*
   page, which the fetcher returned truncated. Rows are flagged
   accordingly.
2. The **default `GITHUB_TOKEN` permission** (permissive vs restricted)
   and the full scope table were not on any page the fetcher returned.
   They are `UNVERIFIED` here.
3. **Classic PAT / fine-grained PAT / deploy key / SSH** specifics were
   not fetched this pass. Those rows are `UNVERIFIED`.

## Layout

```text
docs/knowledge-base/
├── 00-methodology/     research method, source registry, article template
├── 01-architecture/    taxonomy, full table of contents, roadmap & risks
├── 02-platform/        REST/GraphQL fundamentals: versions, limits, pagination
├── 03-auth/            identities, GitHub Apps, tokens
├── 04-webhooks/        delivery, validation, queueing
├── 05-actions/         Actions troubleshooting, logs, GITHUB_TOKEN
├── 06-errors/          error intelligence (prose + machine-readable YAML)
├── 07-tools/           agent tool registry + permission matrix
├── 08-agent/           safety, risk tiers, approval, recovery, audit
├── 09-evaluation/      eval framework + red-team scenarios
├── 10-playbooks/       full troubleshooting playbooks (template-conformant)
└── 11-integration/     how this connects to the existing Operon codebase
```

## How it connects to the rest of this repository

The existing Operon work is a *browser-extension* support agent. This KB
specifies a different integration surface — an *API-based* GitHub agent
(GitHub App, REST/GraphQL, PRs, commits). They share the same design
spine (evidence → hypotheses → policy-gated action → deterministic
verification), the same `SupportSession` state machine, and the same
retrieval store. See `11-integration/operon-integration.md` for exactly
what carries over and what does not. Troubleshooting articles use a
front-matter schema that maps onto the existing `KnowledgeDocument`
model, so they can be ingested by `backend/scripts/seed_kb.py`-style
loaders without reshaping.

## Growth plan

Each release adds `WRITTEN` chapters and converts `UNVERIFIED` rows to
verified ones. The next verification pass should pull GitHub's published
OpenAPI description (github/rest-api-description) so that endpoint
permissions, status codes, and schemas are extracted programmatically
instead of summarised — that turns Appendix A/C from hand-maintained
tables into generated artifacts, which is the only sustainable way to
reach the breadth the brief describes.
