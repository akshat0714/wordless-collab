"""Corpus-derived summaries, taxonomy, classifier, and detector proposals."""

from .detectors import (
    DetectorCondition,
    DetectorConditionEvaluation,
    DetectorConditionParameters,
    DetectorDerivationOutcome,
    DetectorProposal,
    RuntimeDetectorId,
    activate_approved_proposals,
    compile_approved_proposal,
    derive_detector_outcomes,
    detectors_yaml,
    load_detector_proposals_yaml,
    propose_detectors,
    review_detector,
)
from .distill import DistillationMetrics, DistilledClassifier, TextEmbedder
from .orchestrate import (
    CorpusPrediction,
    DerivationAudit,
    DerivationBatchAudit,
    DerivationRun,
    WeakLabel,
    WeakLabelSource,
    run_derivation,
)
from .summarize import InteractionSummary, summarize_interaction
from .taxonomy import Taxonomy, TaxonomyLabel, build_taxonomy

__all__ = [
    "CorpusPrediction",
    "DerivationAudit",
    "DerivationBatchAudit",
    "DerivationRun",
    "DetectorCondition",
    "DetectorConditionEvaluation",
    "DetectorConditionParameters",
    "DetectorDerivationOutcome",
    "DetectorProposal",
    "DistillationMetrics",
    "DistilledClassifier",
    "InteractionSummary",
    "RuntimeDetectorId",
    "Taxonomy",
    "TaxonomyLabel",
    "TextEmbedder",
    "WeakLabel",
    "WeakLabelSource",
    "activate_approved_proposals",
    "build_taxonomy",
    "compile_approved_proposal",
    "derive_detector_outcomes",
    "detectors_yaml",
    "load_detector_proposals_yaml",
    "propose_detectors",
    "review_detector",
    "run_derivation",
    "summarize_interaction",
]
