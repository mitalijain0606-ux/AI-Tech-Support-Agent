"""Lint the knowledge base: schema checks on the machine-readable files and
citation integrity across all files.

Checks
  - source-registry.yaml: required fields per source, unique ids.
  - errors.yaml: required fields per entry, unique ids, verification_status
    is valid, every cited source id exists in the registry, `verified`
    entries cite at least one source.
  - tool-registry.yaml: required fields per tool, unique names, risk level
    valid, write tools declare idempotency + verification, every cited
    source id exists.
  - Markdown: every `[src:<id>]` tag resolves to a registry id.
  - Markdown front matter `sources:` lists resolve.

Usage:  python docs/knowledge-base/scripts/kb_lint.py
Exit code 1 if any problem is found.
"""

import re
import sys
from pathlib import Path

import yaml

KB = Path(__file__).resolve().parent.parent

SOURCE_REQUIRED = {"id", "title", "url", "authority", "accessed", "extraction", "stability", "supports"}
ERROR_REQUIRED = {
    "id", "name", "message_patterns", "http_status", "subsystem", "severity",
    "verification_status", "sources", "common_causes", "distinguish_from",
    "required_evidence", "diagnostic_steps", "remediation", "verification",
    "rollback", "related_errors", "github_documentation",
}
TOOL_REQUIRED = {
    "name", "purpose", "authentication", "permissions", "risk", "side_effects",
    "idempotency", "confirmation", "retry", "verification", "verification_status",
}
VERIFICATION_STATUSES = {"verified", "partial", "unverified"}
RISK_LEVELS = {"read_only", "low", "medium", "high"}

problems: list[str] = []


def bad(msg: str) -> None:
    problems.append(msg)


def load(path: Path):
    return yaml.safe_load(path.read_text())


def main() -> int:
    registry = load(KB / "00-methodology" / "source-registry.yaml")
    source_ids: set[str] = set()
    for s in registry["sources"]:
        missing = SOURCE_REQUIRED - s.keys()
        if missing:
            bad(f"source {s.get('id')}: missing {sorted(missing)}")
        if s["id"] in source_ids:
            bad(f"duplicate source id {s['id']}")
        source_ids.add(s["id"])

    errors = load(KB / "06-errors" / "errors.yaml")["errors"]
    seen: set[str] = set()
    error_ids = {e["id"] for e in errors}
    for e in errors:
        missing = ERROR_REQUIRED - e.keys()
        if missing:
            bad(f"error {e.get('id')}: missing {sorted(missing)}")
        if e["id"] in seen:
            bad(f"duplicate error id {e['id']}")
        seen.add(e["id"])
        if e["verification_status"] not in VERIFICATION_STATUSES:
            bad(f"error {e['id']}: bad verification_status {e['verification_status']!r}")
        for sid in e["sources"]:
            if sid not in source_ids:
                bad(f"error {e['id']}: unknown source {sid!r}")
        if e["verification_status"] == "verified" and not e["sources"]:
            bad(f"error {e['id']}: marked verified but cites no source")
        for rid in e["related_errors"]:
            if rid not in error_ids:
                bad(f"error {e['id']}: related error {rid!r} does not exist")

    tools_path = KB / "07-tools" / "tool-registry.yaml"
    tools = []
    if tools_path.exists():
        tools = load(tools_path)["tools"]
        names: set[str] = set()
        for t in tools:
            missing = TOOL_REQUIRED - t.keys()
            if missing:
                bad(f"tool {t.get('name')}: missing {sorted(missing)}")
            if t["name"] in names:
                bad(f"duplicate tool {t['name']}")
            names.add(t["name"])
            if t["risk"]["level"] not in RISK_LEVELS:
                bad(f"tool {t['name']}: bad risk level {t['risk']['level']!r}")
            if t["risk"]["level"] != "read_only":
                if t["idempotency"].get("type") in (None, ""):
                    bad(f"tool {t['name']}: write tool without idempotency type")
                if not t["verification"]:
                    bad(f"tool {t['name']}: write tool without verification predicate")
            for sid in t.get("sources", []):
                if sid not in source_ids:
                    bad(f"tool {t['name']}: unknown source {sid!r}")

    tag = re.compile(r"\[src:([a-z0-9\-]+)\]")
    front = re.compile(r"^sources:\s*\[(.*?)\]", re.M)
    for md in KB.rglob("*.md"):
        text = md.read_text()
        for sid in tag.findall(text):
            if sid not in source_ids:
                bad(f"{md.relative_to(KB)}: unknown [src:{sid}]")
        m = front.search(text)
        if m:
            for sid in [x.strip() for x in m.group(1).split(",") if x.strip()]:
                if sid not in source_ids:
                    bad(f"{md.relative_to(KB)}: front-matter source {sid!r} not in registry")

    if problems:
        print(f"{len(problems)} problem(s):")
        for p in problems:
            print("  -", p)
        return 1
    print(f"ok: {len(source_ids)} sources, {len(errors)} error entries, {len(tools)} tools, all citations resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
