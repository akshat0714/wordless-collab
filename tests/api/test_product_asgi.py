from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from wordless.api import product_asgi
from wordless.realtime.service import ProductRuntime


class _WarmedRuntimeStub:
    detector_set_version = "det_0000000000000000"


def _production_environment(tmp_path: Path) -> dict[str, str]:
    return {
        "WORDLESS_REALTIME_DEV_MODE": "false",
        "WORDLESS_REALTIME_WORKSPACE": str(tmp_path),
        "WORDLESS_REALTIME_DATABASE_PATH": "pilot.sqlite3",
        "WORDLESS_REALTIME_MODEL_CACHE_DIR": "model-cache",
        "WORDLESS_REALTIME_EMBED_MODEL_ID": "sentence-transformers/all-MiniLM-L6-v2",
        "WORDLESS_REALTIME_EMBED_MODEL_REVISION": (
            "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
        ),
        "WORDLESS_REALTIME_THRESHOLD": "1.6",
        "WORDLESS_REALTIME_THRESHOLD_VERSION": "tenant-evaluation-2026-07-25",
        "WORDLESS_REALTIME_TENANTS_JSON": json.dumps(
            {
                "acme": {
                    "api_keys": [
                        {
                            "id": "acme01",
                            "secret": "api-secret-0123456789-abcdefghijkl",
                            "scopes": [
                                "suggestions:read",
                                "suggestions:write",
                                "feedback:write",
                            ],
                        }
                    ],
                    "customer_hmac_key": (
                        "customer-hmac-0123456789-abcdefghijkl"
                    ),
                    "signing_secrets": [
                        "signing-secret-0123456789-abcdefghijkl"
                    ],
                }
            }
        ),
        "WORDLESS_REALTIME_API_KEY_PEPPER": (
            "api-key-pepper-0123456789-abcdefghijkl"
        ),
    }


def test_production_asgi_factory_builds_from_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        ProductRuntime,
        "from_settings",
        classmethod(lambda cls, settings: _WarmedRuntimeStub()),
    )

    app = product_asgi.create_app(_production_environment(tmp_path))

    assert app.state.product_settings.dev_mode is False
    assert app.state.product_settings.threshold == 1.6
    assert (
        app.state.product_settings.threshold_version
        == "tenant-evaluation-2026-07-25"
    )
    with TestClient(app) as client:
        live = client.get("/health/live")
        ready = client.get("/health/ready")
    assert live.status_code == 200
    assert live.json() == {"status": "ok", "mode": "product"}
    assert ready.status_code == 200
    assert ready.json()["detector_set_version"] == "det_0000000000000000"


def test_production_asgi_factory_rejects_development_mode(tmp_path: Path) -> None:
    environ = _production_environment(tmp_path)
    environ["WORDLESS_REALTIME_DEV_MODE"] = "true"

    with pytest.raises(ValueError, match="production ASGI factory"):
        product_asgi.create_app(environ)
