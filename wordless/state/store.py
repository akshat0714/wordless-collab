"""One-file-per-corpus DuckDB persistence with a strict redaction boundary."""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from typing import TYPE_CHECKING, Any

import duckdb

from wordless.core.models import Interaction
from wordless.core.redact import RedactionReport, Redactor

if TYPE_CHECKING:
    from duckdb import DuckDBPyConnection

    from wordless.ingest.base import Adapter


class StoreError(ValueError):
    """Raised when a corpus store would violate a persistence invariant."""


class UnredactedInteractionError(StoreError):
    """Raised when an interaction bypassed the ingest redaction boundary."""


_SAFE_CORPUS_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_SCHEMA_VERSION = 1


class CorpusStore:
    """Local analytical store backed by exactly one DuckDB file.

    The store has no network address, credentials, migration service, or
    customer-system client.  Removing its one ``.duckdb`` file removes the
    corpus.  A salt is never accepted by this API and therefore cannot be
    persisted accidentally.
    """

    def __init__(
        self,
        database_path: Path | str,
        corpus_id: str | None = None,
        *,
        redactor: Redactor | None = None,
    ) -> None:
        if corpus_id is not None:
            if not _SAFE_CORPUS_ID.fullmatch(corpus_id):
                raise StoreError(
                    "corpus_id must contain only letters, numbers, dots, underscores, or hyphens"
                )
            database_path = Path(database_path) / f"{corpus_id}.duckdb"
        self.path = Path(database_path).expanduser().resolve()
        if self.path.suffix.casefold() not in {".duckdb", ".db"}:
            raise StoreError("Corpus database path must end in .duckdb or .db")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if redactor is not None and type(redactor) is not Redactor:
            raise TypeError("redactor must be a concrete Redactor instance")
        if redactor is not None and not redactor.boundary_safe:
            raise ValueError("redactor must keep mandatory Presidio policy enabled")
        self._redactor = redactor or Redactor()
        if not self._redactor.boundary_safe:
            raise ValueError(
                "store requires the available mandatory pinned Presidio policy"
            )
        self._initialize()

    @classmethod
    def for_corpus(
        cls,
        workspace: Path | str,
        corpus_id: str,
        *,
        redactor: Redactor | None = None,
    ) -> "CorpusStore":
        return cls(workspace, corpus_id, redactor=redactor)

    @property
    def database_path(self) -> Path:
        return self.path

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS corpus_metadata (
                    key VARCHAR PRIMARY KEY,
                    value VARCHAR NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS interactions (
                    id VARCHAR PRIMARY KEY,
                    customer_key VARCHAR NOT NULL,
                    opened_at TIMESTAMPTZ NOT NULL,
                    channel VARCHAR NOT NULL,
                    messages JSON NOT NULL,
                    state_snapshot JSON NOT NULL,
                    resolution JSON,
                    source_system VARCHAR NOT NULL,
                    metadata JSON NOT NULL,
                    canonical_json JSON NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS redaction_report (
                    entity_type VARCHAR PRIMARY KEY,
                    count UBIGINT NOT NULL
                )
                """
            )
            connection.execute(
                """
                INSERT INTO corpus_metadata VALUES ('schema_version', ?)
                ON CONFLICT (key) DO UPDATE SET value = excluded.value
                """,
                [str(_SCHEMA_VERSION)],
            )

    @contextmanager
    def _connection(self) -> Iterator["DuckDBPyConnection"]:
        connection = duckdb.connect(str(self.path))
        try:
            yield connection
        finally:
            connection.close()

    def write(
        self,
        interactions: Iterable[Interaction],
        *,
        redaction_report: RedactionReport | None = None,
        batch_size: int = 500,
    ) -> int:
        """Transactionally stream interactions into the corpus store."""

        return self._write(
            interactions,
            redaction_report=redaction_report,
            batch_size=batch_size,
            validation_redactor=self._redactor,
        )

    def _write(
        self,
        interactions: Iterable[Interaction],
        *,
        redaction_report: RedactionReport | None,
        batch_size: int,
        validation_redactor: Redactor,
    ) -> int:
        if type(validation_redactor) is not Redactor:
            raise TypeError("validation_redactor must be a concrete Redactor instance")
        if not validation_redactor.boundary_safe:
            raise ValueError(
                "validation_redactor must keep mandatory Presidio policy enabled"
            )
        if batch_size < 1:
            raise StoreError("batch_size must be at least 1")
        written = 0
        extra_report = RedactionReport()
        with self._connection() as connection:
            connection.execute("BEGIN TRANSACTION")
            try:
                batch: list[tuple[Any, ...]] = []
                for interaction in interactions:
                    persistable, report = self._persistable(interaction, validation_redactor)
                    merged = extra_report.merge(report)
                    if merged is not None:
                        extra_report = merged
                    batch.append(_row(persistable))
                    if len(batch) >= batch_size:
                        self._insert_batch(connection, batch)
                        written += len(batch)
                        batch.clear()
                if batch:
                    self._insert_batch(connection, batch)
                    written += len(batch)
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

        combined = deepcopy(redaction_report) if redaction_report is not None else RedactionReport()
        # A defense-in-depth pass necessarily re-processes every message.  Do
        # not double the adapter's processed counters; only add newly detected
        # entity counts from content that somehow bypassed that first pass.
        extra_findings = RedactionReport(
            entity_counts=extra_report.entity_counts,
            detectors=extra_report.detectors,
        )
        merged = combined.merge(extra_findings)
        if merged is not None:
            combined = merged
        if redaction_report is not None or bool(extra_report.entity_counts):
            self.write_redaction_report(combined)
        return written

    append = write

    def ingest(self, adapter: "Adapter", export_path: Path | str, *, batch_size: int = 500) -> int:
        """Consume an adapter stream and persist its finalized redaction report."""

        written = self._write(
            adapter.load(Path(export_path)),
            redaction_report=None,
            batch_size=batch_size,
            validation_redactor=adapter.redactor,
        )
        self.write_redaction_report(adapter.redaction_report)
        return written

    @staticmethod
    def _persistable(
        interaction: Interaction,
        redactor: Redactor,
    ) -> tuple[Interaction, RedactionReport]:
        # Reconstruct existing models from primitive data as well as validating
        # mappings.  This catches in-place mutation of nested state or a caller
        # that bypassed assignment validation before anything is persisted.
        candidate = (
            interaction.model_dump(mode="python", round_trip=True)
            if isinstance(interaction, Interaction)
            else interaction
        )
        interaction = Interaction.model_validate(candidate)
        if any(not message.redacted for message in interaction.messages):
            raise UnredactedInteractionError(
                f"Interaction {interaction.id!r} contains an unredacted message"
            )
        # Defense in depth for resolution/state/metadata strings.  The adapter
        # normally makes this a no-op; it guarantees no alternate caller can
        # persist PII merely by setting Message.redacted=True.
        sanitized, report = redactor.redact_interaction(interaction)
        sanitized = Interaction.model_validate(
            sanitized.model_dump(mode="python", round_trip=True)
        )
        if any(not message.redacted for message in sanitized.messages):
            raise UnredactedInteractionError("Redactor failed to mark every message redacted")
        return sanitized, report

    @staticmethod
    def _insert_batch(connection: "DuckDBPyConnection", batch: list[tuple[Any, ...]]) -> None:
        connection.executemany(
            """
            INSERT INTO interactions (
                id, customer_key, opened_at, channel, messages, state_snapshot,
                resolution, source_system, metadata, canonical_json
            ) VALUES (?, ?, ?, ?, ?::JSON, ?::JSON, ?::JSON, ?, ?::JSON, ?::JSON)
            ON CONFLICT (id) DO UPDATE SET
                customer_key = excluded.customer_key,
                opened_at = excluded.opened_at,
                channel = excluded.channel,
                messages = excluded.messages,
                state_snapshot = excluded.state_snapshot,
                resolution = excluded.resolution,
                source_system = excluded.source_system,
                metadata = excluded.metadata,
                canonical_json = excluded.canonical_json
            """,
            batch,
        )

    def iter_interactions(self, *, batch_size: int = 500) -> Iterator[Interaction]:
        if batch_size < 1:
            raise StoreError("batch_size must be at least 1")
        with self._connection() as connection:
            cursor = connection.execute(
                "SELECT canonical_json FROM interactions ORDER BY opened_at, id"
            )
            while rows := cursor.fetchmany(batch_size):
                for (payload,) in rows:
                    if not isinstance(payload, str):
                        payload = json.dumps(payload)
                    yield Interaction.model_validate_json(payload)

    def get(self, interaction_id: str) -> Interaction | None:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT canonical_json FROM interactions WHERE id = ?", [interaction_id]
            ).fetchone()
        if row is None:
            return None
        payload = row[0] if isinstance(row[0], str) else json.dumps(row[0])
        return Interaction.model_validate_json(payload)

    def count(self) -> int:
        with self._connection() as connection:
            return int(connection.execute("SELECT count(*) FROM interactions").fetchone()[0])

    def write_redaction_report(self, report: RedactionReport) -> None:
        counts = Counter(report.entity_counts)
        counts["__messages_processed__"] = int(report.messages_processed)
        counts["__messages_changed__"] = int(report.messages_changed)
        counts["__text_values_processed__"] = int(report.text_values_processed)
        counts["__text_values_changed__"] = int(report.text_values_changed)
        with self._connection() as connection:
            connection.execute("BEGIN TRANSACTION")
            try:
                connection.execute("DELETE FROM redaction_report")
                connection.executemany(
                    "INSERT INTO redaction_report VALUES (?, ?)",
                    [(key, counts[key]) for key in sorted(counts)],
                )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def redaction_counts(self) -> dict[str, int]:
        """Return entity counts only; summary counters are exposed separately."""

        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT entity_type, count FROM redaction_report
                WHERE entity_type NOT LIKE '\\_\\_%' ESCAPE '\\'
                ORDER BY entity_type
                """
            ).fetchall()
        return {str(entity): int(count) for entity, count in rows}

    def redaction_summary(self) -> dict[str, int]:
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT entity_type, count FROM redaction_report
                WHERE entity_type LIKE '\\_\\_%' ESCAPE '\\'
                ORDER BY entity_type
                """
            ).fetchall()
        return {str(entity).removeprefix("__").removesuffix("__"): int(count) for entity, count in rows}

    def read_redaction_report(self) -> RedactionReport:
        counts = self.redaction_counts()
        summary = self.redaction_summary()
        return RedactionReport(
            entity_counts=counts,
            messages_processed=summary.get("messages_processed", 0),
            messages_changed=summary.get("messages_changed", 0),
            text_values_processed=summary.get("text_values_processed", 0),
            text_values_changed=summary.get("text_values_changed", 0),
        )


def _row(interaction: Interaction) -> tuple[Any, ...]:
    payload = interaction.model_dump(mode="json")
    canonical = _json(payload)
    return (
        interaction.id,
        interaction.customer_key,
        interaction.opened_at,
        interaction.channel,
        _json(payload["messages"]),
        _json(payload["state_snapshot"]),
        _json(payload["resolution"]) if payload["resolution"] is not None else None,
        interaction.source_system,
        _json(payload["metadata"]),
        canonical,
    )


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
