from __future__ import annotations

import json
from pathlib import Path
import shutil

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from wordless.api.main import ApiSettings, create_app


REPOSITORY = Path(__file__).resolve().parents[2]
CANONICAL_BENCHMARK = REPOSITORY / "bench" / "results" / "benchmark.json"


def configured_workspace(tmp_path: Path, *, copy_benchmark: bool = True) -> ApiSettings:
    destination = tmp_path / "bench" / "results" / "benchmark.json"
    destination.parent.mkdir(parents=True)
    if copy_benchmark:
        shutil.copyfile(CANONICAL_BENCHMARK, destination)
    return ApiSettings(
        workspace=tmp_path,
        benchmark_result=Path("bench/results/benchmark.json"),
    )


def test_health_declares_local_read_only_boundary(tmp_path: Path) -> None:
    settings = configured_workspace(tmp_path)
    with TestClient(create_app(settings=settings, environ={})) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "mode": "local-read-only",
        "customer_write_access": "none",
        "persistent_review_writes": False,
        "workspace_ready": True,
        "benchmark_available": True,
        "message": (
            "This local API has no capability to write to a customer system or "
            "persist review decisions."
        ),
    }
    assert response.headers["x-wordless-mode"] == "local-read-only"
    assert response.headers["x-wordless-customer-write"] == "none"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_factory_validates_core_configuration_at_startup(tmp_path: Path) -> None:
    settings = configured_workspace(tmp_path)

    with pytest.raises(ValidationError, match="must be set together"):
        create_app(
            settings=settings,
            environ={"WORDLESS_LLM_PROVIDER": "provider-without-model"},
        )


def test_settings_require_an_existing_workspace(tmp_path: Path) -> None:
    missing = tmp_path / "not-created"

    with pytest.raises(ValidationError, match="existing directory"):
        ApiSettings(workspace=missing)


@pytest.mark.parametrize("candidate", ["../outside.json", "../../etc/passwd"])
def test_benchmark_configuration_rejects_parent_traversal(
    tmp_path: Path, candidate: str
) -> None:
    with pytest.raises(ValidationError, match="inside WORDLESS_WORKSPACE"):
        ApiSettings(workspace=tmp_path, benchmark_result=Path(candidate))


def test_benchmark_configuration_rejects_symlink_escape(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text("{}", encoding="utf-8")
    link = workspace / "benchmark.json"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks are unavailable on this platform")

    with pytest.raises(ValidationError, match="inside WORDLESS_WORKSPACE"):
        ApiSettings(workspace=workspace, benchmark_result=Path("benchmark.json"))


def test_benchmark_endpoint_returns_the_canonical_artifact_and_digest(
    tmp_path: Path,
) -> None:
    settings = configured_workspace(tmp_path)
    expected = json.loads(CANONICAL_BENCHMARK.read_text(encoding="utf-8"))
    with TestClient(create_app(settings=settings, environ={})) as client:
        response = client.get("/api/benchmark")

    assert response.status_code == 200
    assert response.json() == expected
    assert response.json()["gate"]["decision"] == "PASS"
    assert response.json()["dataset"]["n_pairs"] == 128
    assert response.headers["x-wordless-artifact"] == "bench/results/benchmark.json"
    assert response.headers["etag"].startswith('"sha256-')
    assert response.headers["x-wordless-customer-write"] == "none"


def test_missing_benchmark_reports_safe_unavailable_error(tmp_path: Path) -> None:
    settings = configured_workspace(tmp_path, copy_benchmark=False)
    with TestClient(create_app(settings=settings, environ={})) as client:
        response = client.get("/api/benchmark")

    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "not_found"
    assert str(tmp_path) not in response.text
    assert response.headers["x-wordless-customer-write"] == "none"


def test_duplicate_json_keys_are_rejected_before_schema_validation(tmp_path: Path) -> None:
    settings = configured_workspace(tmp_path, copy_benchmark=False)
    settings.benchmark_result.write_text(
        '{"candidate_text_mode":"description","candidate_text_mode":"enriched"}',
        encoding="utf-8",
    )
    with TestClient(create_app(settings=settings, environ={})) as client:
        response = client.get("/api/benchmark")

    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "duplicate_json_key"


def test_schema_tampering_is_rejected_without_echoing_artifact_contents(
    tmp_path: Path,
) -> None:
    settings = configured_workspace(tmp_path)
    value = json.loads(settings.benchmark_result.read_text(encoding="utf-8"))
    value["dataset"]["n_pairs"] = "128"
    value["unexpected"] = "must not escape"
    settings.benchmark_result.write_text(json.dumps(value), encoding="utf-8")
    with TestClient(create_app(settings=settings, environ={})) as client:
        response = client.get("/api/benchmark")

    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "invalid_schema"
    assert "must not escape" not in response.text


def test_benchmark_size_limit_is_enforced_before_json_parsing(tmp_path: Path) -> None:
    path = tmp_path / "large.json"
    path.write_bytes(b"{" + b" " * 100 + b"}")
    settings = ApiSettings(
        workspace=tmp_path,
        benchmark_result=Path("large.json"),
        max_benchmark_bytes=32,
    )
    with TestClient(create_app(settings=settings, environ={})) as client:
        response = client.get("/api/benchmark")

    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "too_large"


def test_adapters_list_exactly_five_export_only_sources(tmp_path: Path) -> None:
    settings = configured_workspace(tmp_path)
    with TestClient(create_app(settings=settings, environ={})) as client:
        response = client.get("/api/adapters")

    value = response.json()
    assert response.status_code == 200
    assert value["count"] == 5
    assert [item["id"] for item in value["adapters"]] == [
        "zendesk",
        "intercom",
        "chatwoot",
        "zammad",
        "generic",
    ]
    assert all(item["direction"] == "export-read-only" for item in value["adapters"])
    assert value["adapters"][-1]["mapping_required"] is True
    assert value["customer_write_access"] == "none"


def test_detector_definitions_include_status_and_both_denominators(tmp_path: Path) -> None:
    settings = configured_workspace(tmp_path)
    with TestClient(create_app(settings=settings, environ={})) as client:
        response = client.get("/api/detectors")

    value = response.json()
    assert response.status_code == 200
    assert value["corpus_denominator"] == 30
    assert {item["status"] for item in value["detectors"]} == {"confirmed"}
    for detector in value["detectors"]:
        assert detector["support"] <= detector["support_denominator"] == 30
        assert detector["precision_correct"] <= detector["precision_sample_size"]
        assert detector["precision_estimate"] == pytest.approx(
            detector["precision_correct"] / detector["precision_sample_size"]
        )
        assert detector["runnable"] is (detector["status"] == "confirmed")
        assert detector["measurement_basis"].startswith("synthetic fixture assertions")
    assert value["review_mode"] == "stateless-validation-only"


def test_review_endpoint_validates_and_echoes_without_mutating_fixture_or_file(
    tmp_path: Path,
) -> None:
    settings = configured_workspace(tmp_path)
    initial_bytes = settings.benchmark_result.read_bytes()
    with TestClient(create_app(settings=settings, environ={})) as client:
        before = client.get("/api/detectors").json()
        response = client.post(
            "/api/detectors/wrong_item/review",
            json={
                "decision": "approved",
                "precision_correct": 6,
                "precision_sample_size": 6,
                "proposed_condition": (
                    "The delivered SKU differs from every SKU recorded on the order."
                ),
            },
        )
        after = client.get("/api/detectors").json()

    assert response.status_code == 200
    assert response.json() == {
        "detector_id": "wrong_item",
        "validated": True,
        "decision": "approved",
        "would_set_status": "confirmed",
        "precision_correct": 6,
        "precision_sample_size": 6,
        "precision_estimate": 1.0,
        "proposed_condition": (
            "The delivered SKU differs from every SKU recorded on the order."
        ),
        "persisted": False,
        "external_write_attempted": False,
        "message": (
            "This local API has no capability to write to a customer system or "
            "persist review decisions."
        ),
    }
    assert before == after
    assert settings.benchmark_result.read_bytes() == initial_bytes
    assert response.headers["x-wordless-customer-write"] == "none"


@pytest.mark.parametrize(
    ("detector_id", "payload", "status"),
    [
        (
            "wrong_item",
            {"decision": "approved", "precision_correct": 21, "precision_sample_size": 20},
            422,
        ),
        (
            "account_lock",
            {"decision": "approved", "precision_correct": 1, "precision_sample_size": 194},
            422,
        ),
        (
            "wrong_item",
            {
                "decision": "approved",
                "precision_correct": 1,
                "precision_sample_size": 2,
                "persist": True,
            },
            422,
        ),
        (
            "not_a_fixture",
            {"decision": "rejected", "precision_correct": 0, "precision_sample_size": 1},
            404,
        ),
    ],
)
def test_review_rejects_invalid_or_unknown_requests(
    tmp_path: Path, detector_id: str, payload: dict[str, object], status: int
) -> None:
    settings = configured_workspace(tmp_path)
    with TestClient(create_app(settings=settings, environ={})) as client:
        response = client.post(f"/api/detectors/{detector_id}/review", json=payload)

    assert response.status_code == status
    assert response.headers["x-wordless-customer-write"] == "none"


def parse_sse(content: bytes) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for block in content.decode("utf-8").strip().split("\n\n"):
        fields: dict[str, object] = {}
        for line in block.splitlines():
            name, value = line.split(": ", 1)
            fields[name] = json.loads(value) if name == "data" else value
        records.append(fields)
    return records


def test_fixture_sse_is_immediate_deterministic_completed_measurement(
    tmp_path: Path,
) -> None:
    settings = configured_workspace(tmp_path)
    with TestClient(create_app(settings=settings, environ={})) as client:
        first = client.get("/api/runs/fixture/events")
        second = client.get("/api/runs/fixture/events")

    assert first.status_code == 200
    assert first.content == second.content
    assert first.headers["content-type"].startswith("text/event-stream")
    assert first.headers["cache-control"] == "no-cache, no-transform"
    assert first.headers["x-accel-buffering"] == "no"
    assert first.headers["x-wordless-customer-write"] == "none"

    records = parse_sse(first.content)
    assert len(records) == 7
    stages = records[:6]
    assert [record["event"] for record in stages] == ["stage.completed"] * 6
    assert [record["data"]["stage"] for record in stages] == [  # type: ignore[index]
        "validate_export",
        "redact_personal_data",
        "reconstruct_state",
        "evaluate_detectors",
        "rerank_and_abstain",
        "build_audit_report",
    ]
    assert all(record["data"]["elapsed_seconds"] is None for record in stages)  # type: ignore[index]
    assert all(record["data"]["status"] == "completed" for record in stages)  # type: ignore[index]
    assert all(record["data"]["measured"] is False for record in stages)  # type: ignore[index]
    assert all(
        record["data"]["measurement_basis"].startswith("deterministic synthetic fixture")  # type: ignore[index]
        for record in stages
    )
    assert records[-1]["event"] == "run.completed"
    assert records[-1]["data"]["elapsed_seconds"] is None  # type: ignore[index]
    assert records[-1]["data"]["measured"] is False  # type: ignore[index]


def test_only_review_validation_uses_post_and_no_mutation_verbs_exist(
    tmp_path: Path,
) -> None:
    settings = configured_workspace(tmp_path)
    application = create_app(settings=settings, environ={})
    methods = {
        route.path: set(route.methods or ())
        for route in application.routes
        if route.path.startswith("/api/")
    }

    assert methods["/api/detectors/{detector_id}/review"] == {"POST"}
    assert all(not ({"PUT", "PATCH", "DELETE"} & route_methods) for route_methods in methods.values())
    assert all(
        route_methods == {"GET"}
        for path, route_methods in methods.items()
        if path != "/api/detectors/{detector_id}/review"
    )
