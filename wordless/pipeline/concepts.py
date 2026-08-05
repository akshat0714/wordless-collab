"""Concept-level retrieval helpers for incomplete support messages.

The helpers in this module never create an intent.  They operate only on
confirmed, evidence-generated :class:`~wordless.pipeline.candidates.Hypothesis`
objects, so a semantic or spelling match cannot turn customer prose into an
unsupported account claim.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import re
from typing import Any, Protocol

MAX_CONTEXT_MESSAGES = 3
MAX_CONTEXT_MESSAGE_CHARS = 500
CONTEXT_METADATA_KEY = "wordless_recent_customer_messages"
CHAT_AUTO_MIN_CONCEPT_SIMILARITY = 0.40
REPAIRED_CONCEPT_MIN_SIMILARITY = CHAT_AUTO_MIN_CONCEPT_SIMILARITY
REPAIRED_CONCEPT_MIN_MARGIN = 0.12

_WORD = re.compile(r"[A-Za-z]+(?:['’][A-Za-z]+)?")
_STOP_WORDS = frozenset(
    {
        "a",
        "am",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "been",
        "but",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "for",
        "from",
        "had",
        "has",
        "have",
        "he",
        "her",
        "hers",
        "him",
        "his",
        "how",
        "i",
        "if",
        "in",
        "is",
        "it",
        "its",
        "me",
        "my",
        "of",
        "on",
        "or",
        "our",
        "she",
        "that",
        "the",
        "their",
        "them",
        "there",
        "they",
        "this",
        "to",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
    }
)
_GENERIC_HELP_PATTERNS = (
    re.compile(r"\bhelp\b", re.I),
    re.compile(r"\bdon['’]?t\s+know\b", re.I),
    re.compile(r"\bnot\s+sure\b", re.I),
    re.compile(r"\bneed\s+words?\b", re.I),
    re.compile(r"\b(?:i\s+)?need\s+(?:it|this|that)\b", re.I),
    re.compile(r"\bsomething(?:\s+is)?\s+wrong\b", re.I),
)
_KEYBOARD_RUNS = ("asdf", "hjkl", "qwer", "zxcv")
_CONSONANT_ONLY_ALLOWLIST = frozenset({"app", "faq", "id", "pin", "pkg", "sms"})


@dataclass(frozen=True)
class ConceptRepair:
    """A bounded, detector-local spelling repair used only for retrieval."""

    text: str
    changed_tokens: int


class ConceptDefinition(Protocol):
    """Structural concept text shared by detectors and fired hypotheses."""

    title: str
    variants: tuple[str, ...]


def concept_prototypes(hypothesis: ConceptDefinition) -> tuple[str, ...]:
    """Return stable, short prototype sentences for one supported concept."""

    values = (hypothesis.title, *hypothesis.variants)
    prototypes: list[str] = []
    seen: set[str] = set()
    for value in values:
        sentence = value.rstrip(". ") + "."
        folded = sentence.casefold()
        if folded in seen:
            continue
        seen.add(folded)
        prototypes.append(sentence)
    return tuple(prototypes)


def _tokens(text: str) -> tuple[str, ...]:
    return tuple(match.group(0).casefold().replace("’", "'") for match in _WORD.finditer(text))


def _concept_terms(hypothesis: ConceptDefinition) -> tuple[str, ...]:
    values = {
        token
        for prototype in concept_prototypes(hypothesis)
        for token in _tokens(prototype)
        if token not in _STOP_WORDS and len(token) >= 3
    }
    return tuple(sorted(values))


def _damerau_levenshtein(left: str, right: str) -> int:
    """Return optimal-string-alignment distance for two short word tokens."""

    rows = len(left) + 1
    columns = len(right) + 1
    matrix = [[0] * columns for _ in range(rows)]
    for row in range(rows):
        matrix[row][0] = row
    for column in range(columns):
        matrix[0][column] = column
    for row in range(1, rows):
        for column in range(1, columns):
            substitution = 0 if left[row - 1] == right[column - 1] else 1
            matrix[row][column] = min(
                matrix[row - 1][column] + 1,
                matrix[row][column - 1] + 1,
                matrix[row - 1][column - 1] + substitution,
            )
            if (
                row > 1
                and column > 1
                and left[row - 1] == right[column - 2]
                and left[row - 2] == right[column - 1]
            ):
                matrix[row][column] = min(
                    matrix[row][column],
                    matrix[row - 2][column - 2] + substitution,
                )
    return matrix[-1][-1]


def _token_similarity(left: str, right: str) -> float:
    return 1.0 - _damerau_levenshtein(left, right) / max(len(left), len(right))


def repair_fragment_for_concept(
    fragment: str,
    hypothesis: ConceptDefinition,
) -> ConceptRepair:
    """Repair only high-confidence typos toward one evidence-backed concept.

    The repair is never returned to the customer, persisted as their words, or
    used to generate a hypothesis.  It only supplies an additional embedding
    query.  Common function words are not rewritten, with a narrow ``no`` →
    ``not`` exception that helps telegraphic phrases such as ``pakg no com``.
    """

    if not isinstance(fragment, str):
        raise TypeError("fragment must be a string")
    terms = _concept_terms(hypothesis)
    if not terms or not fragment.strip():
        return ConceptRepair(text=fragment, changed_tokens=0)

    changed = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal changed
        raw = match.group(0)
        token = raw.casefold().replace("’", "'")
        if token in terms:
            return raw
        if token == "no" and "not" in terms:
            changed += 1
            return "not"
        if token in _STOP_WORDS or len(token) < 3:
            return raw

        ranked = sorted(
            ((_token_similarity(token, term), term) for term in terms),
            key=lambda item: (-item[0], item[1]),
        )
        best_score, best_term = ranked[0]
        second_score = ranked[1][0] if len(ranked) > 1 else 0.0
        minimum = 0.72 if len(token) == 3 else 0.75
        if best_score < minimum or best_score - second_score < 0.05:
            return raw
        changed += 1
        return best_term

    repaired = _WORD.sub(replace, fragment)
    return ConceptRepair(text=repaired, changed_tokens=changed)


def contextual_query(fragment: str, metadata: Mapping[str, Any]) -> str:
    """Combine a turn with bounded, already-redacted recent customer context.

    Integrations such as Zendesk can provide up to three prior customer turns
    in ``metadata.wordless_recent_customer_messages`` without changing the v1
    request shape.  Invalid or oversized values are ignored or bounded rather
    than being allowed to expand model input indefinitely.
    """

    raw = metadata.get(CONTEXT_METADATA_KEY)
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes, bytearray)):
        return fragment
    context = [
        value.strip()[:MAX_CONTEXT_MESSAGE_CHARS]
        for value in raw
        if isinstance(value, str) and value.strip()
    ][-MAX_CONTEXT_MESSAGES:]
    if not context:
        return fragment
    values = (*context, fragment.strip()) if fragment.strip() else tuple(context)
    return " Context: ".join(values)


def is_low_legibility_fragment(fragment: str) -> bool:
    """Detect bounded high-noise text without judging a person's language.

    This is deliberately a narrow character-level gate, not a grammar test or
    disability classifier.  It catches empty-alphabetic input, keyboard runs,
    repeated characters, and multiple short consonant clusters.  Ordinary
    terse requests such as ``store hours`` and ``mailing address`` remain
    legible and continue to the host bot when no supported concept matches.
    """

    if not isinstance(fragment, str):
        raise TypeError("fragment must be a string")
    if not fragment.strip():
        return False
    tokens = _tokens(fragment)
    if not tokens:
        return True
    if len(tokens) > 6:
        return False

    suspicious = 0
    for token in tokens:
        letters = token.replace("'", "")
        if any(run in letters for run in _KEYBOARD_RUNS):
            suspicious += 1
            continue
        if re.search(r"([a-z])\1\1", letters):
            suspicious += 1
            continue
        if (
            len(letters) >= 3
            and letters not in _CONSONANT_ONLY_ALLOWLIST
            and not any(vowel in letters for vowel in "aeiouy")
        ):
            suspicious += 1
    return suspicious >= max(1, (len(tokens) + 1) // 2)


def should_use_contextual_evidence_choices(
    fragment: str,
    hypothesis: ConceptDefinition,
    *,
    concept_similarity: float,
) -> bool:
    """Conservatively identify a turn that benefits from evidence-only ranking.

    A short but clear unrelated request must continue to the host bot. The
    evidence-only path therefore requires either an explicit vague-help cue or
    a narrow high-noise character signal. A repaired, unambiguous concept keeps
    its message-ranked winner instead of discarding the customer's words.
    """

    # ``concept_similarity`` remains part of this stable helper signature for
    # callers that audit the semantic score. A successfully repaired and
    # unambiguous concept is *not* evidence-only: its message ranking must be
    # preserved. Only unresolved high-noise or deliberately vague text takes
    # the same route as the no-words control.
    _ = concept_similarity
    return has_low_composition_cue(fragment, hypothesis)


def has_low_composition_cue(
    fragment: str,
    hypothesis: ConceptDefinition,
) -> bool:
    """Return the deterministic portion of contextual evidence routing.

    This predicate is also used when an idempotent chat result is rendered
    again, so the visible selection basis does not depend on another model
    call.
    """

    _ = hypothesis
    if is_low_legibility_fragment(fragment):
        return True
    tokens = _tokens(fragment)
    if not tokens or len(tokens) > 6:
        return False
    if any(pattern.search(fragment) for pattern in _GENERIC_HELP_PATTERNS):
        return True
    return False


__all__ = [
    "CONTEXT_METADATA_KEY",
    "CHAT_AUTO_MIN_CONCEPT_SIMILARITY",
    "ConceptDefinition",
    "ConceptRepair",
    "concept_prototypes",
    "contextual_query",
    "has_low_composition_cue",
    "is_low_legibility_fragment",
    "REPAIRED_CONCEPT_MIN_MARGIN",
    "REPAIRED_CONCEPT_MIN_SIMILARITY",
    "repair_fragment_for_concept",
    "should_use_contextual_evidence_choices",
]
