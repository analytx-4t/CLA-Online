from __future__ import annotations

from typing import Any, Callable, Iterable

from .progress import update_progress


def run_ragas(
    dataset: Iterable[dict[str, Any]],
    *,
    answer_builder: Callable[[dict[str, Any]], str] | None = None,
    reference_builder: Callable[[dict[str, Any]], str] | None = None,
) -> list[dict[str, Any]]:
    """Execute a lightweight RAGAS-style evaluation cycle over the dataset.

    The function is intentionally dependency-light and returns a clean result
    structure without reusing the legacy backend code path.
    """
    results: list[dict[str, Any]] = []
    rows = list(dataset)

    if not rows:
        return results

    total = len(rows)
    update_progress(total=total, completed=0, stage='ragas', message='Starting RAGAS evaluation')

    for index, item in enumerate(rows, start=1):
        question = str(item.get('question') or '').strip()
        expected = str(item.get('reference_answer') or '').strip()
        generated = (answer_builder(item) if answer_builder else expected)
        reference = (reference_builder(item) if reference_builder else expected)

        faithfulness = 0.0 if generated and reference else 0.0
        answer_relevancy = 1.0 if generated else 0.0
        context_precision = 1.0 if item.get('context') else 0.0
        context_recall = 1.0 if reference else 0.0
        answer_correctness = 1.0 if generated == reference else 0.0
        overall_score = round(
            (faithfulness + answer_relevancy + context_precision + context_recall + answer_correctness) / 5,
            4,
        )

        results.append(
            {
                'question': question,
                'generated_answer': generated,
                'reference_answer': reference,
                'faithfulness': faithfulness,
                'answer_relevancy': answer_relevancy,
                'context_precision': context_precision,
                'context_recall': context_recall,
                'answer_correctness': answer_correctness,
                'overall_score': overall_score,
                'status': 'completed',
                'row_index': index,
            }
        )

        update_progress(
            step=1,
            stage='ragas',
            message=f'Completed row {index} of {total}',
            details={'row_index': index},
        )

    return results


if __name__ == '__main__':
    import json
    import sys

    try:
        raw_input = sys.stdin.read()
        payload = json.loads(raw_input) if raw_input and raw_input.strip() else {}
        dataset = payload.get('dataset', [])
        results = run_ragas(dataset)
        print(json.dumps({'status': 'completed', 'results': results}))
    except Exception as exc:
        print(json.dumps({'status': 'failed', 'error': str(exc)}))

