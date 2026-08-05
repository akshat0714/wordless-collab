from __future__ import annotations

from collections import Counter
import json
from pathlib import Path

import pytest

from bench.pairs import (
    CATEGORIES,
    DatasetValidationError,
    load_dataset,
    load_pairs,
    load_target_catalog,
)


DATA_DIR = Path(__file__).resolve().parents[2] / "bench" / "data"
PAIRS_PATH = DATA_DIR / "circumlocution.jsonl"
TARGETS_PATH = DATA_DIR / "targets.json"


def test_packaged_pairs_and_target_pools_load_with_gate_constraints() -> None:
    dataset = load_dataset(PAIRS_PATH, TARGETS_PATH)

    assert dataset.sample_size == 128
    assert dataset.catalog.authorship == "hand-authored"
    assert dataset.categories == tuple(sorted(CATEGORIES))
    assert dataset.domains == ("account", "billing", "education", "retail")
    assert Counter(pair.category for pair in dataset.pairs) == {
        category: 32 for category in CATEGORIES
    }
    assert Counter(pair.domain for pair in dataset.pairs) == {
        domain: 32 for domain in dataset.domains
    }
    assert all(len(pool) == 20 for pool in dataset.candidate_pools.values())
    assert dataset.fingerprint == load_dataset(PAIRS_PATH).fingerprint


def test_target_ids_are_domain_local_not_global() -> None:
    catalog = load_target_catalog(TARGETS_PATH)

    retail_refund = next(
        target
        for target in catalog.for_domain("retail")
        if target.target == "refund_not_received"
    )
    billing_refund = next(
        target
        for target in catalog.for_domain("billing")
        if target.target == "refund_not_received"
    )

    assert retail_refund.description != billing_refund.description
    assert retail_refund in catalog.for_domain("retail")
    assert billing_refund in catalog.for_domain("billing")


def test_pair_loader_rejects_target_outside_its_domain_pool(tmp_path: Path) -> None:
    pairs_path = tmp_path / "pairs.jsonl"
    pairs_path.write_text(
        json.dumps(
            {
                "id": "bad-target",
                "fragment": "the money one twice",
                "target": "definitely_not_a_billing_target",
                "category": "object_circumlocution",
                "domain": "billing",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    catalog = load_target_catalog(TARGETS_PATH)
    with pytest.raises(DatasetValidationError, match="fixed candidate pool"):
        load_pairs(pairs_path, catalog=catalog)


def test_pair_loader_rejects_duplicate_ids(tmp_path: Path) -> None:
    pair = {
        "id": "duplicate",
        "fragment": "still not come",
        "target": "late_delivery",
        "category": "telegraphic",
        "domain": "retail",
    }
    pairs_path = tmp_path / "pairs.jsonl"
    pairs_path.write_text(
        "\n".join((json.dumps(pair), json.dumps(pair))) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(DatasetValidationError, match="duplicate pair id"):
        load_pairs(pairs_path)


def test_target_loader_rejects_duplicate_ids_within_a_domain(
    tmp_path: Path,
) -> None:
    catalog_path = tmp_path / "targets.json"
    catalog_path.write_text(
        json.dumps(
            {
                "version": 1,
                "authorship": "test fixture",
                "domains": {
                    "retail": [
                        {
                            "target": "same",
                            "description": "First description.",
                            "variants": [],
                        },
                        {
                            "target": "same",
                            "description": "Second description.",
                            "variants": [],
                        },
                    ]
                },
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(DatasetValidationError, match="duplicate target ids"):
        load_target_catalog(catalog_path, min_candidates=2, max_candidates=2)

