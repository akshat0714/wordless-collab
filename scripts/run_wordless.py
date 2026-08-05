#!/usr/bin/env python3
"""Start the complete loopback-only Wordless product demo."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from typing import Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import webbrowser


WORKSPACE = Path(__file__).resolve().parents[1]
CONSOLE = WORKSPACE / "console"
HOST = "127.0.0.1"


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("port must be an integer") from error
    if not 1 <= port <= 65_535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Start the Wordless API and customer-support chat on this computer.",
    )
    parser.add_argument("--api-port", type=_port, default=8001)
    parser.add_argument("--console-port", type=_port, default=3000)
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="start both services without opening the support chat in a browser",
    )
    return parser


def _port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((HOST, port))
        except OSError:
            return False
    return True


def _require_prerequisites(api_port: int, console_port: int) -> str:
    npm = shutil.which("npm")
    if npm is None:
        raise RuntimeError("Node.js 20+ and npm are required to run the console.")
    if not (CONSOLE / "node_modules" / ".bin" / "next").is_file():
        raise RuntimeError(
            "Console packages are missing. Run `npm --prefix console ci` once, then retry."
        )
    for label, port in (("API", api_port), ("console", console_port)):
        if not _port_available(port):
            raise RuntimeError(
                f"Port {port} for the {label} is already in use. Stop that process or choose "
                f"another port with --{label.lower()}-port."
            )
    return npm


def _is_ready(url: str) -> bool:
    try:
        with urlopen(Request(url, method="GET"), timeout=0.75) as response:  # noqa: S310
            return 200 <= response.status < 300
    except (HTTPError, URLError, TimeoutError, OSError):
        return False


def _wait_until_ready(
    processes: Sequence[subprocess.Popen[bytes]],
    urls: Sequence[str],
    *,
    timeout_seconds: float = 90.0,
) -> bool:
    deadline = time.monotonic() + timeout_seconds
    ready = [False] * len(urls)
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in processes):
            return False
        ready = [current or _is_ready(url) for current, url in zip(ready, urls, strict=True)]
        if all(ready):
            return True
        time.sleep(0.2)
    return False


def _stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGINT)
        process.wait(timeout=5)
        return
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=3)
        return
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        pass
    process.wait(timeout=3)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.api_port == args.console_port:
        raise SystemExit("API and console ports must be different.")
    try:
        npm = _require_prerequisites(args.api_port, args.console_port)
    except RuntimeError as error:
        raise SystemExit(str(error)) from error

    api_url = f"http://{HOST}:{args.api_port}"
    demo_url = f"http://{HOST}:{args.console_port}/live"
    console_environment = dict(os.environ)
    console_environment["WORDLESS_REALTIME_API_BASE_URL"] = api_url

    print("Starting Wordless…")
    api = subprocess.Popen(
        [
            sys.executable,
            str(WORKSPACE / "scripts" / "run_realtime_api.py"),
            "--host",
            HOST,
            "--port",
            str(args.api_port),
            "--hide-local-credentials",
            "--log-level",
            "warning",
        ],
        cwd=WORKSPACE,
        start_new_session=True,
    )
    console = subprocess.Popen(
        [npm, "run", "dev", "--", "--port", str(args.console_port)],
        cwd=CONSOLE,
        env=console_environment,
        start_new_session=True,
    )
    processes = (api, console)

    try:
        if not _wait_until_ready(
            processes,
            (f"{api_url}/health/ready", demo_url),
        ):
            print("Wordless did not become ready. Review the service output above.", file=sys.stderr)
            return next(
                (process.returncode for process in processes if process.returncode is not None),
                1,
            )

        print(f"Wordless is ready: {demo_url}")
        print("Press Ctrl-C here to stop both services.")
        if not args.no_open:
            webbrowser.open(demo_url)

        while all(process.poll() is None for process in processes):
            time.sleep(0.25)
        return next(
            (process.returncode for process in processes if process.returncode is not None),
            1,
        )
    except KeyboardInterrupt:
        print("\nStopping Wordless…")
        return 0
    finally:
        for process in reversed(processes):
            _stop(process)


if __name__ == "__main__":
    raise SystemExit(main())
