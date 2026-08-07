"""Deterministic audit report rendering."""

from .brief import (
    BriefContext,
    build_brief,
    build_brief_context,
    render_brief_html,
    render_brief_markdown,
)
from .build import AuditReport, build_report

__all__ = [
    "AuditReport",
    "BriefContext",
    "build_brief",
    "build_brief_context",
    "build_report",
    "render_brief_html",
    "render_brief_markdown",
]

