"""Validated data contracts for the circumlocution benchmark.

The benchmark deliberately keeps examples and candidate targets in separate
files.  A pair may only refer to a target in its domain's fixed candidate pool;
silently deriving candidates from the examples would make precision numbers
change when examples are added.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from hashlib import sha256
import json
from pathlib import Path
from types import MappingProxyType
from typing import Any, Iterable, Mapping, Sequence


CATEGORIES = (
    "object_circumlocution",
    "action_circumlocution",
    "semantic_substitution",
    "telegraphic",
)
TEXT_MODES = ("description", "enriched")


class DatasetValidationError(ValueError):
    """Raised when benchmark input is malformed or methodologically unsafe."""


@dataclass(frozen=True)
class BenchmarkPair:
    """One hand-authored fragment and its expected domain-local target."""

    id: str
    fragment: str
    target: str
    category: str
    domain: str

    def to_dict(self) -> dict[str, str]:
        return {
            "id": self.id,
            "fragment": self.fragment,
            "target": self.target,
            "category": self.category,
            "domain": self.domain,
        }


@dataclass(frozen=True)
class Target:
    """A candidate target and the text methods are allowed to rank."""

    target: str
    description: str
    variants: tuple[str, ...] = ()

    def text(self, mode: str = "description") -> str:
        """Return candidate text for a declared, consistently applied mode.

        ``description`` is the fair initial gate: every method sees only the
        same target description.  ``enriched`` appends hand-authored variants
        and must be reported as a distinct rerun.
        """

        if mode not in TEXT_MODES:
            raise ValueError(
                f"unknown candidate text mode {mode!r}; expected one of {TEXT_MODES}"
            )
        if mode == "description" or not self.variants:
            return self.description
        return "\n".join((self.description, *self.variants))

    def to_dict(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "description": self.description,
            "variants": list(self.variants),
        }


@dataclass(frozen=True)
class TargetCatalog:
    """Fixed candidate pools keyed by domain."""

    version: int
    authorship: str
    domains: Mapping[str, tuple[Target, ...]]

    def __post_init__(self) -> None:
        frozen = {
            domain: tuple(targets) for domain, targets in sorted(self.domains.items())
        }
        object.__setattr__(self, "domains", MappingProxyType(frozen))

    def for_domain(self, domain: str) -> tuple[Target, ...]:
        try:
            return self.domains[domain]
        except KeyError as exc:
            known = ", ".join(sorted(self.domains))
            raise DatasetValidationError(
                f"unknown domain {domain!r}; catalog domains: {known}"
            ) from exc

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "authorship": self.authorship,
            "domains": {
                domain: [target.to_dict() for target in targets]
                for domain, targets in self.domains.items()
            },
        }


@dataclass(frozen=True)
class BenchmarkDataset:
    """A validated benchmark and the immutable pools it is scored against."""

    pairs: tuple[BenchmarkPair, ...]
    catalog: TargetCatalog
    pairs_path: Path
    targets_path: Path
    fingerprint: str

    @property
    def candidate_pools(self) -> Mapping[str, tuple[Target, ...]]:
        return self.catalog.domains

    @property
    def sample_size(self) -> int:
        return len(self.pairs)

    @property
    def categories(self) -> tuple[str, ...]:
        return tuple(sorted({pair.category for pair in self.pairs}))

    @property
    def domains(self) -> tuple[str, ...]:
        return tuple(sorted({pair.domain for pair in self.pairs}))


def _nonempty_string(value: Any, *, field: str, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DatasetValidationError(f"{location}: {field} must be a non-empty string")
    if value != value.strip():
        raise DatasetValidationError(
            f"{location}: {field} must not have leading or trailing whitespace"
        )
    return value


def _check_keys(
    value: Mapping[str, Any],
    *,
    required: Iterable[str],
    allowed: Iterable[str],
    location: str,
) -> None:
    required_set = set(required)
    allowed_set = set(allowed)
    missing = sorted(required_set - set(value))
    extra = sorted(set(value) - allowed_set)
    if missing:
        raise DatasetValidationError(f"{location}: missing fields: {', '.join(missing)}")
    if extra:
        raise DatasetValidationError(f"{location}: unknown fields: {', '.join(extra)}")


def _reject_duplicate_json_keys(items: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise DatasetValidationError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _parse_json(text: str, *, location: str) -> Any:
    try:
        return json.loads(text, object_pairs_hook=_reject_duplicate_json_keys)
    except DatasetValidationError as exc:
        raise DatasetValidationError(f"{location}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise DatasetValidationError(
            f"{location}: invalid JSON at column {exc.colno}: {exc.msg}"
        ) from exc


def _parse_pair(value: Any, *, location: str) -> BenchmarkPair:
    if not isinstance(value, dict):
        raise DatasetValidationError(f"{location}: each JSONL row must be an object")
    fields = ("id", "fragment", "target", "category", "domain")
    _check_keys(value, required=fields, allowed=fields, location=location)
    pair = BenchmarkPair(
        id=_nonempty_string(value["id"], field="id", location=location),
        fragment=_nonempty_string(value["fragment"], field="fragment", location=location),
        target=_nonempty_string(value["target"], field="target", location=location),
        category=_nonempty_string(value["category"], field="category", location=location),
        domain=_nonempty_string(value["domain"], field="domain", location=location),
    )
    if pair.category not in CATEGORIES:
        raise DatasetValidationError(
            f"{location}: unknown category {pair.category!r}; expected one of {CATEGORIES}"
        )
    return pair


def load_pairs(
    path: str | Path,
    *,
    catalog: TargetCatalog | None = None,
    min_pairs: int = 1,
    require_all_categories: bool = False,
    balance_tolerance: float | None = None,
) -> tuple[BenchmarkPair, ...]:
    """Load JSONL pairs in file order and validate their labels.

    Pass a catalog to reject domain/target labels outside the fixed pools.
    ``balance_tolerance`` is the allowed relative deviation from an even
    category split (for example, ``0.25`` permits +/-25 percent).
    """

    source = Path(path)
    if min_pairs < 1:
        raise ValueError("min_pairs must be at least 1")
    if balance_tolerance is not None and not 0 <= balance_tolerance < 1:
        raise ValueError("balance_tolerance must be in [0, 1)")
    try:
        raw_lines = source.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise DatasetValidationError(f"cannot read pair file {source}: {exc}") from exc

    pairs: list[BenchmarkPair] = []
    seen_ids: set[str] = set()
    for line_number, raw_line in enumerate(raw_lines, start=1):
        if not raw_line.strip():
            continue
        location = f"{source}:{line_number}"
        pair = _parse_pair(_parse_json(raw_line, location=location), location=location)
        if pair.id in seen_ids:
            raise DatasetValidationError(f"{location}: duplicate pair id {pair.id!r}")
        seen_ids.add(pair.id)
        if catalog is not None:
            candidates = catalog.for_domain(pair.domain)
            known_targets = {candidate.target for candidate in candidates}
            if pair.target not in known_targets:
                raise DatasetValidationError(
                    f"{location}: target {pair.target!r} is not in the fixed "
                    f"candidate pool for domain {pair.domain!r}"
                )
        pairs.append(pair)

    if len(pairs) < min_pairs:
        raise DatasetValidationError(
            f"{source}: expected at least {min_pairs} pairs, found {len(pairs)}"
        )

    counts = Counter(pair.category for pair in pairs)
    if require_all_categories:
        missing = [category for category in CATEGORIES if not counts[category]]
        if missing:
            raise DatasetValidationError(
                f"{source}: missing required categories: {', '.join(missing)}"
            )
    if balance_tolerance is not None:
        if any(not counts[category] for category in CATEGORIES):
            raise DatasetValidationError(
                f"{source}: cannot be balanced without all four required categories"
            )
        expected = len(pairs) / len(CATEGORIES)
        for category in CATEGORIES:
            relative_deviation = abs(counts[category] - expected) / expected
            if relative_deviation > balance_tolerance:
                raise DatasetValidationError(
                    f"{source}: category {category!r} has {counts[category]} pairs; "
                    f"an even split is {expected:g} and tolerance is "
                    f"{balance_tolerance:.0%}"
                )
    return tuple(pairs)


def _parse_target(value: Any, *, location: str) -> Target:
    if not isinstance(value, dict):
        raise DatasetValidationError(f"{location}: target must be an object")
    fields = ("target", "description", "variants")
    _check_keys(value, required=fields, allowed=fields, location=location)
    variants_raw = value["variants"]
    if not isinstance(variants_raw, list):
        raise DatasetValidationError(f"{location}: variants must be an array of strings")
    variants = tuple(
        _nonempty_string(item, field=f"variants[{index}]", location=location)
        for index, item in enumerate(variants_raw)
    )
    if len(set(variants)) != len(variants):
        raise DatasetValidationError(f"{location}: variants must not contain duplicates")
    return Target(
        target=_nonempty_string(value["target"], field="target", location=location),
        description=_nonempty_string(
            value["description"], field="description", location=location
        ),
        variants=variants,
    )


def load_target_catalog(
    path: str | Path,
    *,
    min_candidates: int = 20,
    max_candidates: int = 30,
) -> TargetCatalog:
    """Load and validate explicit domain candidate pools."""

    source = Path(path)
    if min_candidates < 1:
        raise ValueError("min_candidates must be at least 1")
    if max_candidates < min_candidates:
        raise ValueError("max_candidates must be >= min_candidates")
    try:
        raw = source.read_text(encoding="utf-8")
    except OSError as exc:
        raise DatasetValidationError(f"cannot read target catalog {source}: {exc}") from exc
    value = _parse_json(raw, location=str(source))
    if not isinstance(value, dict):
        raise DatasetValidationError(f"{source}: catalog must be a JSON object")
    fields = ("version", "authorship", "domains")
    _check_keys(value, required=fields, allowed=fields, location=str(source))
    if not isinstance(value["version"], int) or isinstance(value["version"], bool):
        raise DatasetValidationError(f"{source}: version must be an integer")
    authorship = _nonempty_string(
        value["authorship"], field="authorship", location=str(source)
    )
    domains_raw = value["domains"]
    if not isinstance(domains_raw, dict) or not domains_raw:
        raise DatasetValidationError(f"{source}: domains must be a non-empty object")

    domains: dict[str, tuple[Target, ...]] = {}
    for domain, targets_raw in domains_raw.items():
        domain_name = _nonempty_string(domain, field="domain", location=str(source))
        location = f"{source}:domains.{domain_name}"
        if not isinstance(targets_raw, list):
            raise DatasetValidationError(f"{location}: candidate pool must be an array")
        if not min_candidates <= len(targets_raw) <= max_candidates:
            raise DatasetValidationError(
                f"{location}: expected {min_candidates}-{max_candidates} candidates, "
                f"found {len(targets_raw)}"
            )
        targets = tuple(
            _parse_target(item, location=f"{location}[{index}]")
            for index, item in enumerate(targets_raw)
        )
        target_ids = [target.target for target in targets]
        duplicates = sorted(
            target for target, count in Counter(target_ids).items() if count > 1
        )
        if duplicates:
            raise DatasetValidationError(
                f"{location}: duplicate target ids: {', '.join(duplicates)}"
            )
        descriptions = [target.description for target in targets]
        if len(set(descriptions)) != len(descriptions):
            raise DatasetValidationError(
                f"{location}: target descriptions must be unique within a domain"
            )
        domains[domain_name] = targets

    return TargetCatalog(
        version=value["version"], authorship=authorship, domains=domains
    )


def _fingerprint(pairs: Sequence[BenchmarkPair], catalog: TargetCatalog) -> str:
    canonical = {
        "pairs": [pair.to_dict() for pair in pairs],
        "catalog": catalog.to_dict(),
    }
    payload = json.dumps(
        canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return sha256(payload).hexdigest()


def load_benchmark(
    pairs_path: str | Path,
    targets_path: str | Path | None = None,
    *,
    min_pairs: int = 100,
    min_candidates: int = 20,
    max_candidates: int = 30,
    require_balanced: bool = True,
    balance_tolerance: float = 0.25,
) -> BenchmarkDataset:
    """Load a gate-ready benchmark with the spec's default constraints."""

    pairs_source = Path(pairs_path)
    targets_source = (
        Path(targets_path)
        if targets_path is not None
        else pairs_source.with_name("targets.json")
    )
    catalog = load_target_catalog(
        targets_source,
        min_candidates=min_candidates,
        max_candidates=max_candidates,
    )
    pairs = load_pairs(
        pairs_source,
        catalog=catalog,
        min_pairs=min_pairs,
        require_all_categories=require_balanced,
        balance_tolerance=balance_tolerance if require_balanced else None,
    )
    return BenchmarkDataset(
        pairs=pairs,
        catalog=catalog,
        pairs_path=pairs_source.resolve(),
        targets_path=targets_source.resolve(),
        fingerprint=_fingerprint(pairs, catalog),
    )


# A readable alias for callers that treat this as a dataset loader.
load_dataset = load_benchmark


__all__ = [
    "BenchmarkDataset",
    "BenchmarkPair",
    "CATEGORIES",
    "DatasetValidationError",
    "TEXT_MODES",
    "Target",
    "TargetCatalog",
    "load_benchmark",
    "load_dataset",
    "load_pairs",
    "load_target_catalog",
]
