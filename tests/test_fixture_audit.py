from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np

from scripts.run_fixture_audit import (
    PROGRESS_PREFIX,
    PROGRESS_PROTOCOL,
    PROGRESS_STAGE_ORDER,
    load_winning_benchmark,
    run_fixture_audit,
)


class DeterministicConceptEmbedder:
    """Offline semantic fake with exact concept agreement/contradiction."""

    def encode(self, texts: tuple[str, ...]) -> np.ndarray:
        return np.asarray([self._vector(text) for text in texts], dtype=np.float32)

    @staticmethod
    def _vector(text: str) -> list[float]:
        value = text.casefold()
        if any(token in value for token in ("charged twice", "duplicate", "money one twice", "two times")):
            return [1.0, 0.0, 0.0, 0.0, 0.0]
        if any(token in value for token in ("delivery is late", "delayed delivery", "late package", "still not come", "not changed", "parcel should")):
            return [0.0, 1.0, 0.0, 0.0, 0.0]
        if any(token in value for token in ("wrong item", "incorrect item", "incorrect product", "different thing", "blue mug")):
            return [0.0, 0.0, 1.0, 0.0, 0.0]
        if any(token in value for token in ("account is locked", "unlocked the account", "account lock", "cannot get in", "login keeps", "sign in page")):
            return [0.0, 0.0, 0.0, 1.0, 0.0]
        return [0.0, 0.0, 0.0, 0.0, 1.0]


def test_fixture_audit_has_outcome_mix_and_all_denominators(tmp_path: Path) -> None:
    result = run_fixture_audit(
        output_dir=tmp_path / "report",
        embedder=DeterministicConceptEmbedder(),
    )
    overall = result.replay_metrics.overall

    assert overall.denominator == 30
    assert overall.agreement_at_1.numerator == 12
    assert overall.agreement_at_3.numerator == 12
    assert overall.abstain.numerator == 6
    assert overall.disagreement.numerator == 12
    assert all(
        segment.denominator == 10
        for segment in result.replay_metrics.by_fragment_length.values()
    )
    assert result.replay_metrics.provenance_distribution["exported"].numerator == 30
    assert result.replay_metrics.provenance_distribution["exported"].denominator == 30
    assert result.report.outcomes.analyzed == 30
    assert result.report.outcomes.human_reviewed == 0
    assert len(result.report.findings) == 12
    assert all(finding.evidence for finding in result.report.findings)
    assert "synthetic" in " ".join(result.report.limits).casefold()
    assert {point.total for point in result.report.risk_coverage} == {15}
    assert all(point.precision == 1.0 for point in result.report.risk_coverage)
    assert max(point.selected for point in result.report.risk_coverage) == 12
    assert max(point.coverage for point in result.report.risk_coverage) == 0.8
    assert "held-out synthetic split" in result.report.risk_coverage_method
    assert "detector ID" in result.report.risk_coverage_method

    html = result.html_path.read_text(encoding="utf-8")
    assert "out of 15 labeled evaluation interactions" in html
    assert "pre-threshold top detector ID matches fixture expected_detector" in html


def test_fixture_report_is_byte_identical_across_runs(tmp_path: Path) -> None:
    progress_stream = io.StringIO()
    first = run_fixture_audit(
        output_dir=tmp_path / "first",
        embedder=DeterministicConceptEmbedder(),
    )
    second = run_fixture_audit(
        output_dir=tmp_path / "second",
        embedder=DeterministicConceptEmbedder(),
        progress_stream=progress_stream,
    )

    assert first.json_path.read_bytes() == second.json_path.read_bytes()
    assert first.html_path.read_bytes() == second.html_path.read_bytes()

    lines = progress_stream.getvalue().splitlines()
    assert len(lines) == len(PROGRESS_STAGE_ORDER) * 2
    events = []
    for line in lines:
        assert line.startswith(PROGRESS_PREFIX)
        events.append(json.loads(line.removeprefix(PROGRESS_PREFIX)))
    assert [event["sequence"] for event in events] == list(range(len(events)))
    assert [event["elapsed_ms"] for event in events] == sorted(
        event["elapsed_ms"] for event in events
    )
    for index, stage_id in enumerate(PROGRESS_STAGE_ORDER):
        started = events[index * 2]
        completed = events[index * 2 + 1]
        assert started == {
            "elapsed_ms": started["elapsed_ms"],
            "event": "stage_started",
            "protocol": PROGRESS_PROTOCOL,
            "sequence": index * 2,
            "stage_id": stage_id,
        }
        assert completed == {
            "duration_ms": completed["duration_ms"],
            "elapsed_ms": completed["elapsed_ms"],
            "event": "stage_completed",
            "protocol": PROGRESS_PROTOCOL,
            "sequence": index * 2 + 1,
            "stage_id": stage_id,
        }
        assert isinstance(completed["duration_ms"], int)
        assert 0 <= completed["duration_ms"] <= completed["elapsed_ms"]


def test_cli_resolves_model_from_verified_benchmark_result() -> None:
    winner = load_winning_benchmark()
    assert winner.model_id
    assert winner.semantic_hits_at_3 == 109
    assert winner.bm25_hits_at_3 == 61
