#!/usr/bin/env python3
"""Exercise the Wordless real-time API with request-bound body signing."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import json
import os
import sys
import time
from typing import Any, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from wordless.realtime.auth import DEV_API_KEY, DEV_SIGNING_SECRET


DEFAULT_IDEMPOTENCY_KEY = "example-suggestion-20260725"
SUGGESTIONS_PATH = "/v1/suggestions"


class _RejectRedirects(HTTPRedirectHandler):
    """Turn every redirect urllib would follow into an HTTP error."""

    def redirect_request(  # type: ignore[override]
        self,
        request: Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Mapping[str, str],
        new_url: str,
    ) -> None:
        del new_url
        raise HTTPError(
            request.full_url,
            code,
            f"{message}; redirects are disabled",
            headers,
            file_pointer,
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Submit a deterministic duplicate-charge example, read its event stream, "
            "and demonstrate an idempotent suggestion replay. Feedback is only "
            "recorded when --record-feedback is explicitly supplied."
        )
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("WORDLESS_REALTIME_BASE_URL", "http://127.0.0.1:8001"),
        help="API origin; non-loopback origins must use HTTPS (default: %(default)s)",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("WORDLESS_REALTIME_API_KEY", DEV_API_KEY),
        help="server-to-server bearer key (defaults to the local-only demo key)",
    )
    parser.add_argument(
        "--signing-secret",
        default=os.environ.get("WORDLESS_REALTIME_SIGNING_SECRET", DEV_SIGNING_SECRET),
        help="POST signing secret (defaults to the local-only demo secret)",
    )
    parser.add_argument(
        "--idempotency-key",
        default=DEFAULT_IDEMPOTENCY_KEY,
        help="stable key for this logical suggestion (default: %(default)s)",
    )
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--skip-events", action="store_true")
    parser.add_argument(
        "--record-feedback",
        action="store_true",
        help=(
            "record deterministic synthetic agent feedback for this local demo; "
            "omitted by default"
        ),
    )
    return parser


def _json_bytes(value: Mapping[str, Any]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _post_headers(
    *,
    path: str,
    body: bytes,
    api_key: str,
    signing_secret: str,
    idempotency_key: str,
) -> dict[str, str]:
    timestamp = str(int(time.time()))
    signed = _canonical_post_bytes(
        timestamp=timestamp,
        path=path,
        idempotency_key=idempotency_key,
        body=body,
    )
    signature = hmac.new(
        signing_secret.encode("utf-8"),
        signed,
        hashlib.sha256,
    ).hexdigest()
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotency_key,
        "X-Wordless-Timestamp": timestamp,
        "X-Wordless-Signature": f"v1={signature}",
    }


def _canonical_post_bytes(
    *,
    timestamp: str,
    path: str,
    idempotency_key: str,
    body: bytes,
) -> bytes:
    prefix = (
        f"v1:{timestamp}\n"
        f"POST\n"
        f"{path}\n"
        f"{idempotency_key}\n"
    ).encode("utf-8")
    return prefix + body


def _request(
    url: str,
    *,
    method: str,
    headers: Mapping[str, str],
    body: bytes | None,
    timeout: float,
) -> tuple[int, Mapping[str, str], bytes]:
    request = Request(url, data=body, headers=dict(headers), method=method)
    opener = build_opener(_RejectRedirects())
    try:
        with opener.open(request, timeout=timeout) as response:  # noqa: S310
            return response.status, response.headers, response.read()
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} returned HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"could not reach {url}: {exc.reason}") from exc


def _validate_base_url(base_url: str) -> str:
    if base_url != base_url.strip() or any(ord(char) < 0x20 for char in base_url):
        raise ValueError("--base-url must not contain whitespace or control characters")
    if "?" in base_url or "#" in base_url:
        raise ValueError("--base-url must be an origin without a query or fragment")

    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("--base-url must use http or https")
    if not parsed.netloc or parsed.hostname is None:
        raise ValueError("--base-url must include a host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("--base-url must not contain credentials")
    if parsed.path not in {"", "/"}:
        raise ValueError("--base-url must be an origin without a path")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("--base-url has an invalid port") from exc
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("--base-url has an invalid port")

    host = parsed.hostname.rstrip(".").lower()
    loopback = host == "localhost"
    if not loopback:
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = False
    if parsed.scheme != "https" and not loopback:
        raise ValueError("--base-url must use HTTPS unless its host is loopback")
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")


def _validate_api_path(path: str) -> str:
    if not path.startswith("/") or path.startswith("//"):
        raise ValueError("API links must use an absolute same-origin path")
    if path != path.strip() or any(ord(char) < 0x20 for char in path):
        raise ValueError("API links must not contain whitespace or control characters")
    if "?" in path or "#" in path:
        raise ValueError("API links must not contain a query or fragment")
    parsed = urlsplit(path)
    if parsed.scheme or parsed.netloc or parsed.path != path:
        raise ValueError("API links must use an exact same-origin path")
    if any(segment in {".", ".."} for segment in parsed.path.split("/")):
        raise ValueError("API links must not contain dot path segments")
    return path


def _url(base_url: str, path: str) -> str:
    return f"{_validate_base_url(base_url)}{_validate_api_path(path)}"


def _feedback_idempotency_key(suggestion_key: str) -> str:
    digest = hashlib.sha256(suggestion_key.encode("utf-8")).hexdigest()
    return f"example-feedback-{digest}"


def _print_json(label: str, status: int, body: bytes) -> dict[str, Any]:
    payload = json.loads(body)
    print(f"\n{label} (HTTP {status})")
    print(json.dumps(payload, indent=2, sort_keys=True))
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label} did not return a JSON object")
    return payload


def _suggestion_payload() -> dict[str, Any]:
    # Fixed timestamps keep the request bytes stable so the default key is safe to retry.
    return {
        "schema_version": 1,
        "external_event_id": "evt_demo_duplicate_charge_001",
        "observed_at": "2026-07-25T12:00:00Z",
        "channel": "chat",
        "customer_external_id": "customer-demo-001",
        "utterance": {
            "sent_at": "2026-07-25T11:59:00Z",
            "text": "I think I paid twice for the same order.",
        },
        "evidence": [
            {
                "type": "charge",
                "ref": "charge-demo-001",
                "occurred_at": "2026-07-25T11:10:00Z",
                "order_ref": "order-demo-001",
                "amount": "84.00",
                "currency": "USD",
                "status": "succeeded",
            },
            {
                "type": "charge",
                "ref": "charge-demo-002",
                "occurred_at": "2026-07-25T11:40:00Z",
                "order_ref": "order-demo-001",
                "amount": "84.00",
                "currency": "USD",
                "status": "succeeded",
            },
        ],
        "source_system": "example-client",
        "metadata": {"integration": "python-example"},
    }


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.timeout <= 0:
        raise SystemExit("--timeout must be greater than zero")

    try:
        base_url = _validate_base_url(args.base_url)
        suggestion_body = _json_bytes(_suggestion_payload())
        suggestion_headers = _post_headers(
            path=SUGGESTIONS_PATH,
            body=suggestion_body,
            api_key=args.api_key,
            signing_secret=args.signing_secret,
            idempotency_key=args.idempotency_key,
        )
        status, headers, raw = _request(
            _url(base_url, SUGGESTIONS_PATH),
            method="POST",
            headers=suggestion_headers,
            body=suggestion_body,
            timeout=args.timeout,
        )
        suggestion = _print_json("suggestion", status, raw)
        if headers.get("Idempotent-Replayed") == "true":
            print("Idempotent-Replayed: true")

        links = suggestion.get("links")
        if not isinstance(links, dict):
            raise RuntimeError("suggestion response is missing links")
        suggestion_id = suggestion.get("suggestion_id")
        if not isinstance(suggestion_id, str):
            raise RuntimeError("suggestion response is missing suggestion_id")
        events_path = f"/v1/suggestions/{suggestion_id}/events"
        feedback_path = f"/v1/suggestions/{suggestion_id}/feedback"
        if links.get("events") != events_path or links.get("feedback") != feedback_path:
            raise RuntimeError("suggestion response contains unexpected API links")

        if not args.skip_events:
            event_status, _, event_body = _request(
                _url(base_url, events_path),
                method="GET",
                headers={"Authorization": f"Bearer {args.api_key}"},
                body=None,
                timeout=args.timeout,
            )
            print(f"\nevents (HTTP {event_status})")
            print(event_body.decode("utf-8").rstrip())

        if args.record_feedback:
            candidates = suggestion.get("candidates")
            if not isinstance(candidates, list):
                raise RuntimeError("suggestion response has invalid candidates")
            feedback: dict[str, Any]
            if candidates:
                feedback = {
                    "schema_version": 1,
                    "outcome": "confirmed",
                    "selected_detector_id": candidates[0]["detector_id"],
                    "actor": "agent",
                }
            else:
                feedback = {
                    "schema_version": 1,
                    "outcome": "none",
                    "selected_detector_id": None,
                    "actor": "agent",
                }
            feedback_body = _json_bytes(feedback)
            feedback_headers = _post_headers(
                path=feedback_path,
                body=feedback_body,
                api_key=args.api_key,
                signing_secret=args.signing_secret,
                idempotency_key=_feedback_idempotency_key(args.idempotency_key),
            )
            feedback_status, _, feedback_raw = _request(
                _url(base_url, feedback_path),
                method="POST",
                headers=feedback_headers,
                body=feedback_body,
                timeout=args.timeout,
            )
            _print_json("feedback", feedback_status, feedback_raw)
    except (KeyError, TypeError, ValueError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
