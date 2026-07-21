import os
import json
import asyncio
from pathlib import Path

import requests
from dotenv import load_dotenv
from openai import AsyncOpenAI

from ragas.llms import llm_factory
from ragas.metrics.collections import Faithfulness

from ragas_config import get_ragas_llm_config


ROOT_DIR = Path(__file__).resolve().parent.parent

load_dotenv(ROOT_DIR / ".env")

DATASET_PATH = (
    ROOT_DIR
    / "evaluation"
    / "datasets"
    / "legal_test_dataset.json"
)

RESULTS_PATH = (
    ROOT_DIR
    / "evaluation"
    / "results"
    / "ragas_results.json"
)

BACKEND_URL = "http://localhost:3000/api/llm/generate"


def generate_answer(question, contexts):
    context_text = "\n\n".join(contexts)

    system_prompt = """
You are a legal information assistant.

Answer the user's question using only the supplied legal context.

Do not add facts that are not supported by the context.
If the context is insufficient, clearly say so.
"""

    message = f"""
LEGAL CONTEXT:

{context_text}

QUESTION:

{question}
"""

    payload = {
        "provider": "groq",
        "systemPrompt": system_prompt,
        "messages": [
            {
                "role": "user",
                "content": message,
            }
        ],
        "temperature": 0.1,
        "maxTokens": 300,
    }

    response = requests.post(
        BACKEND_URL,
        json=payload,
        timeout=60,
    )

    response.raise_for_status()

    return response.json()["content"]


async def main():
    with open(
        DATASET_PATH,
        "r",
        encoding="utf-8",
    ) as file:
        dataset = json.load(file)

    ragas_config = get_ragas_llm_config()
    groq_api_key = ragas_config["api_key"]

    if not groq_api_key:
        raise ValueError(
            "No RAGAS evaluator API key is configured. Set GROQ_API_KEY_RAGAS or GROQ_API_KEY."
        )

    client = AsyncOpenAI(
        api_key=groq_api_key,
        base_url=ragas_config["base_url"],
    )

    evaluator_llm = llm_factory(
        ragas_config["model"],
        client=client,
    )

    faithfulness = Faithfulness(
        llm=evaluator_llm,
    )

    results = []

    for index, item in enumerate(
        dataset,
        start=1,
    ):
        print(f"\nEvaluating sample {index}...")

        answer = item.get("response_override")

        if not answer:
            answer = generate_answer(
                item["user_input"],
                item["retrieved_contexts"],
            )

        score = await faithfulness.ascore(
            user_input=item["user_input"],
            response=answer,
            retrieved_contexts=item["retrieved_contexts"],
        )

        result = {
        "user_input": item["user_input"],
        "response": answer,
        "reference": item["reference"],
        "expected_faithfulness": item.get(
            "expected_faithfulness"
        ),
        "faithfulness": float(score.value),
        "reason": score.reason,
        }

        results.append(result)

        print(f"Answer: {answer}")
        print(
            f"Faithfulness: {score.value}"
        )

    RESULTS_PATH.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with open(
        RESULTS_PATH,
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            results,
            file,
            indent=2,
            ensure_ascii=False,
        )

    average_score = sum(
        item["faithfulness"]
        for item in results
    ) / len(results)

    print("\n-----------------------------")
    print("RAGAS EVALUATION COMPLETE")
    print("-----------------------------")
    print(
        f"Samples evaluated: {len(results)}"
    )
    print(
        f"Average faithfulness: "
        f"{average_score:.4f}"
    )
    print(
        f"Results saved to: {RESULTS_PATH}"
    )


if __name__ == "__main__":
    asyncio.run(main())