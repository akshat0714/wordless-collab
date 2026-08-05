"""Read-only adapter for the pinned Mendeley Help Desk Tickets v2 fixture.

This is intentionally not a general customer adapter.  The public fixture is
small and fixed (360 issues), so its utterances may be grouped in memory while
``issues.csv`` is still scanned and interactions are yielded one at a time.
No raw or partially redacted intermediate is ever written to disk.
"""

from __future__ import annotations

import csv
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar

from wordless.core.models import Interaction
from wordless.core.redact import Redactor

from .base import Adapter, AdapterError, clean_scalar, parse_datetime


ISSUES_FILENAME = "issues.csv"
UTTERANCES_FILENAME = "sample_utterances.csv"

_ROLE_MAP = {
    "reporter": "customer",
    "assignee": "agent",
    "others": "system",
}
_RESOLUTION_CODES = {
    "Cannot Reproduce": "cannot_reproduce",
    "Done": "done",
    "Duplicate": "duplicate",
    "Won't Do": "wont_do",
}
@dataclass
class _CommentGroup:
    issue_id: str
    comment_id: str
    comment_sequence: int
    author_role: str
    earliest_created: Any
    source_row: int
    utterances: list[tuple[int, int, str]] = field(default_factory=list)

    def add(self, row: Mapping[str, str], *, row_number: int) -> None:
        role = clean_scalar(row.get("author_role")).casefold()
        if role != self.author_role:
            raise AdapterError(
                f"Utterance row {row_number} changes author_role within comment "
                f"{self.comment_id!r}"
            )
        created = parse_datetime(row.get("created"), field="sample_utterances.created")
        if created < self.earliest_created:
            self.earliest_created = created
        self.utterances.append(
            (
                _integer(row.get("utr_seq"), field="utr_seq", row_number=row_number),
                row_number,
                clean_scalar(row.get("actionbody")),
            )
        )

    def message(self) -> dict[str, Any]:
        text = " ".join(
            fragment.strip()
            for _, _, fragment in sorted(self.utterances)
            if fragment.strip()
        )
        return {
            "author": _ROLE_MAP.get(self.author_role, "system"),
            "sent_at": self.earliest_created,
            "text": text,
            "redacted": False,
        }


class MendeleyPublicAdapter(Adapter):
    """Normalize the downloader's pinned two-file public replay fixture."""

    source_system: ClassVar[str] = "mendeley_helpdesk_v2"

    def __init__(
        self,
        corpus_salt: str | bytes | None = None,
        *,
        salt: str | bytes | None = None,
        redactor: Redactor | None = None,
    ) -> None:
        # The publisher has already masked this public fixture, but the
        # ordinary production Presidio+regex policy remains mandatory.  Even
        # known categorical labels are not installed as prose allowlists.
        super().__init__(
            corpus_salt=corpus_salt,
            salt=salt,
            redactor=redactor,
        )

    def detect(self, path: Path) -> bool:
        directory = _fixture_directory(Path(path))
        return (directory / ISSUES_FILENAME).is_file() and (
            directory / UTTERANCES_FILENAME
        ).is_file()

    def load(self, path: Path) -> Iterator[Interaction]:
        directory = _fixture_directory(Path(path))
        issues_path = directory / ISSUES_FILENAME
        utterances_path = directory / UTTERANCES_FILENAME
        if not issues_path.is_file() or not utterances_path.is_file():
            raise AdapterError(
                f"Mendeley public fixture requires {ISSUES_FILENAME} and "
                f"{UTTERANCES_FILENAME} in {directory}"
            )

        comments_by_issue = _load_comment_groups(utterances_path)
        found: set[str] = set()
        with issues_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            _require_columns(
                reader.fieldnames,
                {
                    "id",
                    "issue_reporter",
                    "issue_created",
                    "issue_resolution_date",
                    "issue_resolution",
                    "issue_status",
                },
                filename=ISSUES_FILENAME,
            )
            for row_number, issue in enumerate(reader, start=2):
                issue_id = clean_scalar(issue.get("id"))
                comments = comments_by_issue.get(issue_id)
                if comments is None:
                    continue
                if issue_id in found:
                    raise AdapterError(
                        f"Duplicate issue ID {issue_id!r} in {ISSUES_FILENAME} at row {row_number}"
                    )
                found.add(issue_id)
                yield self._normalize_issue(issue, comments)

        missing = sorted(set(comments_by_issue) - found)
        if missing:
            preview = ", ".join(missing[:5])
            raise AdapterError(
                f"{len(missing)} sampled issue IDs were absent from {ISSUES_FILENAME}: {preview}"
            )

    def _normalize_issue(
        self,
        issue: Mapping[str, str],
        comments: list[_CommentGroup],
    ) -> Interaction:
        ordered_comments = sorted(
            comments,
            key=lambda item: (
                item.earliest_created,
                item.comment_sequence,
                item.comment_id,
                item.source_row,
            ),
        )
        messages = [comment.message() for comment in ordered_comments]
        issue_created = parse_datetime(issue.get("issue_created"), field="issue_created")
        opened_at = min(
            [issue_created, *(comment.earliest_created for comment in ordered_comments)]
        )

        final_agent_text = next(
            (
                message["text"]
                for message in reversed(messages)
                if message["author"] == "agent"
            ),
            "",
        )
        resolution_date = clean_scalar(issue.get("issue_resolution_date"))
        raw_resolution_label = clean_scalar(issue.get("issue_resolution"))
        resolution_code = _RESOLUTION_CODES.get(raw_resolution_label)
        resolution = None
        if resolution_date:
            status = clean_scalar(issue.get("issue_status"))
            resolution = {
                "resolved_at": parse_datetime(
                    resolution_date, field="issue_resolution_date"
                ),
                # The publisher's four-value enum is normalized to a closed,
                # lowercase schema code.  No prose allowlist is installed.
                "original_label": resolution_code,
                "actions": [status] if status else [],
                "closing_text": final_agent_text,
            }

        metadata = {
            "dataset_version": 2,
            "issue_num": clean_scalar(issue.get("issue_num")) or None,
            "issue_type": clean_scalar(issue.get("issue_type")) or None,
            "issue_priority": clean_scalar(issue.get("issue_priority")) or None,
            "issue_status": clean_scalar(issue.get("issue_status")) or None,
            "issue_resolution": resolution_code,
            "issue_comments_count": _optional_integer(issue.get("issue_comments_count")),
            "processing_steps": _optional_integer(issue.get("processing_steps")),
        }
        return self._finalize(
            interaction_id=issue.get("id"),
            raw_customer_id=issue.get("issue_reporter"),
            opened_at=opened_at,
            channel="web",
            messages=messages,
            state_snapshot=(),
            resolution=resolution,
            metadata=metadata,
        )


def _load_comment_groups(path: Path) -> dict[str, list[_CommentGroup]]:
    """Load only the fixed 360-issue sample's utterance grouping in memory."""

    grouped: dict[tuple[str, str, int], _CommentGroup] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        _require_columns(
            reader.fieldnames,
            {
                "issueid",
                "id",
                "comment_seq",
                "utr_seq",
                "created",
                "actionbody",
                "author_role",
            },
            filename=UTTERANCES_FILENAME,
        )
        for row_number, row in enumerate(reader, start=2):
            issue_id = clean_scalar(row.get("issueid"))
            comment_id = clean_scalar(row.get("id"))
            if not issue_id or not comment_id:
                raise AdapterError(
                    f"Missing issueid or comment id in {UTTERANCES_FILENAME} row {row_number}"
                )
            sequence = _integer(
                row.get("comment_seq"), field="comment_seq", row_number=row_number
            )
            key = (issue_id, comment_id, sequence)
            role = clean_scalar(row.get("author_role")).casefold()
            if role not in _ROLE_MAP:
                role = "others"
            created = parse_datetime(row.get("created"), field="sample_utterances.created")
            group = grouped.get(key)
            if group is None:
                group = _CommentGroup(
                    issue_id=issue_id,
                    comment_id=comment_id,
                    comment_sequence=sequence,
                    author_role=role,
                    earliest_created=created,
                    source_row=row_number,
                )
                grouped[key] = group
            group.add({**row, "author_role": role}, row_number=row_number)

    by_issue: dict[str, list[_CommentGroup]] = {}
    for group in grouped.values():
        by_issue.setdefault(group.issue_id, []).append(group)
    if not by_issue:
        raise AdapterError(f"{UTTERANCES_FILENAME} contains no utterances")
    return by_issue


def _fixture_directory(path: Path) -> Path:
    return path if path.is_dir() else path.parent


def _require_columns(
    fieldnames: list[str] | None,
    required: set[str],
    *,
    filename: str,
) -> None:
    available = set(fieldnames or ())
    missing = sorted(required - available)
    if missing:
        raise AdapterError(f"{filename} is missing required columns: {', '.join(missing)}")


def _integer(value: Any, *, field: str, row_number: int) -> int:
    text = clean_scalar(value)
    try:
        number = float(text)
    except ValueError as exc:
        raise AdapterError(f"Invalid {field} in utterance row {row_number}: {text!r}") from exc
    if not number.is_integer():
        raise AdapterError(f"Invalid {field} in utterance row {row_number}: {text!r}")
    return int(number)


def _optional_integer(value: Any) -> int | None:
    text = clean_scalar(value)
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return int(number) if number.is_integer() else None


# Explicit alias for callers that prefer the dataset name over its use case.
MendeleyHelpdeskV2Adapter = MendeleyPublicAdapter


__all__ = [
    "MendeleyHelpdeskV2Adapter",
    "MendeleyPublicAdapter",
]
