"""PII redaction with a deterministic, fail-closed production boundary.

The deterministic regex detector always runs.  A pinned Presidio/spaCy model
augments (never replaces) that baseline at every production boundary.  A
standalone regex fallback remains useful for isolated tests, but it is marked
unsafe for ingest, persistence, and model calls and can never cross them.
Structured evidence needed by replay -- money amounts, order IDs, SKUs, and
catalog-provenanced product identity -- survives through narrow typed rules.
"""

from __future__ import annotations

from collections import Counter, OrderedDict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from functools import lru_cache
from hashlib import sha256
from importlib.metadata import version
import math
import re
from threading import RLock
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .models import Interaction, Message, Resolution, StateFact


EntityType = Literal[
    "PERSON",
    "CUSTOMER_ID",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "ADDRESS",
    "CREDIT_CARD",
    "NATIONAL_ID",
    "DATE_OF_BIRTH",
]


class RedactionFinding(BaseModel):
    """A non-identifying description of one replaced source span."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    entity_type: EntityType
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    source: Literal["regex", "presidio", "regex+presidio"]

    @model_validator(mode="after")
    def validate_span(self) -> Self:
        if self.end <= self.start:
            raise ValueError("finding end must be greater than start")
        return self


class RedactionReport(BaseModel):
    """Aggregatable, PII-free counts suitable for a corpus audit report."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    entity_counts: dict[str, int] = Field(default_factory=dict)
    messages_processed: int = Field(default=0, ge=0)
    messages_changed: int = Field(default=0, ge=0)
    text_values_processed: int = Field(default=0, ge=0)
    text_values_changed: int = Field(default=0, ge=0)
    detectors: tuple[str, ...] = ("regex",)

    @field_validator("entity_counts")
    @classmethod
    def validate_counts(cls, value: dict[str, int]) -> dict[str, int]:
        if any(not isinstance(count, int) or count < 0 for count in value.values()):
            raise ValueError("entity counts must be non-negative integers")
        return dict(sorted(value.items()))

    @model_validator(mode="after")
    def validate_totals(self) -> Self:
        if self.messages_changed > self.messages_processed:
            raise ValueError("messages_changed cannot exceed messages_processed")
        if self.text_values_changed > self.text_values_processed:
            raise ValueError("text_values_changed cannot exceed text_values_processed")
        return self

    def merge(self, *others: RedactionReport) -> RedactionReport:
        counts: Counter[str] = Counter(self.entity_counts)
        messages_processed = self.messages_processed
        messages_changed = self.messages_changed
        text_values_processed = self.text_values_processed
        text_values_changed = self.text_values_changed
        detectors = set(self.detectors)
        for other in others:
            if not isinstance(other, RedactionReport):
                raise TypeError("RedactionReport.merge accepts RedactionReport values")
            counts.update(other.entity_counts)
            messages_processed += other.messages_processed
            messages_changed += other.messages_changed
            text_values_processed += other.text_values_processed
            text_values_changed += other.text_values_changed
            detectors.update(other.detectors)
        return RedactionReport(
            entity_counts=dict(sorted(counts.items())),
            messages_processed=messages_processed,
            messages_changed=messages_changed,
            text_values_processed=text_values_processed,
            text_values_changed=text_values_changed,
            detectors=tuple(sorted(detectors)),
        )

    def __add__(self, other: RedactionReport) -> RedactionReport:
        return self.merge(other)


class RedactionResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    text: str
    findings: tuple[RedactionFinding, ...] = ()
    report: RedactionReport

    @property
    def changed(self) -> bool:
        return bool(self.findings)

    @property
    def redacted_text(self) -> str:
        return self.text


@dataclass(frozen=True)
class _RegexRule:
    entity_type: EntityType
    pattern: re.Pattern[str]
    group: int | str = 0
    validator: Callable[[str], bool] | None = None


def _luhn_valid(candidate: str) -> bool:
    digits = "".join(character for character in candidate if character.isdigit())
    if not 13 <= len(digits) <= 19 or len(set(digits)) == 1:
        return False
    checksum = 0
    parity = len(digits) % 2
    for index, character in enumerate(digits):
        value = int(character)
        if index % 2 == parity:
            value *= 2
            if value > 9:
                value -= 9
        checksum += value
    return checksum % 10 == 0


_DATE = (
    r"(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|"
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|"
    r"Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4})"
)

_REGEX_RULES: tuple[_RegexRule, ...] = (
    _RegexRule(
        "CUSTOMER_ID",
        re.compile(
            r"(?<![A-Za-z0-9])"
            r"(?:cust(?:omer)?|user|acct|account)[._-]"
            r"(?=[A-Za-z0-9._-]{2,64}\b)(?=[A-Za-z0-9._-]*\d)"
            r"[A-Za-z0-9][A-Za-z0-9._-]{1,63}\b",
            re.I,
        ),
    ),
    _RegexRule(
        "EMAIL_ADDRESS",
        re.compile(r"(?<![\w.+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![\w-])", re.I),
    ),
    _RegexRule(
        "CREDIT_CARD",
        re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)"),
        validator=_luhn_valid,
    ),
    _RegexRule(
        "NATIONAL_ID",
        re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)"),
    ),
    _RegexRule(
        "NATIONAL_ID",
        re.compile(
            r"(?i:\b(?:passport|national\s+id|tax\s+id|driver(?:'s)?\s+licen[cs]e))"
            r"\s*(?i:(?:number|no\.?|id)\s*)?(?:[:#-]\s*)?"
            r"([A-Z0-9](?:[A-Z0-9-]{4,18})[A-Z0-9])\b"
        ),
        group=1,
    ),
    _RegexRule(
        "DATE_OF_BIRTH",
        re.compile(
            rf"(?i:\b(?:date\s+of\s+birth|dob|born(?:\s+on)?|birthday))"
            rf"\s*(?i:(?:is|was)\s*)?(?:[:#-]\s*)?({_DATE})\b",
            re.I,
        ),
        group=1,
    ),
    _RegexRule(
        "PHONE_NUMBER",
        re.compile(
            r"(?<![\w$])(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{3}\)?[ .-]?)"
            r"\d{3}[ .-]?\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?(?!\w)",
            re.I,
        ),
    ),
    _RegexRule(
        "ADDRESS",
        re.compile(
            # Do not begin inside structured identifiers such as ORD-7280.
            # High-confidence PII detectors still override an entire protected
            # identifier when the private value itself is a phone, card, or ID.
            r"(?<![A-Z0-9-])\d{1,6}\s+(?:[A-Z0-9][A-Z0-9.'-]*\s+){1,6}"
            r"(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|"
            r"Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Way|Place|Pl\.?|Parkway|Pkwy\.?)"
            r"(?:\s+(?:Apt\.?|Apartment|Unit|Suite|Ste\.?)\s*[A-Z0-9-]+)?\b",
            re.I,
        ),
    ),
    _RegexRule(
        "PERSON",
        re.compile(
            r"(?i:\b(?:my\s+name\s+is|name\s*:|this\s+is)\s+)"
            r"([A-ZÀ-ÖØ-öø-ÿ][A-ZÀ-ÖØ-öø-ÿ'’-]*"
            r"(?:\s+[A-ZÀ-ÖØ-öø-ÿ][A-ZÀ-ÖØ-öø-ÿ'’-]*){0,2})",
            re.I,
        ),
        group=1,
    ),
    # Name-like values embedded in a claimed business identifier must not be
    # hidden by the order/SKU syntax.  Capture the entire suspicious payload,
    # including a trailing numeric component, so no surname fragment remains.
    _RegexRule(
        "PERSON",
        re.compile(
            r"(?i:\b(?:order|ord|invoice|inv|ticket|case|confirmation|sku))"
            r"\s*(?i:(?:number|no\.?|id)\s*)?(?:[:#-]\s*)?"
            r"([A-Z][a-z]{2,}(?:[-_][A-Z][a-z]{2,})+(?:[-_]\d+)?)"
        ),
        group=1,
    ),
    _RegexRule(
        "PERSON",
        re.compile(
            r"(?i:\b(?:ord|inv|sku|ticket|case))[-_:]"
            r"([A-Z][a-z]{2,}(?:[-_]\d+)+)"
        ),
        group=1,
    ),
    _RegexRule(
        "PERSON",
        re.compile(
            r"(?i:\b(?:I['’]m|I\s+am|Hi[,]?\s+I['’]m)\s+)"
            r"([A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’-]*"
            r"(?:\s+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’-]*){0,2})"
        ),
        group=1,
    ),
    # A conservative standalone-name fallback.  Two title-cased words catches
    # names in terse labels/notes where there is no linguistic cue; configured
    # product names are protected before this rule is applied.
    _RegexRule(
        "PERSON",
        re.compile(
            r"(?<![\w'’])([A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]{1,}"
            r"(?:\s+[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]{1,}){1,2})(?![\w'’])"
        ),
        group=1,
    ),
)


_AMOUNT_PATTERN = re.compile(
    r"(?<!\w)(?:[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|"
    r"(?:USD|EUR|GBP|JPY|CAD|AUD)\s?\d[\d,]*(?:\.\d{1,2})?|"
    r"\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|JPY|CAD|AUD))(?!\w)",
    re.I,
)
_ORDER_ID_PATTERN = re.compile(
    r"(?i:\b(?:order|ord|invoice|inv|ticket|case|confirmation))"
    r"\s*(?i:(?:number|no\.?|id)\s*)?(?:[:#-]\s*)?"
    r"(?=[A-Z0-9_-]{3,32}\b)(?=[A-Z0-9_-]*\d)[A-Z0-9][A-Z0-9_-]{2,31}\b",
    re.I,
)
_SKU_PATTERN = re.compile(
    r"(?i:\bSKU)\s*(?:[:#-]\s*)?(?=[A-Z0-9._/-]{3,40}\b)"
    r"(?=[A-Z0-9._/-]*\d)[A-Z0-9][A-Z0-9._/-]{2,39}\b",
    re.I,
)
_PLACEHOLDER_PATTERN = re.compile(r"<[A-Z][A-Z_]+>")
_PSEUDONYMOUS_ID_PATTERN = re.compile(
    r"(?:redacted-)?hmac-sha256:[0-9a-f]{64}"
)
_SCHEMA_LABEL_PATTERN = re.compile(r"[a-z][a-z0-9_.-]{0,63}")


_PRESIDIO_ENTITY_MAP: dict[str, EntityType] = {
    "PERSON": "PERSON",
    "EMAIL_ADDRESS": "EMAIL_ADDRESS",
    "PHONE_NUMBER": "PHONE_NUMBER",
    "LOCATION": "ADDRESS",
    "CREDIT_CARD": "CREDIT_CARD",
    "US_SSN": "NATIONAL_ID",
    "US_DRIVER_LICENSE": "NATIONAL_ID",
    "US_PASSPORT": "NATIONAL_ID",
    "US_ITIN": "NATIONAL_ID",
}

_ENTITY_PRIORITY: dict[str, int] = {
    "CREDIT_CARD": 7,
    "NATIONAL_ID": 6,
    "CUSTOMER_ID": 6,
    "EMAIL_ADDRESS": 5,
    "PHONE_NUMBER": 4,
    "DATE_OF_BIRTH": 3,
    "ADDRESS": 2,
    "PERSON": 1,
}

_SENSITIVE_FIELD_KEYS: dict[str, EntityType] = {
    "account_id": "CUSTOMER_ID",
    "address": "ADDRESS",
    "billing_address": "ADDRESS",
    "card_number": "CREDIT_CARD",
    "credit_card": "CREDIT_CARD",
    "customer_id": "CUSTOMER_ID",
    "date_of_birth": "DATE_OF_BIRTH",
    "dob": "DATE_OF_BIRTH",
    "birth_date": "DATE_OF_BIRTH",
    "birthdate": "DATE_OF_BIRTH",
    "birthday": "DATE_OF_BIRTH",
    "driver_license": "NATIONAL_ID",
    "drivers_license": "NATIONAL_ID",
    "email": "EMAIL_ADDRESS",
    "email_address": "EMAIL_ADDRESS",
    "first_name": "PERSON",
    "full_name": "PERSON",
    "last_name": "PERSON",
    "mailing_address": "ADDRESS",
    "mobile": "PHONE_NUMBER",
    "mobile_number": "PHONE_NUMBER",
    "name": "PERSON",
    "national_id": "NATIONAL_ID",
    "passport": "NATIONAL_ID",
    "passport_number": "NATIONAL_ID",
    "phone": "PHONE_NUMBER",
    "phone_number": "PHONE_NUMBER",
    "shipping_address": "ADDRESS",
    "ssn": "NATIONAL_ID",
    "street_address": "ADDRESS",
    "tax_id": "NATIONAL_ID",
    "telephone": "PHONE_NUMBER",
    "user_id": "CUSTOMER_ID",
}

_CURRENCY_FIELD_KEYS = {"currency", "currency_code", "iso_currency"}
_AMOUNT_FIELD_KEYS = {
    "amount",
    "charge_amount",
    "price",
    "refund_amount",
    "subtotal",
    "total",
    "unit_price",
}
_BUSINESS_ID_FIELD_KEYS = {
    "charge_id",
    "confirmation_id",
    "invoice_id",
    "delivered_sku",
    "expected_sku",
    "item_id",
    "item_sku",
    "order_id",
    "order_number",
    "payment_id",
    "product_id",
    "product_sku",
    "ordered_sku",
    "received_sku",
    "shipment_id",
    "sku",
    "ticket_id",
    "tracking_number",
    "transaction_id",
}
_PRODUCT_FIELD_KEYS = {
    "delivered_item",
    "delivered_product",
    "expected_item",
    "expected_product",
    "ordered_item",
    "ordered_product",
    "product_name",
    "received_item",
    "received_product",
}
_PRODUCT_ID_COMPANIONS: dict[str, tuple[str, ...]] = {
    "delivered_item": ("delivered_sku",),
    "delivered_product": ("delivered_sku",),
    "expected_item": ("expected_sku",),
    "expected_product": ("expected_sku",),
    "ordered_item": ("ordered_sku",),
    "ordered_product": ("ordered_sku",),
    "product_name": ("item_id", "item_sku", "product_id", "product_sku", "sku"),
    "received_item": ("received_sku",),
    "received_product": ("received_sku",),
}
_CURRENCY_CODES = frozenset(
    {
        "AUD",
        "BRL",
        "CAD",
        "CHF",
        "CNY",
        "DKK",
        "EUR",
        "GBP",
        "HKD",
        "INR",
        "JPY",
        "KRW",
        "MXN",
        "NOK",
        "NZD",
        "PLN",
        "SEK",
        "SGD",
        "USD",
        "ZAR",
    }
)
_CURRENCY_SYMBOLS = frozenset({"$", "€", "£", "¥"})
_AMOUNT_VALUE = re.compile(
    r"(?:(?P<prefix>[$€£¥]|[A-Z]{3})\s*)?"
    r"-?\d[\d,]*(?:\.\d{1,4})?"
    r"(?:\s*(?P<suffix>[A-Z]{3}))?",
)
_BUSINESS_ID_CANDIDATE = re.compile(
    r"(?=.{3,64}\Z)(?=.*[A-Za-z])(?=.*(?:\d|[._/-]))[A-Za-z0-9._/-]+"
)
_STRUCTURED_SCHEMA_KEYS = (
    _CURRENCY_FIELD_KEYS
    | _AMOUNT_FIELD_KEYS
    | _BUSINESS_ID_FIELD_KEYS
    | _PRODUCT_FIELD_KEYS
)

_SPACY_MODEL = "en_core_web_sm"
_SPACY_DISTRIBUTION = "en-core-web-sm"
_SPACY_VERSION = "3.8.0"


@lru_cache(maxsize=1)
def _production_analyzer() -> Any:
    """Load the exact production NLP artifact once per process."""

    from presidio_analyzer import AnalyzerEngine
    from presidio_analyzer.nlp_engine import NlpEngineProvider

    installed_version = version(_SPACY_DISTRIBUTION)
    if installed_version != _SPACY_VERSION:
        raise RuntimeError(
            f"expected {_SPACY_DISTRIBUTION} {_SPACY_VERSION}, found {installed_version}"
        )
    provider = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": "en", "model_name": _SPACY_MODEL}],
            "ner_model_configuration": {
                "model_to_presidio_entity_mapping": {
                    "PER": "PERSON",
                    "PERSON": "PERSON",
                    "FAC": "LOCATION",
                    "LOC": "LOCATION",
                    "GPE": "LOCATION",
                    "LOCATION": "LOCATION",
                    "ORG": "ORGANIZATION",
                    "ORGANIZATION": "ORGANIZATION",
                    "DATE": "DATE_TIME",
                    "TIME": "DATE_TIME",
                },
                "low_confidence_score_multiplier": 0.4,
                "low_score_entity_names": [],
                "labels_to_ignore": [
                    "ORGANIZATION",
                    "CARDINAL",
                    "EVENT",
                    "LANGUAGE",
                    "LAW",
                    "MONEY",
                    "NORP",
                    "ORDINAL",
                    "PERCENT",
                    "PRODUCT",
                    "QUANTITY",
                    "WORK_OF_ART",
                ],
            },
        }
    )
    return AnalyzerEngine(
        nlp_engine=provider.create_engine(),
        supported_languages=["en"],
    )


def _normalized_field_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", key.casefold()).strip("_")


def _business_identifier_shape_safe(text: str) -> bool:
    """Accept opaque-looking IDs, not human-name slugs."""

    if text.isdigit():
        return 1 <= len(text) <= 9
    if _BUSINESS_ID_CANDIDATE.fullmatch(text) is None:
        return False
    alpha_parts = [
        part
        for part in re.split(r"[._/-]+", text)
        if part.isalpha()
    ]
    if not alpha_parts or all(part.isupper() for part in alpha_parts):
        return True
    return (
        len(alpha_parts) == 1
        and alpha_parts[0] in {"case", "ch", "demo", "inv", "ord", "pi", "sku", "txn"}
    )


def is_structured_schema_key(key: str) -> bool:
    """Return whether ``key`` is a fixed canonical evidence-field name."""

    return isinstance(key, str) and _normalized_field_key(key) in _STRUCTURED_SCHEMA_KEYS


def _field_entity(key: str) -> EntityType | None:
    normalized = _normalized_field_key(key)
    direct = _SENSITIVE_FIELD_KEYS.get(normalized)
    if direct is not None:
        return direct
    for prefix in ("customer", "contact", "user", "person", "recipient"):
        suffix = normalized.removeprefix(prefix + "_")
        if suffix != normalized and suffix in _SENSITIVE_FIELD_KEYS:
            return _SENSITIVE_FIELD_KEYS[suffix]
    return None


def _is_safe_structured_signal(key: str, value: Any) -> bool:
    """Allow a narrowly typed business value past contextual NLP false positives.

    Deterministic high-confidence PII recognizers always win, even under a
    signal-bearing key.  The key therefore cannot be abused to preserve an
    email, phone, payment card, national ID, date of birth, or address.
    """

    normalized = _normalized_field_key(key)
    if isinstance(value, bool) or isinstance(
        value, (Mapping, list, tuple, set, frozenset)
    ):
        return False
    text = str(value).strip()
    if not text:
        return False
    for rule in _REGEX_RULES:
        if rule.entity_type == "PERSON":
            continue
        for match in rule.pattern.finditer(text):
            candidate = match.group(rule.group)
            if rule.validator is None or rule.validator(candidate):
                return False
    if normalized in _CURRENCY_FIELD_KEYS:
        return text in _CURRENCY_CODES or text in _CURRENCY_SYMBOLS
    if normalized in _AMOUNT_FIELD_KEYS:
        if isinstance(value, (int, float)):
            return True
        match = _AMOUNT_VALUE.fullmatch(text)
        if match is None:
            return False
        prefix = match.group("prefix")
        suffix = match.group("suffix")
        return (
            (prefix is None or prefix in _CURRENCY_CODES or prefix in _CURRENCY_SYMBOLS)
            and (suffix is None or suffix in _CURRENCY_CODES)
        )
    if normalized in _BUSINESS_ID_FIELD_KEYS:
        return _business_identifier_shape_safe(text)
    return False


def _overlaps(left: tuple[int, int], right: tuple[int, int]) -> bool:
    return left[0] < right[1] and right[0] < left[1]


class Redactor:
    """Combine Presidio and deterministic fallback patterns."""

    _SPACY_MODEL = _SPACY_MODEL
    _SPACY_DISTRIBUTION = _SPACY_DISTRIBUTION
    _SPACY_VERSION = _SPACY_VERSION

    def __init__(
        self,
        *,
        preserve_terms: Sequence[str] = (),
        product_names: Sequence[str] = (),
        product_catalog: Mapping[str, str] | None = None,
        use_presidio: bool = True,
        analyzer: Any | None = None,
        presidio_score_threshold: float = 0.5,
        cache_results: bool = True,
    ) -> None:
        if type(cache_results) is not bool:
            raise TypeError("cache_results must be a boolean")
        terms = tuple(preserve_terms) + tuple(product_names)
        if any(not isinstance(term, str) or not term for term in terms):
            raise ValueError("preserved terms and product names must be non-empty strings")
        # Catalog product names may override a conservative PERSON false
        # positive, but no caller-controlled allowlist may suppress a
        # high-confidence PII pattern.  Structured order/SKU/amount handling
        # below follows the same rule at span resolution time.
        unsafe: dict[str, set[str]] = {}
        for term in terms:
            entity_types: set[str] = set()
            for rule in _REGEX_RULES:
                if rule.entity_type == "PERSON":
                    continue
                for match in rule.pattern.finditer(term):
                    candidate = match.group(rule.group)
                    if rule.validator is None or rule.validator(candidate):
                        entity_types.add(rule.entity_type)
            if entity_types:
                unsafe[term] = entity_types
        if unsafe:
            descriptions = ", ".join(
                f"{term!r} ({'/'.join(sorted(entity_types))})"
                for term, entity_types in sorted(unsafe.items())
            )
            raise ValueError(
                "preservation terms cannot contain high-confidence PII: "
                + descriptions
            )
        self.preserve_terms = tuple(dict.fromkeys(terms))
        if product_catalog is None:
            catalog_items: tuple[tuple[str, str], ...] = ()
        elif not isinstance(product_catalog, Mapping):
            raise TypeError("product_catalog must map a safe SKU/product ID to a name")
        else:
            normalized_catalog: dict[str, str] = {}
            for raw_identifier, raw_name in product_catalog.items():
                if not isinstance(raw_identifier, str) or not isinstance(raw_name, str):
                    raise TypeError("product_catalog keys and values must be strings")
                identifier = raw_identifier.strip()
                name = raw_name.strip()
                if (
                    identifier != raw_identifier
                    or name != raw_name
                    or not name
                    or not _business_identifier_shape_safe(identifier)
                ):
                    raise ValueError(
                        "product_catalog requires trimmed names and safe opaque identifiers"
                    )
                unsafe_name_entities: set[str] = set()
                unsafe_identifier_entities: set[str] = set()
                for rule in _REGEX_RULES:
                    for match in rule.pattern.finditer(name):
                        candidate = match.group(rule.group)
                        if (
                            rule.entity_type != "PERSON"
                            and (rule.validator is None or rule.validator(candidate))
                        ):
                            unsafe_name_entities.add(rule.entity_type)
                    for match in rule.pattern.finditer(identifier):
                        candidate = match.group(rule.group)
                        if rule.validator is None or rule.validator(candidate):
                            unsafe_identifier_entities.add(rule.entity_type)
                if unsafe_name_entities or unsafe_identifier_entities:
                    raise ValueError(
                        "product_catalog cannot contain high-confidence PII"
                    )
                normalized_catalog[identifier] = name
            catalog_items = tuple(sorted(normalized_catalog.items()))
        # Immutable catalog provenance may authorize only the exact canonical
        # name paired with an independently safe sibling SKU/product ID.
        self.product_catalog = catalog_items
        self._product_catalog_snapshot = catalog_items
        if not 0 <= presidio_score_threshold <= 1:
            raise ValueError("presidio_score_threshold must be between zero and one")
        self.presidio_score_threshold = presidio_score_threshold
        self.cache_results = cache_results
        self._cache_results_snapshot = cache_results
        # Explicit analyzer injection and disabling/weakening Presidio are
        # useful only for isolated unit tests.  Production ingest, persistence,
        # and model boundaries reject those configurations so there is no
        # caller-controlled redaction bypass.
        production_policy_requested = (
            use_presidio
            and analyzer is None
            and presidio_score_threshold <= 0.5
            and not terms
        )
        self._analyzer = analyzer
        self._analyzer_error: Exception | None = None
        # Hash keys retain no source text.  The fixed bound preserves adapter
        # streaming behavior while accelerating mandatory defense-in-depth
        # rescans of the same canonical interactions.
        self._result_cache: OrderedDict[
            tuple[float, bytes], RedactionResult
        ] = OrderedDict()
        self._cache_lock = RLock()
        if analyzer is None and use_presidio:
            try:
                self._analyzer = _production_analyzer()
            except Exception as exc:
                # Standalone callers can still use deterministic regex
                # redaction, but mandatory boundaries see boundary_safe=False
                # and fail before any value is persisted or sent to a model.
                self._analyzer_error = exc
                self._analyzer = None
        self._production_policy_requested = production_policy_requested

    @property
    def presidio_available(self) -> bool:
        return self._analyzer is not None

    @property
    def boundary_safe(self) -> bool:
        """Whether this instance still retains the mandatory production policy."""

        threshold = self.presidio_score_threshold
        if (
            not self._production_policy_requested
            or self.preserve_terms != ()
            or self.product_catalog != self._product_catalog_snapshot
            or self.cache_results is not self._cache_results_snapshot
            or isinstance(threshold, bool)
            or not isinstance(threshold, (int, float))
            or not 0 <= threshold <= 0.5
            or self._analyzer is None
        ):
            return False
        try:
            return self._analyzer is _production_analyzer()
        except Exception:
            return False

    def _assert_policy_intact(self) -> None:
        """Fail closed if a once-production instance was altered after wiring."""

        if self._production_policy_requested and not self.boundary_safe:
            raise RuntimeError(
                "mandatory Presidio policy changed or became unavailable; "
                "refusing unsafe fallback"
            )

    def _protected_spans(self, text: str) -> tuple[tuple[int, int], ...]:
        spans: list[tuple[int, int]] = []
        for pattern in (_PLACEHOLDER_PATTERN,):
            spans.extend((match.start(), match.end()) for match in pattern.finditer(text))
        for term in self.preserve_terms:
            spans.extend(
                (match.start(), match.end())
                for match in re.finditer(re.escape(term), text, re.I)
            )
        return tuple(sorted(set(spans)))

    def _regex_findings(self, text: str) -> list[RedactionFinding]:
        findings: list[RedactionFinding] = []
        for rule in _REGEX_RULES:
            for match in rule.pattern.finditer(text):
                candidate = match.group(rule.group)
                if rule.validator is not None and not rule.validator(candidate):
                    continue
                findings.append(
                    RedactionFinding(
                        entity_type=rule.entity_type,
                        start=match.start(rule.group),
                        end=match.end(rule.group),
                        source="regex",
                    )
                )
        return findings

    def _presidio_findings(self, text: str) -> tuple[list[RedactionFinding], bool]:
        if self._analyzer is None:
            if self._production_policy_requested:
                raise RuntimeError("mandatory Presidio analyzer is unavailable")
            return [], False
        try:
            results = self._analyzer.analyze(
                text=text,
                language="en",
                entities=tuple(_PRESIDIO_ENTITY_MAP),
                score_threshold=self.presidio_score_threshold,
            )
        except Exception as exc:
            if self._production_policy_requested:
                raise RuntimeError(
                    "mandatory Presidio analysis failed; refusing unsafe fallback"
                ) from exc
            return [], False
        findings: list[RedactionFinding] = []
        for result in results:
            entity_type = _PRESIDIO_ENTITY_MAP.get(getattr(result, "entity_type", ""))
            start = getattr(result, "start", None)
            end = getattr(result, "end", None)
            if (
                entity_type is not None
                and isinstance(start, int)
                and isinstance(end, int)
                and 0 <= start < end <= len(text)
            ):
                findings.append(
                    RedactionFinding(
                        entity_type=entity_type,
                        start=start,
                        end=end,
                        source="presidio",
                    )
                )
        return findings, True

    @staticmethod
    def _resolve_findings(
        findings: Sequence[RedactionFinding],
        protected: Sequence[tuple[int, int]],
    ) -> tuple[RedactionFinding, ...]:
        # Protection exists to keep catalog-provenanced product names and
        # structured business identifiers from PERSON false positives.  It is
        # never allowed to defeat email, phone, card, national-ID, DOB, or
        # address detection.  Ambiguous identifiers are therefore redacted
        # fail-closed.
        eligible = [
            finding
            for finding in findings
            if finding.entity_type != "PERSON"
            or not any(
                _overlaps((finding.start, finding.end), span) for span in protected
            )
        ]
        eligible.sort(
            key=lambda finding: (
                finding.start,
                finding.end,
                -_ENTITY_PRIORITY[finding.entity_type],
                finding.source,
            )
        )
        groups: list[list[RedactionFinding]] = []
        for finding in eligible:
            if not groups or finding.start >= max(item.end for item in groups[-1]):
                groups.append([finding])
            else:
                groups[-1].append(finding)

        resolved: list[RedactionFinding] = []
        for group in groups:
            representative = max(
                group,
                key=lambda finding: (
                    _ENTITY_PRIORITY[finding.entity_type],
                    finding.end - finding.start,
                    finding.entity_type,
                ),
            )
            sources = {finding.source for finding in group}
            if "regex" in sources and "presidio" in sources:
                source = "regex+presidio"
            elif any(source == "regex+presidio" for source in sources):
                source = "regex+presidio"
            else:
                source = representative.source
            resolved.append(
                RedactionFinding(
                    entity_type=representative.entity_type,
                    start=min(finding.start for finding in group),
                    end=max(finding.end for finding in group),
                    source=source,
                )
            )
        return tuple(resolved)

    def redact(self, text: str) -> RedactionResult:
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        self._assert_policy_intact()
        cache_key: tuple[float, bytes] | None = None
        if self.boundary_safe and self.cache_results:
            cache_key = (
                float(self.presidio_score_threshold),
                sha256(text.encode("utf-8")).digest(),
            )
            with self._cache_lock:
                cached = self._result_cache.get(cache_key)
                if cached is not None:
                    self._result_cache.move_to_end(cache_key)
                    return cached
        protected = self._protected_spans(text)
        findings = self._regex_findings(text)
        presidio_findings, presidio_used = self._presidio_findings(text)
        findings.extend(presidio_findings)
        resolved = self._resolve_findings(findings, protected)

        redacted = text
        for finding in reversed(resolved):
            replacement = f"<{finding.entity_type}>"
            redacted = redacted[: finding.start] + replacement + redacted[finding.end :]
        counts = Counter(finding.entity_type for finding in resolved)
        report = RedactionReport(
            entity_counts=dict(sorted(counts.items())),
            text_values_processed=1,
            text_values_changed=int(bool(resolved)),
            detectors=("presidio", "regex") if presidio_used else ("regex",),
        )
        result = RedactionResult(text=redacted, findings=resolved, report=report)
        if cache_key is not None:
            with self._cache_lock:
                self._result_cache[cache_key] = result
                self._result_cache.move_to_end(cache_key)
                if len(self._result_cache) > 16_384:
                    self._result_cache.popitem(last=False)
        return result

    def redact_identifier(self, text: str) -> RedactionResult:
        """Scan a structural ID with mandatory deterministic recognizers only.

        Presidio's contextual LOCATION/PERSON models can treat ordinary ticket
        IDs such as ``T-100`` as entities.  Structural IDs have no prose
        context, so the deterministic recognizers are the fail-closed and
        reproducible boundary here.
        """

        if not isinstance(text, str):
            raise TypeError("text must be a string")
        self._assert_policy_intact()
        resolved = self._resolve_findings(
            self._regex_findings(text),
            self._protected_spans(text),
        )
        redacted = text
        for finding in reversed(resolved):
            redacted = (
                redacted[: finding.start]
                + f"<{finding.entity_type}>"
                + redacted[finding.end :]
            )
        return RedactionResult(
            text=redacted,
            findings=resolved,
            report=RedactionReport(
                entity_counts=dict(
                    sorted(Counter(item.entity_type for item in resolved).items())
                ),
                text_values_processed=1,
                text_values_changed=int(bool(resolved)),
                detectors=("regex",),
            ),
        )

    def redact_external_identifier(self, text: str) -> RedactionResult:
        """Scan an untrusted identifier after delimiter normalization.

        Identifier syntax can otherwise hide a name from both NER tokenization
        and contextual regexes (for example ``ORD-Jane-1``).  A detected
        entity replaces the whole identifier; adapters can then HMAC the raw
        value with their corpus salt instead of persisting a partial token.
        """

        if not isinstance(text, str):
            raise TypeError("text must be a string")
        self._assert_policy_intact()
        if _PSEUDONYMOUS_ID_PATTERN.fullmatch(text):
            # This is already the irreversible, corpus-scoped representation
            # required at ingest.  Prose NER can spuriously classify arbitrary
            # hexadecimal substrings, so scan only deterministic rules here.
            return self.redact_identifier(text)
        deterministic = self.redact_identifier(text)
        if not deterministic.changed and _business_identifier_shape_safe(text):
            # A strict opaque-ID grammar is the structured identifier
            # allowlist.  It prevents contextual NER false positives on values
            # such as ``demo-013`` while mixed/title-cased name slugs remain
            # subject to the full normalized scan below.
            return deterministic
        direct = self.redact(text)
        normalized = re.sub(r"[._:/-]+", " ", text)
        regex_findings = self._regex_findings(normalized)
        findings = list(regex_findings)
        presidio_findings, presidio_used = self._presidio_findings(normalized)
        findings.extend(presidio_findings)
        resolved = self._resolve_findings(findings, ())
        if not resolved:
            return direct
        entity_type = max(
            (finding.entity_type for finding in resolved),
            key=lambda item: (_ENTITY_PRIORITY[item], item),
        )
        return RedactionResult(
            text=f"<{entity_type}>",
            findings=(
                RedactionFinding(
                    entity_type=entity_type,
                    start=0,
                    end=max(1, len(text)),
                    source=(
                        "regex+presidio"
                        if regex_findings and presidio_findings
                        else ("presidio" if presidio_findings else "regex")
                    ),
                ),
            ),
            report=RedactionReport(
                entity_counts={entity_type: 1},
                text_values_processed=1,
                text_values_changed=1,
                detectors=("presidio", "regex") if presidio_used else ("regex",),
            ),
        )

    def __call__(self, text: str) -> RedactionResult:
        return self.redact(text)

    def redact_message(self, message: Message) -> tuple[Message, RedactionReport]:
        result = self.redact(message.text)
        redacted_message = message.model_copy(
            update={"text": result.text, "redacted": True}, deep=True
        )
        message_report = RedactionReport(
            messages_processed=1,
            messages_changed=int(result.changed),
            detectors=result.report.detectors,
        )
        return redacted_message, result.report.merge(message_report)

    def _structured_signal_can_preserve(self, key: str, value: Any) -> bool:
        """Require both a strict shape and the full mandatory PII union."""

        if not _is_safe_structured_signal(key, value):
            return False
        normalized = _normalized_field_key(key)
        if normalized in _BUSINESS_ID_FIELD_KEYS and self.redact_external_identifier(
            str(value)
        ).changed:
            return False
        result = self.redact(str(value))
        # ISO currency codes can be contextual LOCATION false positives.  The
        # closed currency/amount grammar makes that one override unambiguous.
        allowed_entities = (
            {"ADDRESS"}
            if normalized in _CURRENCY_FIELD_KEYS | _AMOUNT_FIELD_KEYS
            else set()
        )
        return all(finding.entity_type in allowed_entities for finding in result.findings)

    def _authorized_product_references(
        self,
        value: Mapping[Any, Any],
    ) -> dict[str, str]:
        """Map exported product fields to independently safe sibling IDs."""

        normalized = {
            _normalized_field_key(key): item
            for key, item in value.items()
            if isinstance(key, str)
        }
        references: dict[str, str] = {}
        for product_key, companion_keys in _PRODUCT_ID_COMPANIONS.items():
            if product_key not in normalized:
                continue
            for companion in companion_keys:
                candidate = normalized.get(companion)
                if candidate is not None and self._structured_signal_can_preserve(
                    companion, candidate
                ):
                    references[product_key] = str(candidate).strip()
                    break
        return references

    def _redact_value(
        self,
        value: Any,
        *,
        field_entity: EntityType | None = None,
        field_key: str | None = None,
        allow_product_signals: bool = False,
        product_reference: str | None = None,
    ) -> tuple[Any, RedactionReport]:
        report = RedactionReport()
        if isinstance(value, str) and _PLACEHOLDER_PATTERN.fullmatch(value):
            return (
                value,
                RedactionReport(
                    text_values_processed=1,
                    detectors=("redaction-placeholder",),
                ),
            )
        if field_entity is not None and value is not None and not isinstance(
            value, (Mapping, list, tuple, set, frozenset)
        ):
            # Context-bearing structured keys such as ``date_of_birth`` or
            # ``passport`` make otherwise ambiguous scalars sensitive.  Do
            # not require the cue and value to have been concatenated in a
            # prose string before recognizing them.
            return (
                f"<{field_entity}>",
                RedactionReport(
                    entity_counts={field_entity: 1},
                    text_values_processed=1,
                    text_values_changed=1,
                    detectors=("structured-key",),
                ),
            )
        normalized_field = _normalized_field_key(field_key) if field_key else ""
        if (
            allow_product_signals
            and product_reference is not None
            and normalized_field in _PRODUCT_FIELD_KEYS
            and isinstance(value, str)
        ):
            catalog_name = next(
                (
                    name
                    for identifier, name in self.product_catalog
                    if identifier == product_reference
                ),
                None,
            )
            if (
                catalog_name is not None
                and value.strip().casefold() == catalog_name.casefold()
            ):
                return (
                    catalog_name,
                    RedactionReport(
                        text_values_processed=1,
                        text_values_changed=int(value != catalog_name),
                        detectors=("structured-product-catalog",),
                    ),
                )
            # Never persist a literal product name merely because a caller put
            # it under a trusted-looking key.  A separately scanned sibling
            # catalog ID retains product identity and mismatch signal without
            # creating a PERSON bypass.
            product_result = self.redact(value)
            return (
                f"product-ref:{product_reference}",
                RedactionReport(
                    entity_counts=product_result.report.entity_counts,
                    text_values_processed=1,
                    text_values_changed=1,
                    detectors=tuple(
                        sorted(
                            set(product_result.report.detectors)
                            | {"structured-product-reference"}
                        )
                    ),
                ),
            )
        if field_key is not None and self._structured_signal_can_preserve(
            field_key, value
        ):
            return (
                value,
                RedactionReport(
                    text_values_processed=1,
                    detectors=("structured-signal",),
                ),
            )
        if (
            normalized_field in _BUSINESS_ID_FIELD_KEYS
            and value is not None
            and not isinstance(value, (Mapping, list, tuple, set, frozenset))
        ):
            identifier_result = self.redact_external_identifier(str(value))
            if identifier_result.changed:
                return identifier_result.text, identifier_result.report
            return (
                "<BUSINESS_ID>",
                RedactionReport(
                    text_values_processed=1,
                    text_values_changed=1,
                    detectors=("structured-business-id",),
                ),
            )
        if isinstance(value, str):
            result = self.redact(value)
            return result.text, result.report
        if isinstance(value, (bytes, bytearray, memoryview)):
            try:
                decoded = bytes(value).decode("utf-8", errors="strict")
            except UnicodeDecodeError as exc:
                raise ValueError(
                    "binary values in canonical text fields must be valid UTF-8"
                ) from exc
            result = self.redact(decoded)
            return result.text, result.report
        if isinstance(value, Mapping):
            output: dict[Any, Any] = {}
            authorized_product_references = (
                self._authorized_product_references(value)
                if allow_product_signals
                else {}
            )
            for index, (key, item) in enumerate(value.items()):
                safe_key = key
                child_entity = _field_entity(key) if isinstance(key, str) else None
                # Known schema cues are not private values themselves.  Keep
                # the stable key so consumers can interpret the replacement;
                # redact its value using the structured context below.
                normalized_key = _normalized_field_key(key) if isinstance(key, str) else ""
                if (
                    isinstance(key, str)
                    and child_entity is None
                    and normalized_key not in _STRUCTURED_SCHEMA_KEYS
                ):
                    key_result = self.redact(key)
                    safe_key = key_result.text
                    report = report.merge(key_result.report)
                    if safe_key in output:
                        safe_key = f"{safe_key}_{index}"
                redacted, item_report = self._redact_value(
                    item,
                    field_entity=child_entity or field_entity,
                    field_key=key if isinstance(key, str) else field_key,
                    allow_product_signals=allow_product_signals,
                    product_reference=authorized_product_references.get(normalized_key),
                )
                output[safe_key] = redacted
                report = report.merge(item_report)
            return output, report
        if isinstance(value, list):
            output_list: list[Any] = []
            for item in value:
                redacted, item_report = self._redact_value(
                    item,
                    field_entity=field_entity,
                    field_key=field_key,
                    allow_product_signals=allow_product_signals,
                    product_reference=product_reference,
                )
                output_list.append(redacted)
                report = report.merge(item_report)
            return output_list, report
        if isinstance(value, tuple):
            output_tuple: list[Any] = []
            for item in value:
                redacted, item_report = self._redact_value(
                    item,
                    field_entity=field_entity,
                    field_key=field_key,
                    allow_product_signals=allow_product_signals,
                    product_reference=product_reference,
                )
                output_tuple.append(redacted)
                report = report.merge(item_report)
            return tuple(output_tuple), report
        if isinstance(value, (set, frozenset)):
            # Canonicalize unordered containers so their serialized form is
            # stable across Python hash seeds and processes.
            output_set: list[Any] = []
            for item in sorted(value, key=repr):
                redacted, item_report = self._redact_value(
                    item,
                    field_entity=field_entity,
                    field_key=field_key,
                    allow_product_signals=allow_product_signals,
                    product_reference=product_reference,
                )
                output_set.append(redacted)
                report = report.merge(item_report)
            return output_set, report
        if value is None or isinstance(value, bool):
            return value, report
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("canonical scalar values must be finite")
        if isinstance(value, (int, float, Decimal)):
            # JSON serializers turn these into persisted text/number tokens.
            # Scan their lexical form so a card or phone supplied as an integer
            # cannot bypass the string redaction path.
            result = self.redact_external_identifier(str(value))
            return (result.text if result.changed else value), result.report
        if isinstance(value, (date, datetime)):
            return value, report
        raise TypeError(
            f"unsupported canonical scalar type at redaction boundary: {type(value).__name__}"
        )

    def redact_value(self, value: Any) -> tuple[Any, RedactionReport]:
        """Recursively sanitize arbitrary JSON-like data at a shared boundary."""

        return self._redact_value(value)

    def redact_interaction(
        self, interaction: Interaction
    ) -> tuple[Interaction, RedactionReport]:
        """Redact every persisted free-text value in one interaction."""

        if not isinstance(interaction, Interaction):
            raise TypeError("interaction must be an Interaction")
        for field_name, value in (
            ("id", interaction.id),
            ("source_system", interaction.source_system),
        ):
            if field_name == "id":
                scan = self.redact_external_identifier(value)
                invalid_shape = False
            else:
                # Source systems are adapter-authored categorical slugs, not
                # prose.  Their closed syntax prevents person-like labels
                # without exposing safe vendor names to contextual NER.
                scan = self.redact_identifier(value)
                invalid_shape = _SCHEMA_LABEL_PATTERN.fullmatch(value) is None
            if scan.changed or invalid_shape:
                raise ValueError(
                    f"interaction structural field {field_name} contains PII; "
                    "pseudonymize it at ingest"
                )
        report = RedactionReport()

        messages: list[Message] = []
        for message in interaction.messages:
            redacted_message, message_report = self.redact_message(message)
            messages.append(redacted_message)
            report = report.merge(message_report)

        facts: list[StateFact] = []
        for fact in interaction.state_snapshot:
            for field_name, value in (("source", fact.source), ("kind", fact.kind)):
                if self.redact_identifier(value).changed or self.redact(value).changed:
                    raise ValueError(
                        f"state structural field {field_name} contains PII; "
                        "normalize it at ingest"
                    )
            fields, fields_report = self._redact_value(
                fact.fields,
                allow_product_signals=fact.provenance == "exported",
            )
            facts.append(fact.model_copy(update={"fields": fields}, deep=True))
            report = report.merge(fields_report)

        resolution: Resolution | None = None
        if interaction.resolution is not None:
            original_label, label_report = self._redact_value(
                interaction.resolution.original_label
            )
            actions, actions_report = self._redact_value(interaction.resolution.actions)
            closing_text, closing_report = self._redact_value(
                interaction.resolution.closing_text
            )
            resolution = interaction.resolution.model_copy(
                update={
                    "original_label": original_label,
                    "actions": actions,
                    "closing_text": closing_text,
                },
                deep=True,
            )
            report = report.merge(label_report, actions_report, closing_report)

        metadata, metadata_report = self._redact_value(interaction.metadata)
        report = report.merge(metadata_report)
        redacted_interaction = interaction.model_copy(
            update={
                "messages": messages,
                "state_snapshot": facts,
                "resolution": resolution,
                "metadata": metadata,
            },
            deep=True,
        )
        return redacted_interaction, report


__all__ = [
    "RedactionFinding",
    "RedactionReport",
    "RedactionResult",
    "Redactor",
    "is_structured_schema_key",
]
