#!/usr/bin/env python3
"""Render a buyer-facing audit brief (HTML + Markdown) from a report.json.

This script never re-runs replay and never talks to a network. It reads an
already-produced, strict ``AuditReport`` JSON artifact (as written by
``build_report`` in ``wordless/report/build.py``), validates it against the
same contract used to write it, and renders the honesty-preserving buyer
brief from that in-memory model.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

from wordless.report.brief import DEFAULT_MAX_FINDINGS, build_brief
from wordless.report.build import AuditReport


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report",
        type=Path,
        required=True,
        help="path to a report.json produced by build_report",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="directory to write brief.html and brief.md into",
    )
    parser.add_argument(
        "--max-findings",
        type=int,
        default=DEFAULT_MAX_FINDINGS,
        help="maximum number of example findings shown in the brief",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.max_findings < 0:
        raise SystemExit("--max-findings must be non-negative")
    report = AuditReport.model_validate_json(
        arguments.report.read_text(encoding="utf-8")
    )
    html_path, md_path = build_brief(
        report,
        arguments.output_dir,
        max_findings=arguments.max_findings,
    )
    print(f"Wrote {html_path}")
    print(f"Wrote {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
