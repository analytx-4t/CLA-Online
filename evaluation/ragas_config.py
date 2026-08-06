import os
from typing import Optional


def get_ragas_llm_config() -> dict:
    api_key = os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY")
    model = os.getenv("DEEPSEEK_PRO_MODEL") or os.getenv("DEFAULT_LLM_MODEL") or "deepseek-chat"

    return {
        "api_key": api_key,
        "model": model,
        "base_url": "https://api.deepseek.com",
    }



def get_ragas_api_key() -> Optional[str]:
    return get_ragas_llm_config()["api_key"]


def get_ragas_model() -> str:
    return get_ragas_llm_config()["model"]
