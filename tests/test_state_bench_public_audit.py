from __future__ import annotations

from pathlib import Path
import shutil

import numpy as np
import pytest

from scripts.download_state_bench import ARCHIVE
from scripts.run_state_bench_public_audit import (
    DEFAULT_CORPUS_DIR,
    run_state_bench_public_audit,
)
from wordless.ingest.state_bench import (
    STATE_BENCH_ARCHIVE_SHA256,
    TASKS_RELATIVE,
)


pytestmark = pytest.mark.skipif(
    not (DEFAULT_CORPUS_DIR / ARCHIVE.filename).is_file(),
    reason="pinned STATE-Bench corpus has not been downloaded",
)


class ConstantEmbedder:
    """Deterministic offline fake that makes every text pair equivalent."""

    def encode(self, texts: tuple[str, ...]) -> np.ndarray:
        return np.ones((len(texts), 2), dtype=np.float32)


def test_state_bench_runner_is_byte_stable_and_keeps_oracles_separate(
    tmp_path: Path,
) -> None:
    first = run_state_bench_public_audit(
        corpus_dir=DEFAULT_CORPUS_DIR,
        output_dir=tmp_path / "first",
        embedder=ConstantEmbedder(),
        verify_source=False,
    )
    second = run_state_bench_public_audit(
        corpus_dir=DEFAULT_CORPUS_DIR,
        output_dir=tmp_path / "second",
        embedder=ConstantEmbedder(),
        verify_source=False,
    )

    assert first.json_path.read_bytes() == second.json_path.read_bytes()
    assert first.html_path.read_bytes() == second.html_path.read_bytes()
    assert len(first.interactions) == 100
    assert len(first.split.development) == 20
    assert len(first.split.calibration) == 40
    assert len(first.split.held_out) == 40
    assert first.report.outcomes.analyzed == 100
    assert first.report.outcomes.evidence_eligible == 10
    assert first.report.outcomes.human_reviewed == 0
    assert [segment.sample_size for segment in first.report.length_segments] == [0, 17, 83]
    assert first.report.provenance.exported == 100
    assert first.report.judge.label_source == "synthetic_oracle"
    assert first.report.source_attribution is not None
    assert first.report.source_attribution.archive_sha256 == STATE_BENCH_ARCHIVE_SHA256
    assert all(point.total == 40 for point in first.report.risk_coverage)
    assert all(
        point.correct + point.errors == point.selected
        for point in first.report.risk_coverage
    )
    assert all(
        interaction.metadata["temporal_granularity"] == "task_now"
        for interaction in first.interactions
    )
    assert all(
        sum(fact.kind == "customer_account" for fact in interaction.state_snapshot) == 1
        for interaction in first.interactions
    )
    assert all(
        interaction.resolution is not None
        and interaction.resolution.original_label is None
        for interaction in first.interactions
    )
    assert all(
        "oracle" not in key.casefold() and "requirement" not in key.casefold()
        for interaction in first.interactions
        for key in interaction.metadata
    )


def test_state_bench_runner_refuses_tampered_extracted_sources(tmp_path: Path) -> None:
    copied = tmp_path / "state-bench"
    shutil.copytree(DEFAULT_CORPUS_DIR, copied)
    task_path = copied / TASKS_RELATIVE / "20-shipping_high_value_lost.json"
    task_path.write_bytes(task_path.read_bytes() + b"\n")

    with pytest.raises(RuntimeError, match="differs from archive"):
        run_state_bench_public_audit(
            corpus_dir=copied,
            archive_path=copied / ARCHIVE.filename,
            output_dir=tmp_path / "must-not-exist",
            embedder=ConstantEmbedder(),
            verify_source=True,
        )
