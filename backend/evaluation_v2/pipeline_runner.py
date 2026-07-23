from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from .csv_loader import load_csv
from .dataset_builder import generate_dataset
from .progress import reset_progress, set_progress
from .ragas_runner import run_ragas


def run_pipeline(
    csv_path: str | Path,
    *,
    answer_builder: Callable[[dict[str, Any]], str] | None = None,
    reference_builder: Callable[[dict[str, Any]], str] | None = None,
    question_field: str = 'question',
    answer_field: str = 'answer',
    context_field: str | None = None,
    metadata_fields: tuple[str, ...] = (),
) -> dict[str, Any]:
    """A simple end-to-end evaluation pipeline for the new module."""
    reset_progress()
    set_progress(status='running', stage='load_csv', total=0, completed=0, message='Loading CSV input')

    rows = load_csv(csv_path)
    set_progress(status='running', stage='generate_dataset', total=len(rows), completed=0, message='Building evaluation dataset')

    dataset = generate_dataset(
        rows,
        question_field=question_field,
        answer_field=answer_field,
        context_field=context_field,
        metadata_fields=metadata_fields,
    )

    set_progress(status='running', stage='ragas', total=len(dataset), completed=0, message='Running RAGAS evaluation')
    results = run_ragas(
        dataset,
        answer_builder=answer_builder,
        reference_builder=reference_builder,
    )

    set_progress(status='completed', stage='done', total=len(results), completed=len(results), message='Evaluation pipeline complete')
    return {
        'dataset': dataset,
        'results': results,
    }
