from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import stat
from types import ModuleType, SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[2]


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BOOTSTRAP = _load(
    "wordless_zendesk_bootstrap_test",
    ROOT / "deploy" / "zendesk" / "bootstrap.py",
)
SMOKE = _load(
    "wordless_zendesk_smoke_test",
    ROOT / "deploy" / "zendesk" / "smoke.py",
)


def _bootstrap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def secret(label: str, **_: object) -> str:
        if label.endswith("key ID"):
            return "test-key-id"
        if label.endswith("key secret"):
            return "z" * 40
        return "w" * 40

    monkeypatch.setattr(BOOTSTRAP, "prompt_secret", secret)
    monkeypatch.setattr(
        BOOTSTRAP.sys,
        "stdin",
        SimpleNamespace(isatty=lambda: True),
    )
    result = BOOTSTRAP.main(
        [
            "--public-domain",
            "wordless-sandbox.example.com",
            "--installation-id",
            "acme_sandbox",
            "--zendesk-subdomain",
            "acme-sandbox",
            "--zendesk-app-id",
            "app-1",
            "--zendesk-webhook-id",
            "webhook-1",
            "--zendesk-switchboard-integration-id",
            "switchboard-1",
            "--zendesk-underlying-integration-id",
            "integration-1",
            "--zendesk-human-switchboard-integration-id",
            "agent-workspace-1",
            "--evidence-resolver-url",
            "https://support-api.example.com/wordless/evidence",
            "--threshold",
            "1.6",
            "--threshold-version",
            "acme-eval-2026-07-30",
            "--output-dir",
            str(tmp_path),
        ]
    )
    assert result == 0


def test_bootstrap_creates_only_referenced_file_secrets(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _bootstrap(tmp_path, monkeypatch)
    environment = tmp_path / ".env.production"
    secrets_dir = tmp_path / "secrets"
    assert stat.S_IMODE(secrets_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(environment.stat().st_mode) == 0o600
    assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in secrets_dir.iterdir())

    installation = json.loads((secrets_dir / "installations.json").read_text())[0]
    assert installation["webhookAuth"] == {
        "mode": "x_api_key",
        "secretRef": "ZENDESK_WEBHOOK_SECRET",
    }
    assert installation["humanSwitchboardIntegrationId"] == "agent-workspace-1"
    serialized = json.dumps(installation)
    assert "w" * 40 not in serialized
    assert "z" * 40 not in serialized
    assert "PUBLIC_DOMAIN=wordless-sandbox.example.com" in environment.read_text()
    assert "SUPPORTED_LOCALE_PREFIXES=en" in environment.read_text()
    assert "REQUIRE_KNOWN_LOCALE=true" in environment.read_text()


def test_bootstrap_refuses_overwrite_and_placeholder_threshold(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _bootstrap(tmp_path, monkeypatch)
    with pytest.raises(BOOTSTRAP.BootstrapError, match="refusing to overwrite"):
        _bootstrap(tmp_path, monkeypatch)
    with pytest.raises(Exception):
        BOOTSTRAP.threshold_version("demo-floor-v1")


def test_bootstrap_refuses_wordless_as_the_human_route(tmp_path: Path) -> None:
    with pytest.raises(BOOTSTRAP.BootstrapError, match="must differ"):
        BOOTSTRAP.main(
            [
                "--public-domain", "wordless-sandbox.example.com",
                "--installation-id", "acme_sandbox",
                "--zendesk-subdomain", "acme-sandbox",
                "--zendesk-app-id", "app-1",
                "--zendesk-webhook-id", "webhook-1",
                "--zendesk-switchboard-integration-id", "same-entry",
                "--zendesk-underlying-integration-id", "integration-1",
                "--zendesk-human-switchboard-integration-id", "same-entry",
                "--evidence-resolver-url", "https://support-api.example.com/wordless/evidence",
                "--threshold", "1.6",
                "--threshold-version", "acme-eval-2026-07-30",
                "--output-dir", str(tmp_path),
            ]
        )


def test_smoke_rejects_readable_secret_file(tmp_path: Path) -> None:
    value = tmp_path / "secret"
    value.write_text("not-a-secret", encoding="utf-8")
    value.chmod(0o644)
    with pytest.raises(SMOKE.SmokeError, match="group/other permissions"):
        SMOKE.secure_read(value)


def test_smoke_flow_uses_secret_file_and_accepts_no_customer_event(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _bootstrap(tmp_path, monkeypatch)
    calls: list[tuple[str, str, dict[str, str], bytes | None]] = []
    responses = iter(
        [
            (200, b'{"status":"ok"}'),
            (200, b'{"status":"ready"}'),
            (404, b""),
            (404, b""),
            (204, b""),
            (400, b""),
        ]
    )

    def request(
        _domain: str,
        _timeout: float,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        body: bytes | None = None,
    ) -> tuple[int, bytes]:
        calls.append((method, path, headers or {}, body))
        return next(responses)

    monkeypatch.setattr(SMOKE, "request", request)
    assert SMOKE.main(
        ["--confirm-sandbox", "--deployment-dir", str(tmp_path)]
    ) == 0
    assert [call[0] for call in calls] == ["GET", "GET", "HEAD", "HEAD", "HEAD", "POST"]
    assert calls[-1][3] == b"{"
    assert not any(call[3] and b"events" in call[3] for call in calls)
    output = capsys.readouterr().out
    assert "Sandbox smoke checks passed" in output
    assert "w" * 40 not in output
