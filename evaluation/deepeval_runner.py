import sys
import json
import os
import ast
from pathlib import Path
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(PROJECT_ROOT / "backend" / ".env", override=False)

from openai import OpenAI
from deepeval.models import DeepEvalBaseLLM
from deepeval.test_case import LLMTestCase
from deepeval.metrics import (
    FaithfulnessMetric,
    AnswerRelevancyMetric,
    ContextualPrecisionMetric,
    ContextualRecallMetric,
)

class DeepSeekEvalModel(DeepEvalBaseLLM):
    def __init__(self):
        self.api_key = os.getenv("DEEPSEEK_API_KEY")
        self.model_name = os.getenv("DEEPSEEK_PRO_MODEL") or os.getenv("JUDGE_PRIMARY_MODEL") or "deepseek-v4-pro"
        self.client = OpenAI(
            api_key=self.api_key,
            base_url="https://api.deepseek.com"
        )

    def load_model(self):
        return self.client

    def generate(self, prompt: str) -> str:
        try:
            response = self.client.chat.completions.create(
                model=self.model_name,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
            )
            return response.choices[0].message.content or ""
        except Exception as e:
            return f"Error: {str(e)}"

    async def a_generate(self, prompt: str) -> str:
        return self.generate(prompt)

    def get_model_name(self):
        return self.model_name


def evaluate_single_item(item, model):
    question = str(item.get("question") or "").trim() if hasattr(str(item.get("question") or ""), "trim") else str(item.get("question") or "").strip()
    answer = str(item.get("answer") or "").strip()
    reference = str(item.get("reference") or item.get("ground_truth") or "").strip()
    contexts = item.get("contexts") or item.get("retrieved_contexts") or []

    if isinstance(contexts, str):
        try:
            contexts = ast.literal_eval(contexts)
        except Exception:
            contexts = [contexts]

    normalized_contexts = [str(c).strip() for c in contexts if str(c).strip()]

    test_case = LLMTestCase(
        input=question,
        actual_output=answer,
        expected_output=reference if reference else None,
        retrieval_context=normalized_contexts,
        retrieved_contexts=normalized_contexts
    )

    faithfulness_metric = FaithfulnessMetric(threshold=0.5, model=model, include_reason=True)
    relevancy_metric = AnswerRelevancyMetric(threshold=0.5, model=model, include_reason=True)
    precision_metric = ContextualPrecisionMetric(threshold=0.5, model=model, include_reason=True)
    recall_metric = ContextualRecallMetric(threshold=0.5, model=model, include_reason=True)

    metrics = [faithfulness_metric, relevancy_metric, precision_metric, recall_metric]
    results = {}

    for metric in metrics:
        try:
            metric.measure(test_case)
            results[metric.__class__.__name__] = {
                "score": round(float(metric.score), 2) if metric.score is not None else None,
                "reason": str(getattr(metric, "reason", "") or "").strip(),
                "success": bool(metric.is_successful()) if hasattr(metric, "is_successful") else True
            }
        except Exception as err:
            results[metric.__class__.__name__] = {
                "score": None,
                "reason": f"Evaluation error: {str(err)}",
                "success": False
            }

    faithfulness_score = results.get("FaithfulnessMetric", {}).get("score")
    relevancy_score = results.get("AnswerRelevancyMetric", {}).get("score")
    precision_score = results.get("ContextualPrecisionMetric", {}).get("score")
    recall_score = results.get("ContextualRecallMetric", {}).get("score")

    valid_scores = [s for s in [faithfulness_score, relevancy_score, precision_score, recall_score] if s is not None]
    overall_score = round(sum(valid_scores) / len(valid_scores), 2) if valid_scores else None

    return {
        "question": question,
        "answer": answer,
        "reference": reference,
        "contexts": normalized_contexts,
        "faithfulness": faithfulness_score,
        "faithfulnessReason": results.get("FaithfulnessMetric", {}).get("reason"),
        "answerRelevancy": relevancy_score,
        "answerRelevancyReason": results.get("AnswerRelevancyMetric", {}).get("reason"),
        "contextPrecision": precision_score,
        "contextPrecisionReason": results.get("ContextualPrecisionMetric", {}).get("reason"),
        "contextRecall": recall_score,
        "contextRecallReason": results.get("ContextualRecallMetric", {}).get("reason"),
        "overallScore": overall_score,
        "status": "completed" if valid_scores else "failed",
        "evaluator": "DeepEval",
        "model": model.get_model_name()
    }


def main():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            raise ValueError("No JSON payload received on stdin")

        payload = json.loads(raw_input)
        rows = payload.get("dataset") or payload.get("rows") or [payload]

        eval_model = DeepSeekEvalModel()
        evaluations = []

        for row in rows:
            evaluations.append(evaluate_single_item(row, eval_model))

        print(json.dumps(evaluations, ensure_ascii=False, indent=2))
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()
