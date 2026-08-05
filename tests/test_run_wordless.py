from __future__ import annotations

from pathlib import Path

import pytest

import scripts.run_wordless as launcher


def test_launcher_defaults_to_the_complete_local_product() -> None:
    args = launcher.build_parser().parse_args([])
    assert args.api_port == 8001
    assert args.console_port == 3000
    assert args.no_open is False


@pytest.mark.parametrize("value", ["0", "65536", "not-a-port"])
def test_launcher_rejects_invalid_ports(value: str) -> None:
    with pytest.raises(SystemExit):
        launcher.build_parser().parse_args(["--api-port", value])


def test_prerequisite_error_explains_the_one_time_install(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(launcher, "CONSOLE", tmp_path)
    monkeypatch.setattr(launcher.shutil, "which", lambda _: "/usr/local/bin/npm")
    with pytest.raises(RuntimeError, match=r"npm --prefix console ci"):
        launcher._require_prerequisites(8001, 3000)


def test_launcher_requires_distinct_service_ports() -> None:
    with pytest.raises(SystemExit, match="must be different"):
        launcher.main(["--api-port", "3100", "--console-port", "3100", "--no-open"])
