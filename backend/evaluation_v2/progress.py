from __future__ import annotations

from dataclasses import dataclass, field
from threading import Lock
from time import time
from typing import Any


@dataclass
class ProgressState:
    status: str = 'idle'
    stage: str = 'pending'
    total: int = 0
    completed: int = 0
    started_at: float | None = None
    updated_at: float | None = None
    message: str = ''
    details: dict[str, Any] = field(default_factory=dict)

    @property
    def percent(self) -> float:
        if self.total <= 0:
            return 0.0
        return round((self.completed / self.total) * 100, 2)


_progress_lock = Lock()
_progress = ProgressState()


def reset_progress() -> None:
    global _progress
    with _progress_lock:
        _progress = ProgressState()


def set_progress(
    *,
    status: str = 'running',
    stage: str = 'pending',
    total: int = 0,
    completed: int = 0,
    message: str = '',
    details: dict[str, Any] | None = None,
) -> ProgressState:
    global _progress
    timestamp = time()
    with _progress_lock:
        _progress.status = status
        _progress.stage = stage
        _progress.total = max(0, total)
        _progress.completed = max(0, min(completed, _progress.total))
        _progress.started_at = _progress.started_at or timestamp
        _progress.updated_at = timestamp
        _progress.message = message
        _progress.details = details or {}
    return _progress


def update_progress(
    step: int = 1,
    *,
    total: int | None = None,
    completed: int | None = None,
    stage: str | None = None,
    message: str = '',
    details: dict[str, Any] | None = None,
) -> ProgressState:
    global _progress
    with _progress_lock:
        if total is not None:
            _progress.total = max(0, total)
        if completed is not None:
            _progress.completed = max(0, min(completed, _progress.total))
        else:
            _progress.completed = min(_progress.total, _progress.completed + step)
        if stage:
            _progress.stage = stage
        if message:
            _progress.message = message
        if details:
            _progress.details.update(details)
        _progress.updated_at = time()
    return _progress


def get_progress() -> dict[str, Any]:
    with _progress_lock:
        return {
            'status': _progress.status,
            'stage': _progress.stage,
            'total': _progress.total,
            'completed': _progress.completed,
            'percent': _progress.percent,
            'started_at': _progress.started_at,
            'updated_at': _progress.updated_at,
            'message': _progress.message,
            'details': dict(_progress.details),
        }
