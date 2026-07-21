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

from ragas_config import get_ragas_llm_config


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
def sanitize_unicode(value):
    """
    Remove invalid Unicode surrogate characters and ensure
    the text can be safely encoded as UTF-8.
    """
    if value is None:
        return ""

    text = str(value)

    return text.encode(
        "utf-8",
        errors="replace"
    ).decode(
        "utf-8"
    )
async def run_metric_with_fallback(
    metric_class,
    evaluator_providers,
    metric_kwargs=None,
    score_kwargs=None,
):
    """
    Run a RAGAS metric using evaluator providers in order.

    Example:
        Groq -> OpenAI

    If one provider fails because of rate limits,
    quota errors, network errors, or another provider
    error, the next provider is tried automatically.
    """

    metric_kwargs = metric_kwargs or {}
    score_kwargs = score_kwargs or {}

    provider_errors = {}

    for provider_name, evaluator_llm in evaluator_providers:
        try:
            metric = metric_class(
                llm=evaluator_llm,
                **metric_kwargs,
            )

            result = await metric.ascore(
                **score_kwargs,
            )

            return {
                "score": safe_score(result),
                "provider": provider_name,
                "errors": provider_errors,
            }

        except Exception as error:
            provider_errors[provider_name] = str(error)

            print(
                f"[RAGAS] {provider_name} failed. "
                f"Trying next evaluator provider...",
                file=sys.stderr,
            )

    return {
        "score": None,
        "provider": None,
        "errors": provider_errors,
    }
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
    # SANITIZE UNICODE INPUT
    #
    # Some legacy database documents contain malformed
    # Unicode surrogate characters. These cannot be serialized
    # as valid UTF-8 and can cause RAGAS/LLM requests to fail.
    # ========================================================

    question = sanitize_unicode(question)
    answer = sanitize_unicode(answer)

    contexts = [
        sanitize_unicode(context)
        for context in contexts
        if context is not None
    ]

    contexts = [
        context
        for context in contexts
        if context.strip()
    ]

    if not contexts:
        raise ValueError(
            "No valid contexts remain after Unicode sanitization"
        )

    # ========================================================
    # API KEYS
    # ========================================================

    ragas_config = get_ragas_llm_config()
    groq_api_key = ragas_config["api_key"]
    openai_api_key = os.getenv("OPENAI_API_KEY")
    gemini_api_key = os.getenv("GEMINI_API_KEY")

    if not groq_api_key and not openai_api_key:
        raise ValueError(
            "At least one evaluator LLM provider must be configured: "
            "GROQ_API_KEY_RAGAS, GROQ_API_KEY, or OPENAI_API_KEY"
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

    # ========================================================
# EVALUATOR LLM PROVIDERS
#
# Primary: Groq
# Fallback: OpenAI
# ========================================================

    evaluator_providers = []

    if groq_api_key:
        groq_client = AsyncOpenAI(
            api_key=groq_api_key,
            base_url="https://api.groq.com/openai/v1",
        )

        groq_llm = llm_factory(
            ragas_config["model"],
            client=groq_client,
        )

        evaluator_providers.append(
            ("groq", groq_llm)
        )


    if openai_api_key:
        openai_client = AsyncOpenAI(
            api_key=openai_api_key,
        )

        openai_llm = llm_factory(
            "gpt-4.1-mini",
            client=openai_client,
        )

        evaluator_providers.append(
            ("openai", openai_llm)
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
    providers_used = {}
    # ========================================================
    # 1. FAITHFULNESS
    #
    # Measures whether the generated answer is supported
    # by the retrieved contexts.
    # ========================================================

    faithfulness_result = await run_metric_with_fallback(
        metric_class=Faithfulness,
        evaluator_providers=evaluator_providers,
        score_kwargs={
            "user_input": question,
            "response": answer,
            "retrieved_contexts": contexts,
        },
    )

    evaluation["faithfulness"] = (
        faithfulness_result["score"]
    )

    providers_used["faithfulness"] = (
        faithfulness_result["provider"]
    )

    if faithfulness_result["score"] is None:
        errors["faithfulness"] = (
            faithfulness_result["errors"]
        )

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

    answer_relevancy_result = await run_metric_with_fallback(
        metric_class=AnswerRelevancy,
        evaluator_providers=evaluator_providers,
        metric_kwargs={
            "embeddings": evaluator_embeddings,
        },
        score_kwargs={
            "user_input": question,
            "response": answer,
        },
    )

    evaluation["answer_relevancy"] = (
        answer_relevancy_result["score"]
    )

    providers_used["answer_relevancy"] = (
        answer_relevancy_result["provider"]
    )

    if answer_relevancy_result["score"] is None:
        errors["answer_relevancy"] = (
            answer_relevancy_result["errors"]
        )

    # ========================================================
    # 3. CONTEXT PRECISION
    #
    # Measures the quality/relevance of retrieved contexts.
    # This version does not require a golden reference answer.
    # ========================================================

        context_precision_result = await run_metric_with_fallback(
        metric_class=ContextPrecisionWithoutReference,
        evaluator_providers=evaluator_providers,
        score_kwargs={
            "user_input": question,
            "response": answer,
            "retrieved_contexts": contexts,
        },
    )

    evaluation["context_precision"] = (
        context_precision_result["score"]
    )

    providers_used["context_precision"] = (
        context_precision_result["provider"]
    )

    if context_precision_result["score"] is None:
        errors["context_precision"] = (
            context_precision_result["errors"]
        )

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
    evaluation["providers_used"] = providers_used
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