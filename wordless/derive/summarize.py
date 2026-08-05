"""Stage 1: one-sentence, content-addressed reason-for-contact summaries."""

from __future__ import annotations

from hashlib import sha256
import json

from pydantic import BaseModel, ConfigDict, Field

from wordless.core.llm import LLMClient, LLMRequest
from wordless.core.models import Interaction
from wordless.core.redact import Redactor


class InteractionSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    interaction_id: str
    text: str = Field(min_length=1)
    source: str
    interaction_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


def interaction_fingerprint(interaction: Interaction) -> str:
    payload = json.dumps(
        interaction.model_dump(mode="json"),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return sha256(payload).hexdigest()


def _fallback_summary(interaction: Interaction) -> str:
    customer = next(
        (message.text.strip() for message in interaction.messages if message.author == "customer" and message.text.strip()),
        "No customer description was provided",
    )
    one_line = " ".join(customer.split())
    words = one_line.split()
    if len(words) > 24:
        one_line = " ".join(words[:24]) + "…"
    return one_line.rstrip(".!?…") + "."


def summarize_interaction(
    interaction: Interaction,
    *,
    llm: LLMClient | None = None,
    seed: int = 17,
    redactor: Redactor | None = None,
) -> InteractionSummary:
    """Summarize only redacted text; fall back deterministically offline."""

    if not isinstance(interaction, Interaction):
        raise TypeError("interaction must be an Interaction")
    interaction = Interaction.model_validate(
        interaction.model_dump(mode="python", round_trip=True)
    )
    if any(not message.redacted for message in interaction.messages):
        raise ValueError("summarization refuses unredacted messages")
    if llm is not None and not isinstance(llm, LLMClient):
        raise TypeError(
            "llm must be an LLMClient so timeout, cache, and fallback guarantees apply"
        )
    if redactor is not None and type(redactor) is not Redactor:
        raise TypeError("redactor must be a concrete Redactor instance")
    if redactor is not None and not redactor.boundary_safe:
        raise ValueError("redactor must keep mandatory Presidio policy enabled")
    active_redactor = redactor or Redactor()
    if not active_redactor.boundary_safe:
        raise ValueError(
            "summarization requires the available mandatory pinned Presidio policy"
        )
    interaction, _report = active_redactor.redact_interaction(interaction)
    interaction = Interaction.model_validate(
        interaction.model_dump(mode="python", round_trip=True)
    )
    fingerprint = interaction_fingerprint(interaction)
    fallback = _fallback_summary(interaction)
    if llm is None:
        text, source = fallback, "fallback"
    else:
        transcript = "\n".join(
            f"{message.author}: {message.text}" for message in interaction.messages
        )
        request = LLMRequest(
            prompt=(
                "Summarize the customer's reason for contact in one factual sentence. "
                "Do not infer identity, intent, or system state beyond the transcript.\n\n"
                + transcript
            ),
            system_prompt="Return one sentence only.",
            seed=seed,
            temperature=0,
            max_output_tokens=64,
            metadata={"interaction_hash": fingerprint, "stage": "summarize"},
        )
        try:
            result = llm.generate(request)
        except Exception:
            text, source = fallback, "fallback"
        else:
            text = " ".join(result.text.strip().split()) or fallback
            source = result.source if result.text.strip() else "fallback"
    # Model output is untrusted text too.  Scan it before the summary can be
    # cached, classified, displayed, or sent to another model stage.
    text = active_redactor.redact(text).text
    return InteractionSummary(
        interaction_id=interaction.id,
        text=text,
        source=source,
        interaction_hash=fingerprint,
    )


__all__ = ["InteractionSummary", "interaction_fingerprint", "summarize_interaction"]
