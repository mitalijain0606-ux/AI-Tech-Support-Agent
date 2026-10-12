"""Downloads and loads the embedding model once, at build time.

    python scripts/warm_model.py

Run during the deploy build with FASTEMBED_CACHE_PATH pointing inside the
project directory, so the ~90 MB model ships with the build and a restarting
instance does not have to download it (a host's runtime disk is usually
ephemeral). Exits non-zero if the model cannot be loaded, failing the build
instead of shipping an instance that starts with an empty knowledge base.
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from operon_backend.embeddings import EMBEDDING_DIM, MODEL_NAME, embed  # noqa: E402


def main() -> int:
    started = time.monotonic()
    vector = embed("warm up")
    if len(vector) != EMBEDDING_DIM:
        print(f"unexpected embedding size {len(vector)} (expected {EMBEDDING_DIM})", file=sys.stderr)
        return 1
    print(f"{MODEL_NAME} ready ({len(vector)} dims) in {time.monotonic() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
