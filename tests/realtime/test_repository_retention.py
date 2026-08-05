from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
import sqlite3

import pytest

from wordless.realtime.repository import RealtimeRepository, RepositoryError


def _seed(path: Path, *, tenant: str, key: str, status: str, timestamp: datetime) -> str:
    suggestion_id = f"sg_{key:0<32}"[:35]
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(
            """
            INSERT INTO suggestions (
                tenant_id, idempotency_key, request_sha256, suggestion_id,
                status, created_at, completed_at, interaction_json, result_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant,
                f"idempotency-{key}",
                key * 64,
                suggestion_id,
                status,
                timestamp.isoformat(),
                timestamp.isoformat() if status == "completed" else None,
                "{}" if status == "completed" else None,
                "{}" if status == "completed" else None,
            ),
        )
        if status == "completed":
            connection.execute(
                "INSERT INTO suggestion_events VALUES (?, ?, 1, '{}')",
                (tenant, suggestion_id),
            )
            connection.execute(
                "INSERT INTO feedback VALUES (?, ?, ?, ?, '{}', '{}', ?)",
                (
                    tenant,
                    suggestion_id,
                    f"feedback-{key}",
                    key * 64,
                    timestamp.isoformat(),
                ),
            )
        connection.commit()
    finally:
        connection.close()
    return suggestion_id


def test_cleanup_is_tenant_scoped_and_cascades_children(tmp_path: Path) -> None:
    path = tmp_path / "realtime.sqlite3"
    repository = RealtimeRepository(path)
    now = datetime(2026, 7, 30, 20, 0, tzinfo=UTC)
    alpha_old = _seed(path, tenant="alpha", key="a", status="completed", timestamp=now - timedelta(days=31))
    alpha_recent = _seed(path, tenant="alpha", key="b", status="completed", timestamp=now - timedelta(days=2))
    beta_old = _seed(path, tenant="beta", key="c", status="completed", timestamp=now - timedelta(days=31))
    _seed(path, tenant="alpha", key="d", status="processing", timestamp=now - timedelta(days=31))

    result = repository.cleanup(retention_before=now - timedelta(days=30), tenant_id="alpha")

    assert result.completed == 1
    assert result.processing == 1
    connection = sqlite3.connect(path)
    try:
        assert connection.execute(
            "SELECT suggestion_id FROM suggestions ORDER BY suggestion_id"
        ).fetchall() == [(alpha_recent,), (beta_old,)]
        assert connection.execute(
            "SELECT COUNT(*) FROM suggestion_events WHERE suggestion_id = ?", (alpha_old,)
        ).fetchone() == (0,)
        assert connection.execute(
            "SELECT COUNT(*) FROM feedback WHERE suggestion_id = ?", (alpha_old,)
        ).fetchone() == (0,)
    finally:
        connection.close()
    assert repository.healthcheck() is True

    global_result = repository.cleanup(retention_before=now - timedelta(days=30))
    assert global_result.completed == 1
    repository.compact()


def test_cleanup_rejects_ambiguous_scope_or_cutoff(tmp_path: Path) -> None:
    repository = RealtimeRepository(tmp_path / "realtime.sqlite3")
    with pytest.raises(ValueError, match="timezone"):
        repository.cleanup(retention_before=datetime(2026, 7, 30))
    with pytest.raises(ValueError, match="tenant_id"):
        repository.cleanup(
            retention_before=datetime(2026, 7, 30, tzinfo=UTC),
            tenant_id=" alpha ",
        )


def test_compaction_fails_closed_when_wal_checkpoint_is_busy(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = RealtimeRepository(tmp_path / "realtime.sqlite3")

    class _BusyCheckpoint:
        def __init__(self) -> None:
            self.commands: list[str] = []
            self.closed = False

        def execute(self, command: str) -> object:
            self.commands.append(command)

            class _Result:
                @staticmethod
                def fetchone() -> tuple[int, int, int]:
                    return (1, 2, 1)

            return _Result()

        def close(self) -> None:
            self.closed = True

    connection = _BusyCheckpoint()
    monkeypatch.setattr(repository, "_connect", lambda: connection)

    with pytest.raises(RepositoryError, match="exclusive maintenance window"):
        repository.compact()

    assert connection.commands == ["PRAGMA wal_checkpoint(TRUNCATE)"]
    assert connection.closed is True
