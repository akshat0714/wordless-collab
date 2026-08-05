"""Evidence-first candidate pipeline."""

from wordless.pipeline.abstain import (
    CalibratedAbstainer,
    LabeledPrediction,
    RiskCoveragePoint,
    ThresholdCalibration,
    calibrate_threshold,
    risk_coverage_curve,
)
from wordless.pipeline.candidates import (
    DEFAULT_DETECTORS,
    ConfirmedDetector,
    Detector,
    Hypothesis,
    evaluate_confirmed_detectors,
    generate_hypotheses,
)
from wordless.pipeline.rerank import Candidate, MAX_CANDIDATES, rerank_hypotheses
from wordless.pipeline.run import PipelineResult, PipelineRunner, run_pipeline

__all__ = [
    "CalibratedAbstainer",
    "Candidate",
    "ConfirmedDetector",
    "DEFAULT_DETECTORS",
    "Detector",
    "Hypothesis",
    "LabeledPrediction",
    "MAX_CANDIDATES",
    "PipelineResult",
    "PipelineRunner",
    "RiskCoveragePoint",
    "ThresholdCalibration",
    "calibrate_threshold",
    "evaluate_confirmed_detectors",
    "generate_hypotheses",
    "rerank_hypotheses",
    "risk_coverage_curve",
    "run_pipeline",
]
