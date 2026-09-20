# Research methodology

## Source hierarchy (highest authority first)

1. Current GitHub official documentation (`docs.github.com`)
2. GitHub's published API description (OpenAPI, `github/rest-api-description`)
3. GitHub changelog (`github.blog/changelog`)
4. Official GitHub repositories
5. Official SDK documentation (Octokit)
6. GitHub Engineering / GitHub Blog
7. Trusted ecosystem documentation (git-scm.com, language/package-manager docs)
8. Community discussions

Conflict rule: prefer the higher-authority source; between equals,
prefer the newer. A community answer never overrides official docs; if
they disagree, record the disagreement as a note on the article rather
than silently picking one.

## Verification protocol (applied per claim)

For every technically important claim:

1. Fetch the primary source. Do not write from memory.
2. Record it in `source-registry.yaml` with id, URL, title, access date.
3. Tag the claim in the article with the source id, e.g. `[src:rest-rate-limits]`.
4. Classify stability: `stable` (changes rarely), `versioned` (tied to an
   API version), `volatile` (limits/prices/UI that GitHub changes freely).
5. If it could not be confirmed, mark it `UNVERIFIED` in place. An
   honest `UNVERIFIED` is a valid, useful KB entry; a confident guess is not.

## Known limits of this method (be honest about them)

- **Fetcher summarisation.** Pages were retrieved through a tool that
  returns a model summary, not raw text. It can drop rows, flatten
  fine-grained permission names to classic scopes, or truncate long
  pages. Any number, header name, or permission name that a production
  system will *enforce* must be re-verified against the live page or the
  OpenAPI spec. The registry marks each source `extraction: summarised`.
- **Docs describe intent, not every runtime behavior.** Where a claim is
  really about observed behavior (e.g. exactly when a `403` vs `429` is
  returned), the KB says "per docs" and the evaluation framework
  (`09-evaluation/`) is where behavior gets tested against a real
  sandbox org.
- **Time.** All facts are as of the `accessed` date in the registry.
  GitHub changes limits, versions and UI often.

## Freshness metadata

Every article carries:

```yaml
sources: [rest-rate-limits, rest-best-practices]   # ids from the registry
last_verified: 2026-09-20
api_version: "2022-11-28"     # the X-GitHub-Api-Version the claims were checked against
stability: versioned          # stable | versioned | volatile
deprecated: false
replacement: null
confidence: medium            # high | medium | low — see confidence rubric
```

Confidence rubric for *knowledge* (not for agent diagnoses — see
`08-agent/` for those):

- **high** — stated verbatim by an authoritative source *and* checked
  against a second source or against real behavior.
- **medium** — stated by one authoritative source via summarised fetch.
- **low** — inferred, or from a lower-authority source.

## Scheduled refresh (design)

- Weekly: diff the OpenAPI description commit history for endpoint,
  parameter, permission and status-code changes; open a KB issue per
  changed operation.
- Weekly: check the GitHub changelog for API version releases, new
  webhook events, Actions changes; open an issue per relevant entry.
- Monthly: re-fetch every `volatile` source and diff numeric limits.
- On any API version release: re-run the tool-registry contract tests
  (`07-tools/`) against a sandbox org with the new
  `X-GitHub-Api-Version`.
- Every article past 90 days since `last_verified` is flagged stale and
  its confidence is capped at `low` until re-verified. The agent should
  treat a stale article as a hint, not a fact.

## Version awareness rule

Never hard-code a version-dependent fact without its version. Example:
"default API version is `2022-11-28` when no header is sent [src:rest-api-versions]"
— not "the API version is 2022-11-28". Runtime versions (Node, Python),
runner images, and package-manager behavior are *always* volatile and
must be read from the repository being investigated, not from this KB.
