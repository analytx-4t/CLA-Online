import os
import asyncio
from pathlib import Path

import requests
from dotenv import load_dotenv
from pymongo import MongoClient

ROOT_DIR = Path(__file__).resolve().parent.parent

load_dotenv(ROOT_DIR / ".env")

BACKEND_URL = "http://localhost:3000/api/ask"


def load_golden_dataset():
    mongo_uri = os.getenv("MONGODB_URI")
    if not mongo_uri:
        raise ValueError("MONGODB_URI is not configured.")

    client = MongoClient(mongo_uri)
    database_name = os.getenv("MONGODB_DATABASE", "cla_legal_chat")
    database = client[database_name]
    return list(database["golden_dataset"].find({}))


async def main():
    dataset = load_golden_dataset()
    if not dataset:
        print("No golden dataset rows found in MongoDB.")
        return

    for index, item in enumerate(dataset, start=1):
        question = item.get("question")
        if not question:
            continue

        print(f"\nEvaluating sample {index}: {question}")
        response = requests.post(
            BACKEND_URL,
            json={"question": question},
            timeout=180,
        )
        response.raise_for_status()
        payload = response.json()
        print(f"Answer: {payload.get('answer', '')}")
        evaluation = payload.get("evaluation") or {}
        print(f"Faithfulness: {evaluation.get('faithfulness')}")
        print(f"Answer Relevancy: {evaluation.get('answer_relevancy')}")
        print(f"Context Precision: {evaluation.get('context_precision')}")
        print(f"Context Recall: {evaluation.get('context_recall')}")
        print(f"Answer Correctness: {evaluation.get('answer_correctness')}")

    print("\n-----------------------------")
    print("RAGAS EVALUATION COMPLETE")
    print("-----------------------------")
    print(f"Samples evaluated: {len(dataset)}")


if __name__ == "__main__":
    asyncio.run(main())
