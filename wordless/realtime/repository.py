"""Tenant-scoped transactional persistence for real-time suggestions."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import secrets
import sqlite3
from threading import RLock

from wordless.core.models import Interaction

from .contracts import (
    FeedbackRequest,
    FeedbackResponse,
    SuggestionEvent,
    SuggestionResponse,
)


class RepositoryError(RuntimeError):
    pass


class IdempotencyConflict(RepositoryError):
    pass


class SuggestionInProgress(RepositoryError):
    pass


class SuggestionNotFound(RepositoryError):
    pass


class FeedbackConflict(RepositoryError):
    pass


@dataclass(frozen=True)
class Reservation:
    suggestion_id: str
    created: bool
    completed_result: SuggestionResponse | None = None


@dataclass(frozen=True)
class CleanupResult:
    completed: int
    processing: int


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _json(value: object) -> str:
    if isinstance(value, SuggestionResponse | SuggestionEvent | FeedbackResponse):
        payload = value.model_dump(mode="json")
    else:
        payload = value
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


class RealtimeRepository:
    """Single-node pilot repository with explicit tenant keys and WAL durability.

    The public API never uses the analytical DuckDB store.  This SQLite
    implementation is suitable for a local or single-instance pilot. A scaled
    multi-instance deployment requires a separately implemented transactional
    backend (for example, PostgreSQL with RLS); no such adapter is included.
    """

    def __init__(self, path: Path | str, *, pending_timeout_seconds: int = 300) -> None:
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.pending_timeout = timedelta(seconds=pending_timeout_seconds)
        self._lock = RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        # Overwrite deleted payload bytes instead of leaving them in free pages.
        connection.execute("PRAGMA secure_delete = ON")
        return connection

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        """Commit or roll back a unit of work and always close its handle."""

        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = FULL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS realtime_schema (
                    version INTEGER PRIMARY KEY
                );
                INSERT OR IGNORE INTO realtime_schema(version) VALUES (1);

                CREATE TABLE IF NOT EXISTS suggestions (
                    tenant_id TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    request_sha256 TEXT NOT NULL,
                    suggestion_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('processing', 'completed')),
                    created_at TEXT NOT NULL,
                    completed_at TEXT,
                    interaction_json TEXT,
                    result_json TEXT,
                    PRIMARY KEY (tenant_id, idempotency_key),
                    UNIQUE (tenant_id, suggestion_id)
                );

                CREATE TABLE IF NOT EXISTS suggestion_events (
                    tenant_id TEXT NOT NULL,
                    suggestion_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    event_json TEXT NOT NULL,
                    PRIMARY KEY (tenant_id, suggestion_id, sequence),
                    FOREIGN KEY (tenant_id, suggestion_id)
                        REFERENCES suggestions(tenant_id, suggestion_id)
                        ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS feedback (
                    tenant_id TEXT NOT NULL,
                    suggestion_id TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    request_sha256 TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (tenant_id, suggestion_id),
                    UNIQUE (tenant_id, idempotency_key),
                    FOREIGN KEY (tenant_id, suggestion_id)
                        REFERENCES suggestions(tenant_id, suggestion_id)
                        ON DELETE CASCADE
                );
                """
            )

    def healthcheck(self) -> bool:
        try:
            with self._connection() as connection:
                row = connection.execute("SELECT version FROM realtime_schema").fetchone()
                secure_delete = connection.execute("PRAGMA secure_delete").fetchone()
            return (
                row is not None
                and int(row[0]) == 1
                and secure_delete is not None
                and int(secure_delete[0]) == 1
            )
        except (OSError, sqlite3.Error, TypeError, ValueError):
            return False

    def cleanup(
        self,
        *,
        retention_before: datetime,
        tenant_id: str | None = None,
    ) -> CleanupResult:
        """Delete expired tenant records transactionally; children cascade."""

        if retention_before.tzinfo is None or retention_before.utcoffset() is None:
            raise ValueError("retention_before must include a timezone")
        if tenant_id is not None and (not tenant_id or tenant_id != tenant_id.strip()):
            raise ValueError("tenant_id must be a non-empty trimmed string")
        cutoff = retention_before.astimezone(timezone.utc).isoformat()
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                """
                SELECT status, COUNT(*) AS count
                FROM suggestions
                WHERE (? IS NULL OR tenant_id = ?)
                  AND ((status = 'completed' AND completed_at < ?)
                    OR (status = 'processing' AND created_at < ?))
                GROUP BY status
                """,
                (tenant_id, tenant_id, cutoff, cutoff),
            ).fetchall()
            counts = {str(row["status"]): int(row["count"]) for row in rows}
            connection.execute(
                """
                DELETE FROM suggestions
                WHERE (? IS NULL OR tenant_id = ?)
                  AND ((status = 'completed' AND completed_at < ?)
                    OR (status = 'processing' AND created_at < ?))
                """,
                (tenant_id, tenant_id, cutoff, cutoff),
            )
        # Deleted rows must also leave the WAL; secure_delete covers freed
        # database pages and a successful truncate checkpoint covers old frames.
        with self._lock:
            checkpoint = self._connect()
            try:
                status = checkpoint.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            finally:
                checkpoint.close()
        if status is None or int(status[0]) != 0:
            raise RepositoryError("retention WAL checkpoint could not complete")
        return CleanupResult(
            completed=counts.get("completed", 0),
            processing=counts.get("processing", 0),
        )

    def compact(self) -> None:
        """Reclaim free pages during an explicit operator maintenance window."""

        with self._lock:
            connection = self._connect()
            try:
                self._checkpoint_for_compaction(connection)
                connection.execute("VACUUM")
                self._checkpoint_for_compaction(connection)
            finally:
                connection.close()

    @staticmethod
    def _checkpoint_for_compaction(connection: sqlite3.Connection) -> None:
        """Fail closed when another process prevents a complete WAL checkpoint."""

        row = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        try:
            busy = int(row[0]) if row is not None else 1
        except (IndexError, TypeError, ValueError):
            busy = 1
        if busy != 0:
            raise RepositoryError(
                "SQLite compaction requires an exclusive maintenance window"
            )

    def reserve(
        self,
        *,
        tenant_id: str,
        idempotency_key: str,
        request_sha256: str,
        now: datetime | None = None,
    ) -> Reservation:
        current = now or _utc_now()
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT request_sha256, suggestion_id, status, created_at, result_json
                FROM suggestions
                WHERE tenant_id = ? AND idempotency_key = ?
                """,
                (tenant_id, idempotency_key),
            ).fetchone()
            if row is not None:
                if row["request_sha256"] != request_sha256:
                    raise IdempotencyConflict(
                        "the idempotency key was already used with different content"
                    )
                if row["status"] == "completed":
                    if not isinstance(row["result_json"], str):
                        raise RepositoryError("completed suggestion is missing its result")
                    return Reservation(
                        suggestion_id=str(row["suggestion_id"]),
                        created=False,
                        completed_result=SuggestionResponse.model_validate_json(
                            row["result_json"],
                            strict=True,
                        ),
                    )
                created_at = datetime.fromisoformat(str(row["created_at"]))
                if current - created_at <= self.pending_timeout:
                    raise SuggestionInProgress("the matching suggestion is still processing")
                connection.execute(
                    """
                    UPDATE suggestions SET created_at = ?
                    WHERE tenant_id = ? AND idempotency_key = ?
                    """,
                    (current.isoformat(), tenant_id, idempotency_key),
                )
                return Reservation(
                    suggestion_id=str(row["suggestion_id"]),
                    created=True,
                )
            suggestion_id = f"sg_{secrets.token_hex(16)}"
            connection.execute(
                """
                INSERT INTO suggestions (
                    tenant_id, idempotency_key, request_sha256, suggestion_id,
                    status, created_at
                ) VALUES (?, ?, ?, ?, 'processing', ?)
                """,
                (
                    tenant_id,
                    idempotency_key,
                    request_sha256,
                    suggestion_id,
                    current.isoformat(),
                ),
            )
            return Reservation(suggestion_id=suggestion_id, created=True)

    def complete(
        self,
        *,
        tenant_id: str,
        suggestion_id: str,
        interaction_json: str,
        result: SuggestionResponse,
        events: tuple[SuggestionEvent, ...],
        now: datetime | None = None,
    ) -> None:
        if result.suggestion_id != suggestion_id:
            raise RepositoryError("result suggestion_id does not match its reservation")
        canonical = Interaction.model_validate_json(interaction_json)
        if any(not message.redacted for message in canonical.messages):
            raise RepositoryError("only redacted interactions may be persisted")
        interaction_json = canonical.model_dump_json()
        if not events:
            raise RepositoryError("a completed suggestion requires durable events")
        if [event.sequence for event in events] != list(range(1, len(events) + 1)):
            raise RepositoryError("suggestion event sequences must be contiguous from one")
        if any(event.suggestion_id != suggestion_id for event in events):
            raise RepositoryError("suggestion events must match their reservation")
        terminal = [
            event
            for event in events
            if event.type in {"suggestion.completed", "suggestion.failed"}
        ]
        if len(terminal) != 1 or terminal[0] is not events[-1]:
            raise RepositoryError("suggestion events require exactly one final terminal event")
        if terminal[0].type != "suggestion.completed":
            raise RepositoryError("a completed result requires a completed terminal event")
        completed_at = (now or _utc_now()).isoformat()
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                """
                UPDATE suggestions
                SET status = 'completed', completed_at = ?, interaction_json = ?,
                    result_json = ?
                WHERE tenant_id = ? AND suggestion_id = ? AND status = 'processing'
                """,
                (
                    completed_at,
                    interaction_json,
                    _json(result),
                    tenant_id,
                    suggestion_id,
                ),
            )
            if cursor.rowcount != 1:
                raise RepositoryError("suggestion reservation is missing or already completed")
            connection.executemany(
                """
                INSERT INTO suggestion_events (
                    tenant_id, suggestion_id, sequence, event_json
                ) VALUES (?, ?, ?, ?)
                """,
                [
                    (tenant_id, suggestion_id, event.sequence, _json(event))
                    for event in events
                ],
            )

    def abandon(self, *, tenant_id: str, suggestion_id: str) -> None:
        with self._lock, self._connection() as connection:
            connection.execute(
                """
                DELETE FROM suggestions
                WHERE tenant_id = ? AND suggestion_id = ? AND status = 'processing'
                """,
                (tenant_id, suggestion_id),
            )

    def get_result(self, *, tenant_id: str, suggestion_id: str) -> SuggestionResponse:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT status, result_json FROM suggestions
                WHERE tenant_id = ? AND suggestion_id = ?
                """,
                (tenant_id, suggestion_id),
            ).fetchone()
        if row is None or row["status"] != "completed" or not isinstance(row["result_json"], str):
            raise SuggestionNotFound("suggestion was not found")
        return SuggestionResponse.model_validate_json(row["result_json"], strict=True)

    def get_events(
        self,
        *,
        tenant_id: str,
        suggestion_id: str,
        after_sequence: int = 0,
    ) -> tuple[SuggestionEvent, ...]:
        self.get_result(tenant_id=tenant_id, suggestion_id=suggestion_id)
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT event_json FROM suggestion_events
                WHERE tenant_id = ? AND suggestion_id = ? AND sequence > ?
                ORDER BY sequence
                """,
                (tenant_id, suggestion_id, after_sequence),
            ).fetchall()
        return tuple(
            SuggestionEvent.model_validate_json(row["event_json"], strict=True)
            for row in rows
        )

    def record_feedback(
        self,
        *,
        tenant_id: str,
        suggestion_id: str,
        idempotency_key: str,
        request_sha256: str,
        feedback: FeedbackRequest,
        now: datetime | None = None,
    ) -> FeedbackResponse:
        suggestion = self.get_result(
            tenant_id=tenant_id,
            suggestion_id=suggestion_id,
        )
        valid_detectors = {item.detector_id for item in suggestion.candidates}
        if (
            feedback.selected_detector_id is not None
            and feedback.selected_detector_id not in valid_detectors
        ):
            raise FeedbackConflict("selected detector was not offered by this suggestion")
        request_json = _json(feedback.model_dump(mode="json"))
        current = now or _utc_now()
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            idempotent = connection.execute(
                """
                SELECT suggestion_id, request_sha256, response_json FROM feedback
                WHERE tenant_id = ? AND idempotency_key = ?
                """,
                (tenant_id, idempotency_key),
            ).fetchone()
            if idempotent is not None:
                if (
                    idempotent["suggestion_id"] != suggestion_id
                    or idempotent["request_sha256"] != request_sha256
                ):
                    raise IdempotencyConflict(
                        "the idempotency key was already used for a different request"
                    )
                return FeedbackResponse.model_validate_json(
                    idempotent["response_json"],
                    strict=True,
                )
            existing = connection.execute(
                """
                SELECT request_json, response_json FROM feedback
                WHERE tenant_id = ? AND suggestion_id = ?
                """,
                (tenant_id, suggestion_id),
            ).fetchone()
            if existing is not None:
                if existing["request_json"] != request_json:
                    raise FeedbackConflict("feedback was already recorded for this suggestion")
                return FeedbackResponse.model_validate_json(
                    existing["response_json"],
                    strict=True,
                )
            response = FeedbackResponse(
                feedback_id=f"fb_{secrets.token_hex(16)}",
                suggestion_id=suggestion_id,
                outcome=feedback.outcome,
                selected_detector_id=feedback.selected_detector_id,
                actor=feedback.actor,
                recorded_at=current,
            )
            connection.execute(
                """
                INSERT INTO feedback (
                    tenant_id, suggestion_id, idempotency_key, request_sha256,
                    request_json, response_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tenant_id,
                    suggestion_id,
                    idempotency_key,
                    request_sha256,
                    request_json,
                    _json(response),
                    current.isoformat(),
                ),
            )
            return response


__all__ = [
    "CleanupResult",
    "FeedbackConflict",
    "IdempotencyConflict",
    "RealtimeRepository",
    "RepositoryError",
    "Reservation",
    "SuggestionInProgress",
    "SuggestionNotFound",
]
