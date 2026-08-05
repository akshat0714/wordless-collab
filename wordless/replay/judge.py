"""Two-stage resolution matcher for historical replay."""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from wordless.core.llm import LLMClient, LLMRequest
from wordless.core.models import Resolution
from wordless.core.redact import Redactor
from wordless.pipeline.rerank import Candidate, cosine_similarity


JudgeDecision = Literal["yes", "no", "unclear"]
JudgeStage = Literal["embedding", "llm", "fallback"]


class Judgment(BaseModel):
    """One candidate-to-resolution decision with matching provenance."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    detector_id: str
    candidate_rank: int = Field(ge=1, le=3)
    decision: JudgeDecision
    embedding_similarity: float = Field(ge=-1.0, le=1.0)
    stage: JudgeStage
    llm_source: str | None = None
    method: str

    @property
    def matches(self) -> bool:
        return self.decision == "yes"


_WORD_RE = re.compile(r"[\w]+", re.UNICODE)
_STOPWORDS = {
    "a",
    "an",
    "and",
    "as",
    "at",
    "be",
    "for",
    "from",
    "in",
    "is",
    "it",
    "of",
    "on",
    "the",
    "to",
    "was",
    "were",
    "you",
    "your",
}


def resolution_text(resolution: Resolution) -> str:
    """Construct the exact prefilter target required by the replay method."""

    parts = [resolution.closing_text.strip()]
    parts.extend(action.strip() for action in resolution.actions if action.strip())
    return "\n".join(part for part in parts if part)


def _stem(token: str) -> str:
    # A deliberately small deterministic normalizer for fallback only.
    if len(token) > 4 and token.endswith("ed"):
        token = token[:-2]
    elif len(token) > 4 and token.endswith("ing"):
        token = token[:-3]
    elif len(token) > 3 and token.endswith("s"):
        token = token[:-1]
    return token


def _tokens(text: str) -> set[str]:
    return {
        _stem(token.casefold())
        for token in _WORD_RE.findall(text)
        if token.casefold() not in _STOPWORDS
    }


def deterministic_fallback(
    candidate: Candidate,
    resolution: Resolution,
    *,
    similarity: float,
) -> JudgeDecision:
    """Offline decision for an ambiguous or malformed LLM result.

    Strong lexical support returns ``yes``; low semantic and zero lexical
    support returns ``no``; the remaining contestable cases stay ``unclear``.
    This conservative final branch prevents judge uncertainty from becoming a
    claimed disagreement.
    """

    candidate_terms = _tokens(
        " ".join((candidate.title, candidate.detector_id.replace("_", " "), *candidate.variants))
    )
    resolved = resolution_text(resolution)
    if resolution.original_label:
        resolved = f"{resolved}\n{resolution.original_label}"
    resolution_terms = _tokens(resolved)
    overlap = len(candidate_terms & resolution_terms)
    if candidate_terms and overlap / len(candidate_terms) >= 0.34:
        return "yes"
    if resolution_terms and overlap == 0 and similarity < 0.45:
        return "no"
    return "unclear"


def _parse_decision(text: str) -> JudgeDecision | None:
    stripped = text.strip().casefold()
    if not stripped:
        return None
    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict):
        value = payload.get("answer", payload.get("decision"))
        if isinstance(value, str) and value.strip().casefold() in {"yes", "no", "unclear"}:
            return value.strip().casefold()  # type: ignore[return-value]
    stripped = stripped.strip("` \n\r\t.,:;!\"")
    if stripped in {"yes", "no", "unclear"}:
        return stripped  # type: ignore[return-value]
    match = re.fullmatch(r"(?:answer|decision)\s*[:=-]\s*(yes|no|unclear)[.!]?", stripped)
    return match.group(1) if match else None  # type: ignore[return-value]


def _encode_pair(embedder: Any, left: str, right: str) -> tuple[Any, Any]:
    if hasattr(embedder, "encode"):
        matrix = embedder.encode((left, right))
    elif callable(embedder):
        matrix = embedder((left, right))
    else:
        raise TypeError("embedder must provide encode(texts) or be callable")
    if len(matrix) != 2:
        raise ValueError("embedder must return two vectors for the judge prefilter")
    return matrix[0], matrix[1]


class ReplayJudge:
    """Embedding prefilter followed by a bounded provider-neutral LLM wrapper."""

    def __init__(
        self,
        *,
        embedder: Any,
        llm: LLMClient | None = None,
        redactor: Redactor | None = None,
        match_threshold: float = 0.80,
        mismatch_threshold: float = 0.20,
    ) -> None:
        if not -1.0 <= mismatch_threshold < match_threshold <= 1.0:
            raise ValueError("judge thresholds must satisfy -1 <= mismatch < match <= 1")
        if llm is not None and not isinstance(llm, LLMClient):
            raise TypeError(
                "llm must be an LLMClient so timeout, cache, and fallback guarantees apply"
            )
        self.embedder = embedder
        self.llm = llm
        if redactor is not None and type(redactor) is not Redactor:
            raise TypeError("redactor must be a concrete Redactor instance")
        if redactor is not None and not redactor.boundary_safe:
            raise ValueError("redactor must keep mandatory Presidio policy enabled")
        self.redactor = redactor or Redactor()
        if not self.redactor.boundary_safe:
            raise ValueError(
                "judge requires the available mandatory pinned Presidio policy"
            )
        self.match_threshold = float(match_threshold)
        self.mismatch_threshold = float(mismatch_threshold)

    def _prompt(self, candidate: Candidate, resolution: Resolution) -> str:
        return (
            "Candidate problem:\n"
            f"{candidate.title}\n{candidate.detail}\n\n"
            "Recorded resolution:\n"
            f"{resolution_text(resolution)}\n\n"
            "Did this candidate correctly identify the problem that was actually resolved here? "
            "Answer exactly yes, no, or unclear."
        )

    def _llm_decision(self, prompt: str) -> tuple[JudgeDecision | None, str | None]:
        if self.llm is None:
            return None, None
        try:
            result = self.llm.generate(
                LLMRequest(
                    prompt=prompt,
                    system_prompt="You are a conservative audit judge.",
                    temperature=0.0,
                    seed=0,
                    max_output_tokens=8,
                    metadata={"task": "replay_resolution_match"},
                )
            )
        except Exception:
            return None, None
        return _parse_decision(result.text), result.source

    def judge(self, candidate: Candidate, resolution: Resolution) -> Judgment:
        if not isinstance(candidate, Candidate) or not isinstance(resolution, Resolution):
            raise TypeError("judge requires a Candidate and Resolution")
        candidate = candidate.model_copy(
            update={
                "title": self.redactor.redact(candidate.title).text,
                "detail": self.redactor.redact(candidate.detail).text,
                "variants": tuple(
                    self.redactor.redact(value).text for value in candidate.variants
                ),
            },
            deep=True,
        )
        resolution = resolution.model_copy(
            update={
                "original_label": (
                    self.redactor.redact(resolution.original_label).text
                    if resolution.original_label is not None
                    else None
                ),
                "actions": [
                    self.redactor.redact(value).text for value in resolution.actions
                ],
                "closing_text": self.redactor.redact(resolution.closing_text).text,
            },
            deep=True,
        )
        target = resolution_text(resolution)
        if not target:
            return Judgment(
                detector_id=candidate.detector_id,
                candidate_rank=candidate.rank,
                decision="unclear",
                embedding_similarity=0.0,
                stage="fallback",
                method="empty recorded resolution; conservative deterministic fallback",
            )
        left, right = _encode_pair(self.embedder, candidate.title, target)
        similarity = cosine_similarity(left, right)
        if similarity >= self.match_threshold:
            return Judgment(
                detector_id=candidate.detector_id,
                candidate_rank=candidate.rank,
                decision="yes",
                embedding_similarity=similarity,
                stage="embedding",
                method=f"embedding cosine >= {self.match_threshold:g}",
            )
        if similarity <= self.mismatch_threshold:
            return Judgment(
                detector_id=candidate.detector_id,
                candidate_rank=candidate.rank,
                decision="no",
                embedding_similarity=similarity,
                stage="embedding",
                method=f"embedding cosine <= {self.mismatch_threshold:g}",
            )

        prompt = self._prompt(candidate, resolution)
        decision, source = self._llm_decision(prompt)
        if decision is not None and source != "fallback":
            return Judgment(
                detector_id=candidate.detector_id,
                candidate_rank=candidate.rank,
                decision=decision,
                embedding_similarity=similarity,
                stage="llm",
                llm_source=source,
                method="ambiguous embedding prefilter; LLM yes/no/unclear judgment",
            )
        if decision is None:
            decision = deterministic_fallback(candidate, resolution, similarity=similarity)
        return Judgment(
            detector_id=candidate.detector_id,
            candidate_rank=candidate.rank,
            decision=decision,
            embedding_similarity=similarity,
            stage="fallback",
            llm_source=source,
            method="ambiguous embedding prefilter; deterministic lexical fallback",
        )


def judge_candidate(
    candidate: Candidate,
    resolution: Resolution,
    *,
    embedder: Any,
    llm: LLMClient | None = None,
    redactor: Redactor | None = None,
    match_threshold: float = 0.80,
    mismatch_threshold: float = 0.20,
) -> Judgment:
    return ReplayJudge(
        embedder=embedder,
        llm=llm,
        redactor=redactor,
        match_threshold=match_threshold,
        mismatch_threshold=mismatch_threshold,
    ).judge(candidate, resolution)


__all__ = [
    "JudgeDecision",
    "JudgeStage",
    "Judgment",
    "ReplayJudge",
    "deterministic_fallback",
    "judge_candidate",
    "resolution_text",
]
