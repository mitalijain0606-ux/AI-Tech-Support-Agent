"""The GitHub knowledge base's troubleshooting articles claim to be
compatible with the repository's KnowledgeDocument model (see
docs/knowledge-base/00-methodology/article-template.md). This proves it:
every article that declares a doc_id must load into KnowledgeDocument
unchanged, and must be embeddable.
"""

import re
from pathlib import Path

import pytest
import yaml

from operon_backend.knowledge import KnowledgeDocument

KB_DIR = Path(__file__).resolve().parents[2] / "docs" / "knowledge-base"
FRONT_MATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
DOC_FIELDS = set(KnowledgeDocument.model_fields)


def _articles():
    for md in sorted(KB_DIR.rglob("*.md")):
        m = FRONT_MATTER.match(md.read_text())
        if not m:
            continue
        meta = yaml.safe_load(m.group(1))
        if isinstance(meta, dict) and "doc_id" in meta:
            yield md, meta


ARTICLES = list(_articles())


def test_articles_were_found():
    # Guards against the glob silently matching nothing.
    assert len(ARTICLES) >= 6


@pytest.mark.parametrize("path,meta", ARTICLES, ids=[p.name for p, _ in ARTICLES])
def test_article_loads_as_knowledge_document(path, meta):
    fields = {k: v for k, v in meta.items() if k in DOC_FIELDS}
    doc = KnowledgeDocument(**fields)
    assert doc.doc_id and doc.title
    # Freshness metadata is mandatory per the methodology.
    for key in ("sources", "last_verified", "stability", "confidence"):
        assert key in meta, f"{path.name} missing freshness field {key!r}"
    assert doc.to_embedding_text().strip()
