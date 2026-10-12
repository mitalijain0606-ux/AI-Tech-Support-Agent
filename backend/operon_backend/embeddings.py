"""Local, free, offline embeddings — sentence-transformers/all-MiniLM-L6-v2
via fastembed's ONNX runtime (no torch). Same model production-architecture.md
names; fastembed instead of the sentence-transformers package because it
loads faster and has a far smaller dependency footprint, per that doc's
own runtime note.
"""

import time
from functools import lru_cache

import numpy as np

from operon_backend.config import settings

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIM = 384


class EmbeddingUnavailable(RuntimeError):
    """The embedding model can't be loaded (typically: first-use download
    blocked or offline). Retrieval treats this as "search unavailable", which
    is distinct from "searched, found nothing"."""


@lru_cache(maxsize=1)
def _load_model():
    from fastembed import TextEmbedding

    return TextEmbedding(model_name=MODEL_NAME)


# Only successes are cached by lru_cache, so a failed load would otherwise be
# retried (a network download) on every call. Remember the failure briefly.
_unavailable_until = 0.0
_unavailable_reason = ""


def status() -> dict:
    """What a readiness probe needs: is the model loaded, and if loading failed
    recently, why (the exception type only)."""
    now = time.monotonic()
    return {
        "loaded": _load_model.cache_info().currsize > 0,
        "unavailable": now < _unavailable_until,
        "reason": _unavailable_reason if now < _unavailable_until else "",
    }


def reset_unavailable_state() -> None:
    """Forget a remembered load failure (tests; or after fixing the network)."""
    global _unavailable_until, _unavailable_reason
    _unavailable_until, _unavailable_reason = 0.0, ""


def _model():
    global _unavailable_until, _unavailable_reason
    now = time.monotonic()
    if now < _unavailable_until:
        raise EmbeddingUnavailable(
            f"embedding model unavailable ({_unavailable_reason}); not retrying for {int(_unavailable_until - now) + 1}s"
        )
    try:
        return _load_model()
    except Exception as exc:  # network, blocked host, ONNX runtime, corrupt cache, disk
        _unavailable_until = now + settings.embedding_retry_cooldown_seconds
        _unavailable_reason = type(exc).__name__
        raise EmbeddingUnavailable(f"embedding model could not be loaded ({type(exc).__name__}: {str(exc)[:160]})") from exc


def embed(text: str) -> list[float]:
    """A single 384-dim embedding vector for `text`."""
    vec = next(iter(_model().embed([text])))
    return vec.tolist()


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Batch embedding for multiple texts."""
    if not texts:
        return []
    return [vec.tolist() for vec in _model().embed(texts)]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    va, vb = np.array(a), np.array(b)
    denom = np.linalg.norm(va) * np.linalg.norm(vb)
    if denom == 0:
        return 0.0
    return float(np.dot(va, vb) / denom)

