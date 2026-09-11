"""Local, free, offline embeddings — sentence-transformers/all-MiniLM-L6-v2
via fastembed's ONNX runtime (no torch). Same model production-architecture.md
names; fastembed instead of the sentence-transformers package because it
loads faster and has a far smaller dependency footprint, per that doc's
own runtime note.
"""

from functools import lru_cache

import numpy as np

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


@lru_cache(maxsize=1)
def _model():
    from fastembed import TextEmbedding

    return TextEmbedding(model_name=MODEL_NAME)


def embed(text: str) -> list[float]:
    """A single 384-dim embedding vector for `text`."""
    vec = next(iter(_model().embed([text])))
    return vec.tolist()


def cosine_similarity(a: list[float], b: list[float]) -> float:
    va, vb = np.array(a), np.array(b)
    denom = np.linalg.norm(va) * np.linalg.norm(vb)
    if denom == 0:
        return 0.0
    return float(np.dot(va, vb) / denom)
