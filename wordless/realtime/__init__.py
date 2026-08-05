"""Authenticated, evidence-backed real-time suggestion service."""

from .contracts import (
    FeedbackRequest,
    FeedbackResponse,
    SuggestionRequest,
    SuggestionResponse,
)
from .service import ProductRuntime, RuntimeEvaluation

__all__ = [
    "FeedbackRequest",
    "FeedbackResponse",
    "ProductRuntime",
    "RuntimeEvaluation",
    "SuggestionRequest",
    "SuggestionResponse",
]
