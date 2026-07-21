import os
from typing import Optional


def get_ragas_llm_config() -> dict:
    ragas_api_key = os.getenv("GROQ_API_KEY_RAGAS")
    fallback_api_key = os.getenv("GROQ_API_KEY")
    fallback_model = os.getenv("GROQ_MODEL") or os.getenv("GROQ_LLAMA_MODEL") or "llama-3.3-70b-versatile"

    api_key = ragas_api_key or fallback_api_key
    model = os.getenv("GROQ_MODEL_RAGAS") or fallback_model

    return {
        "api_key": api_key,
        "model": model,
        "base_url": "https://api.groq.com/openai/v1",
    }


def get_ragas_api_key() -> Optional[str]:
    return get_ragas_llm_config()["api_key"]


def get_ragas_model() -> str:
    return get_ragas_llm_config()["model"]
