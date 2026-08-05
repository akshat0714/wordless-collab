from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.run_public_audit import PUBLIC_RUN_DATE, run_public_audit
from wordless.report import AuditReport


SMALL_CORPUS = Path("tests/fixtures/ingest/mendeley_public")
PINNED_CORPUS = Path(".wordless/public/mendeley-helpdesk-v2")


class FailIfCalledEmbedder:
    """No hypotheses means neither pipeline nor judge may request a vector."""

    def __init__(self) -> None:
        self.calls = 0

    def encode(self, _texts: object) -> object:
        self.calls += 1
        raise AssertionError("zero-hypothesis public replay must not call the embedder")


def test_public_report_is_byte_identical_and_non_estimability_is_structured(
    tmp_path: Path,
) -> None:
    first_embedder = FailIfCalledEmbedder()
    second_embedder = FailIfCalledEmbedder()
    first = run_public_audit(
        corpus_dir=SMALL_CORPUS,
        output_dir=tmp_path / "first",
        embedder=first_embedder,
        verify_source=False,
    )
    second = run_public_audit(
        corpus_dir=SMALL_CORPUS,
        output_dir=tmp_path / "second",
        embedder=second_embedder,
        verify_source=False,
    )

    assert first_embedder.calls == second_embedder.calls == 0
    assert first.json_path.read_bytes() == second.json_path.read_bytes()
    assert first.html_path.read_bytes() == second.html_path.read_bytes()

    payload = json.loads(first.json_path.read_text(encoding="utf-8"))
    parsed = AuditReport.model_validate_json(first.json_path.read_text(encoding="utf-8"))
    assert payload["run_date"] == PUBLIC_RUN_DATE.isoformat()
    assert payload["outcomes"]["analyzed"] == 2
    assert payload["outcomes"]["evidence_eligible"] == 0
    assert "state-backed hypothesis" in payload["outcomes"]["evidence_eligibility_method"]
    assert "disagreement_rate" not in payload["outcomes"]
    assert parsed.outcomes.disagreement_rate is None
    assert payload["findings"] == []
    assert payload["provenance"]["exported"] == 0
    assert payload["provenance"]["inferred"] == 2
    assert payload["provenance"]["reconstructed"] == 0
    assert "total" not in payload["provenance"]
    assert parsed.provenance.total == 2
    assert "per replayed interaction" in payload["provenance"]["method"]
    assert payload["judge"]["sample_size"] == 0
    assert "agreement_rate" not in payload["judge"]
    assert parsed.judge.agreement_rate is None
    assert payload["risk_coverage"] == []
    assert "no proxy" in payload["risk_coverage_method"]
    assert "No interaction produced" in payload["risk_coverage_note"]
    assert all("agreement_rate" not in segment for segment in payload["length_segments"])
    assert all(segment.agreement_rate is None for segment in parsed.length_segments)
    assert all(segment["agreement_denominator"] == 0 for segment in payload["length_segments"])
    assert payload["source_attribution"]["doi"] == "10.17632/btm76zndnt.2"
    assert payload["source_attribution"]["license_name"] == "CC BY 4.0"
    assert set(payload["source_attribution"]["files_sha256"]) == {
        "EXAMPLE.md",
        "FEATURES.md",
        "issues.csv",
        "issues_snapshot_sample.xlsx",
        "sample_utterances.csv",
    }

    html = first.html_path.read_text(encoding="utf-8")
    assert "interactions replayed in degraded text-only mode" in html
    assert "No evidence-backed findings" in html
    assert "Not estimable (n=0 labeled predictions)" in html
    assert "Not estimable (n=0): no candidate judgments" in html
    assert "account evidence indicated" not in html
    assert "Human reviewers agreed" not in html


@pytest.mark.skipif(
    not (PINNED_CORPUS / "issues.csv").is_file()
    or not (PINNED_CORPUS / "sample_utterances.csv").is_file(),
    reason="pinned public corpus has not been downloaded",
)
def test_pinned_public_audit_is_all_inferred_with_no_fabricated_findings(
    tmp_path: Path,
) -> None:
    embedder = FailIfCalledEmbedder()
    result = run_public_audit(
        corpus_dir=PINNED_CORPUS,
        output_dir=tmp_path / "public-audit",
        embedder=embedder,
    )

    assert embedder.calls == 0
    assert len(result.replay_results) == 360
    assert result.report.outcomes.analyzed == 360
    assert result.report.outcomes.evidence_eligible == 0
    assert result.report.outcomes.abstained == 360
    assert result.report.outcomes.disagreements == 0
    assert result.report.outcomes.disagreement_rate is None
    assert result.report.findings == ()
    assert result.report.provenance.exported == 0
    assert result.report.provenance.reconstructed == 0
    assert result.report.provenance.inferred == 360
    assert result.judge_validation.sample_size == 0
    assert result.risk_coverage == ()
    assert result.redaction_report.messages_processed == 7_286
    assert {
        segment.key: segment.sample_size for segment in result.report.length_segments
    } == {"short": 15, "medium": 68, "long": 277}
    assert all(not replay.pipeline.hypotheses for replay in result.replay_results)
    assert all(not replay.judgments for replay in result.replay_results)
    assert all(replay.provenance_rung == "inferred" for replay in result.replay_results)


def test_public_audit_rejects_unverified_source_files(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="exact pinned V2 source file"):
        run_public_audit(
            corpus_dir=SMALL_CORPUS,
            output_dir=tmp_path / "must-not-write",
            embedder=FailIfCalledEmbedder(),
        )
    assert not (tmp_path / "must-not-write").exists()
