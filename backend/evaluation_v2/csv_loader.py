from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Iterable


def load_csv(csv_path: str | Path, *, encoding: str = 'utf-8-sig', delimiter: str = ',') -> list[dict[str, Any]]:
    """Load a CSV file into a list of dictionaries.

    Args:
        csv_path: Path to the source CSV file.
        encoding: Text encoding used by the file.
        delimiter: CSV delimiter.

    Returns:
        A list of rows represented as dictionaries.
    """
    path = Path(csv_path)
    if not path.exists():
        raise FileNotFoundError(f'CSV file not found: {path}')

    with path.open('r', encoding=encoding, newline='') as handle:
        reader = csv.DictReader(handle, delimiter=delimiter)
        if reader.fieldnames is None:
            raise ValueError(f'CSV file has no header row: {path}')

        rows: list[dict[str, Any]] = []
        for row in reader:
            cleaned = {}
            for key, value in row.items():
                cleaned[key] = value.strip() if isinstance(value, str) else value
            rows.append(cleaned)

    return rows
