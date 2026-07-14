import os
import json
import asyncio
from pathlib import Path

import requests
from dotenv import load_dotenv
from openai import AsyncOpenAI

from ragas.llms import llm_factory
from ragas.metrics.collections import Faithfulness


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

    groq_api_key = os.getenv("GROQ_API_KEY")

    if not groq_api_key:
        raise ValueError(
            "GROQ_API_KEY is not configured in .env"
        )

    client = AsyncOpenAI(
        api_key=groq_api_key,
        base_url="https://api.groq.com/openai/v1",
    )

    evaluator_llm = llm_factory(
        "llama-3.3-70b-versatile",
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