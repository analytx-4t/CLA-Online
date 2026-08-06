import ast
import json
import os
import sys
from pathlib import Path

from datasets import Dataset
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from ragas import evaluate
from ragas.metrics import (
    AnswerCorrectness,
    AnswerRelevancy,
    ContextPrecision,
    ContextRecall,
    Faithfulness,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.append(str(PROJECT_ROOT))

load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(PROJECT_ROOT / "embedding" / ".env", override=False)


def _normalize_contexts(contexts):
    if not contexts:
        return []

    normalized = []
    for context in contexts:
        if isinstance(context, str):
            try:
                parsed = ast.literal_eval(context)
            except Exception:
                parsed = [context]

            if isinstance(parsed, list):
                normalized.append(parsed)
            else:
                normalized.append([parsed])
        else:
            normalized.append(context)

    return normalized


def run_evaluation_from_dataset(dataset_rows):
    if not dataset_rows:
        return []

    dataset = Dataset.from_dict(
        {
            "question": [row.get("question") or "" for row in dataset_rows],
            "answer": [row.get("answer") or "" for row in dataset_rows],
            "reference": [row.get("reference") or "" for row in dataset_rows],
            "ground_truth": [row.get("reference") or "" for row in dataset_rows],
            "contexts": _normalize_contexts([row.get("contexts") for row in dataset_rows]),
        }
    )

    deepseek_key = os.getenv("DEEPSEEK_API_KEY")
    llm = ChatOpenAI(
        model=os.getenv("DEEPSEEK_PRO_MODEL") or "deepseek-chat",
        api_key=deepseek_key,
        base_url="https://api.deepseek.com",
        temperature=0,
    )
    embeddings = OpenAIEmbeddings(model="text-embedding-3-large")

    result = evaluate(
        dataset=dataset,
        metrics=[
            Faithfulness(),
            AnswerRelevancy(),
            ContextPrecision(),
            ContextRecall(),
            AnswerCorrectness(),
        ],
        llm=llm,
        embeddings=embeddings,
    )

    return result.to_pandas().to_dict(orient="records")


def main():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            raise ValueError("No JSON input received")

        payload = json.loads(raw_input)
        rows = payload.get("dataset") or payload.get("rows") or []
        dataframe_rows = run_evaluation_from_dataset(rows)
        print(json.dumps(dataframe_rows, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
