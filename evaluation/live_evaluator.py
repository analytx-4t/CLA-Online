import sys
import json
import os
import asyncio
from pathlib import Path

from google import genai
from dotenv import load_dotenv
from openai import AsyncOpenAI

from ragas.llms import llm_factory
from ragas.embeddings import GoogleEmbeddings
from ragas.metrics.collections import (
    Faithfulness,
    AnswerRelevancy,
    ContextPrecisionWithoutReference,
)


# ============================================================
# ENVIRONMENT SETUP
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Load main project environment variables
load_dotenv(PROJECT_ROOT / ".env")

# Load embedding environment variables
# override=False means root .env values are kept if already present
load_dotenv(
    PROJECT_ROOT / "embedding" / ".env",
    override=False,
)


def safe_score(result):
    """
    Convert a RAGAS result into a JSON-safe float.
    Returns None if the metric could not produce a score.
    """
    if result is None:
        return None

    value = getattr(result, "value", result)

    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None


async def evaluate_live(question, answer, contexts):
    # ========================================================
    # VALIDATE INPUT
    # ========================================================

    if not question or not str(question).strip():
        raise ValueError("question is required")

    if not answer or not str(answer).strip():
        raise ValueError("answer is required")

    if not contexts or not isinstance(contexts, list):
        raise ValueError(
            "contexts must be a non-empty list"
        )

    # ========================================================
    # API KEYS
    # ========================================================

    groq_api_key = os.getenv("GROQ_API_KEY")
    gemini_api_key = os.getenv("GEMINI_API_KEY")

    if not groq_api_key:
        raise ValueError(
            "GROQ_API_KEY is not configured in the root .env"
        )

    if not gemini_api_key:
        raise ValueError(
            "GEMINI_API_KEY is not configured in .env "
            "or embedding/.env"
        )

    # ========================================================
    # RAGAS EVALUATOR LLM
    #
    # Groq is used as the judge LLM.
    # ========================================================

    groq_client = AsyncOpenAI(
        api_key=groq_api_key,
        base_url="https://api.groq.com/openai/v1",
    )

    evaluator_llm = llm_factory(
        "llama-3.3-70b-versatile",
        client=groq_client,
    )

    # ========================================================
    # GEMINI EMBEDDINGS
    #
    # Required by Answer Relevancy.
    # ========================================================

    gemini_client = genai.Client(
        api_key=gemini_api_key
    )

    evaluator_embeddings = GoogleEmbeddings(
        client=gemini_client,
        model="gemini-embedding-001",
    )

    # ========================================================
    # RAGAS METRICS
    # ========================================================

    faithfulness_metric = Faithfulness(
        llm=evaluator_llm,
    )

    answer_relevancy_metric = AnswerRelevancy(
        llm=evaluator_llm,
        embeddings=evaluator_embeddings,
    )

    context_precision_metric = (
        ContextPrecisionWithoutReference(
            llm=evaluator_llm,
        )
    )

    # ========================================================
    # RESULT OBJECT
    # ========================================================

    evaluation = {
        "faithfulness": None,
        "answer_relevancy": None,
        "context_precision": None,
        "hallucination_score": None,
        "overall_score": None,
        "status": "completed",
    }

    errors = {}

    # ========================================================
    # 1. FAITHFULNESS
    #
    # Measures whether the generated answer is supported
    # by the retrieved contexts.
    # ========================================================

    try:
        result = await faithfulness_metric.ascore(
            user_input=question,
            response=answer,
            retrieved_contexts=contexts,
        )

        evaluation["faithfulness"] = safe_score(result)

    except Exception as error:
        errors["faithfulness"] = str(error)

    # ========================================================
    # 2. ANSWER RELEVANCY
    #
    # Measures whether the generated answer actually
    # addresses the user's question.
    #
    # Uses:
    # - Groq LLM
    # - Gemini embeddings
    # ========================================================

    try:
        result = await answer_relevancy_metric.ascore(
            user_input=question,
            response=answer,
        )

        evaluation["answer_relevancy"] = safe_score(result)

    except Exception as error:
        errors["answer_relevancy"] = str(error)

    # ========================================================
    # 3. CONTEXT PRECISION
    #
    # Measures the quality/relevance of retrieved contexts.
    # This version does not require a golden reference answer.
    # ========================================================

    try:
        result = await context_precision_metric.ascore(
            user_input=question,
            response=answer,
            retrieved_contexts=contexts,
        )

        evaluation["context_precision"] = safe_score(result)

    except Exception as error:
        errors["context_precision"] = str(error)

    # ========================================================
    # 4. HALLUCINATION SCORE
    #
    # Derived from Faithfulness:
    #
    # hallucination_score = 1 - faithfulness
    #
    # Lower is better.
    # ========================================================

    if evaluation["faithfulness"] is not None:
        evaluation["hallucination_score"] = round(
            1.0 - evaluation["faithfulness"],
            4,
        )

    # ========================================================
    # 5. OVERALL SCORE
    #
    # Average of all successfully calculated
    # positive quality metrics.
    #
    # Hallucination score is NOT included because
    # lower hallucination is better, whereas the
    # other metrics use higher = better.
    # ========================================================

    available_scores = [
        evaluation["faithfulness"],
        evaluation["answer_relevancy"],
        evaluation["context_precision"],
    ]

    available_scores = [
        score
        for score in available_scores
        if score is not None
    ]

    if len(available_scores) == 3:
        evaluation["overall_score"] = round(
            sum(available_scores) / len(available_scores),
            4,
        )

    # Include metric-specific errors without
    # crashing the entire evaluation.
    if errors:
        evaluation["errors"] = errors

    return evaluation


async def main():
    try:
        # Node.js sends JSON through stdin
        raw_input = sys.stdin.read()

        if not raw_input.strip():
            raise ValueError(
                "No JSON input received"
            )

        payload = json.loads(raw_input)

        question = payload.get("question")
        answer = payload.get("answer")
        contexts = payload.get(
            "contexts",
            []
        )

        result = await evaluate_live(
            question=question,
            answer=answer,
            contexts=contexts,
        )

        # IMPORTANT:
        # stdout must contain ONLY JSON because
        # backend/index.js parses this output.
        print(
            json.dumps(
                result,
                ensure_ascii=False,
            )
        )

    except Exception as error:
        error_response = {
            "status": "failed",
            "error": str(error),
        }

        print(
            json.dumps(
                error_response,
                ensure_ascii=False,
            )
        )

        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())