from __future__ import annotations

import hashlib
import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import scripts.realtime_example_client as client


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("http://127.0.0.1:8001", "http://127.0.0.1:8001"),
        ("http://localhost:8001/", "http://localhost:8001"),
        ("http://[::1]:8001", "http://[::1]:8001"),
        ("https://api.example.test", "https://api.example.test"),
        ("https://api.example.test:8443/", "https://api.example.test:8443"),
    ],
)
def test_base_url_accepts_https_and_loopback_http(value: str, expected: str) -> None:
    assert client._validate_base_url(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "http://api.example.test",
        "ftp://api.example.test",
        "api.example.test",
        "https://user:secret@api.example.test",
        "https://api.example.test/v1",
        "https://api.example.test?tenant=alpha",
        "https://api.example.test?",
        "https://api.example.test#fragment",
        "https://api.example.test#",
        " https://api.example.test",
        "https://api.example.test:99999",
    ],
)
def test_base_url_rejects_unsafe_or_non_origin_values(value: str) -> None:
    with pytest.raises(ValueError):
        client._validate_base_url(value)


def test_api_url_rejects_cross_origin_and_ambiguous_links() -> None:
    base_url = "https://api.example.test"
    assert client._url(base_url, "/v1/suggestions") == (
        "https://api.example.test/v1/suggestions"
    )

    for path in (
        "https://other.example.test/v1/suggestions",
        "//other.example.test/v1/suggestions",
        "v1/suggestions",
        "/v1/suggestions?tenant=other",
        "/v1/../admin",
    ):
        with pytest.raises(ValueError):
            client._url(base_url, path)


def test_signature_uses_request_bound_canonical_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    body = b'{"schema_version":1}'
    path = "/v1/suggestions"
    idempotency_key = "suggestion-key-1234"
    timestamp = "1784995200"
    secret = "test-signing-secret"
    expected_message = (
        b"v1:1784995200\n"
        b"POST\n"
        b"/v1/suggestions\n"
        b"suggestion-key-1234\n"
        b'{"schema_version":1}'
    )
    assert client._canonical_post_bytes(
        timestamp=timestamp,
        path=path,
        idempotency_key=idempotency_key,
        body=body,
    ) == expected_message

    monkeypatch.setattr(client.time, "time", lambda: 1_784_995_200)
    headers = client._post_headers(
        path=path,
        body=body,
        api_key="test-api-key",
        signing_secret=secret,
        idempotency_key=idempotency_key,
    )
    expected_digest = hmac.new(
        secret.encode("utf-8"),
        expected_message,
        hashlib.sha256,
    ).hexdigest()
    assert headers["X-Wordless-Timestamp"] == timestamp
    assert headers["X-Wordless-Signature"] == f"v1={expected_digest}"


def test_feedback_is_explicit_opt_in() -> None:
    parser = client.build_parser()
    assert parser.parse_args([]).record_feedback is False
    assert parser.parse_args(["--record-feedback"]).record_feedback is True


def test_default_run_does_not_post_feedback(monkeypatch: pytest.MonkeyPatch) -> None:
    suggestion_id = "sg_0123456789abcdef0123456789abcdef"
    response = {
        "suggestion_id": suggestion_id,
        "candidates": [{"detector_id": "duplicate_charge"}],
        "links": {
            "events": f"/v1/suggestions/{suggestion_id}/events",
            "feedback": f"/v1/suggestions/{suggestion_id}/feedback",
        },
    }
    calls: list[tuple[str, str]] = []

    def fake_request(url: str, **kwargs: object) -> tuple[int, dict[str, str], bytes]:
        method = str(kwargs["method"])
        calls.append((method, url))
        if method == "POST":
            return 201, {}, json.dumps(response).encode("utf-8")
        return 200, {}, b"event: completed\n\n"

    monkeypatch.setattr(client, "_request", fake_request)

    assert client.main([]) == 0
    assert calls == [
        ("POST", "http://127.0.0.1:8001/v1/suggestions"),
        ("GET", f"http://127.0.0.1:8001/v1/suggestions/{suggestion_id}/events"),
    ]


def test_request_refuses_redirects_before_following() -> None:
    class RedirectHandler(BaseHTTPRequestHandler):
        target_hits = 0

        def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
            if self.path.startswith("/redirect/"):
                code = int(self.path.rsplit("/", 1)[-1])
                self.send_response(code)
                self.send_header("Location", "/target")
                self.end_headers()
                return
            type(self).target_hits += 1
            self.send_response(200)
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            del format, args

    server = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for code in (301, 302, 303, 307, 308):
            url = f"http://127.0.0.1:{server.server_port}/redirect/{code}"
            with pytest.raises(RuntimeError, match=rf"HTTP {code}"):
                client._request(
                    url,
                    method="GET",
                    headers={"Authorization": "Bearer must-not-move"},
                    body=None,
                    timeout=2.0,
                )
        assert RedirectHandler.target_hits == 0
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)
