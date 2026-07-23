from __future__ import annotations

from typing import Any, Iterable


def generate_dataset(
    rows: Iterable[dict[str, Any]],
    *,
    question_field: str = 'question',
    answer_field: str = 'answer',
    context_field: str | None = None,
    metadata_fields: tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    """Convert raw CSV rows into a normalized evaluation dataset.

    The output structure is intentionally simple and stable so the rest of the
    evaluation module can rely on a predictable schema.
    """
    dataset: list[dict[str, Any]] = []

    for row in rows:
        if not isinstance(row, dict):
            raise TypeError('Each row must be a dictionary-like object.')

        question = row.get(question_field)
        answer = row.get(answer_field)

        if not question or not str(question).strip():
            raise ValueError(f'Missing question value for row: {row}')

        if not answer or not str(answer).strip():
            raise ValueError(f'Missing answer value for row: {row}')

        entry = {
            'question': str(question).strip(),
            'reference_answer': str(answer).strip(),
            'context': str(row.get(context_field) or '').strip() if context_field else '',
            'metadata': {
                key: row.get(key)
                for key in metadata_fields
                if key in row
            },
        }
        dataset.append(entry)

    return dataset
