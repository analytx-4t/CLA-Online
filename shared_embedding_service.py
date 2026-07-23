import json
import os
import re
import sys
import urllib.error
import urllib.request
from typing import Iterable, List, Sequence

EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "openai")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-large")
EMBEDDING_DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "3072"))


def normalize_embedding_text(value):
    """Normalize text for OpenAI embedding input while preserving legal content."""
    if value is None:
        return ""

    text = str(value)
    text = text.replace("\r\n", "\n")
    text = text.replace("\r", "\n")
    text = re.sub(r"\s+", " ", text).strip()
    return text.encode("utf-8", errors="replace").decode("utf-8")


def get_openai_api_key() -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is not configured for shared embeddings")
    return api_key


def get_embedding_metadata() -> dict:
    return {
        "provider": EMBEDDING_PROVIDER,
        "model": EMBEDDING_MODEL,
        "dimensions": EMBEDDING_DIMENSIONS,
    }


def _request_embeddings(input_value, *, timeout=60):
    api_key = get_openai_api_key()
    payload = {
        "input": input_value,
        "model": EMBEDDING_MODEL,
        "dimensions": EMBEDDING_DIMENSIONS,
    }

    request = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response_text = response.read().decode("utf-8")
            response_json = json.loads(response_text)
    except urllib.error.HTTPError as error:
        error_text = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI embeddings request failed: {error.code} {error_text}") from error
    except Exception as error:
        raise RuntimeError(f"OpenAI embeddings request failed: {error}") from error

    data = response_json.get("data") or []
    if not data:
        raise RuntimeError("OpenAI embeddings response did not contain any vector data")

    return [item["embedding"] for item in data]


def embed_text(text):
    text = normalize_embedding_text(text)
    if not text:
        return []

    result = _request_embeddings(text)
    return result[0]


def embed_texts(texts: Sequence[str]):
    cleaned = [normalize_embedding_text(text) for text in texts]
    cleaned = [text for text in cleaned if text]
    if not cleaned:
        return []

    result = _request_embeddings(cleaned)
    return result


def embed_query(query_text):
    return embed_text(query_text)


def log_embedding_context(prefix="[Shared Embeddings]"):
    metadata = get_embedding_metadata()
    print(
        f"{prefix} provider={metadata['provider']} model={metadata['model']} dimensions={metadata['dimensions']}",
        file=sys.stderr,
    )
