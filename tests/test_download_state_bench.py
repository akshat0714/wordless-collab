from __future__ import annotations

from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import stat
import zipfile

import pytest

import scripts.download_state_bench as downloader


def _source(path: Path) -> downloader.SourceArchive:
    payload = path.read_bytes()
    return downloader.SourceArchive(
        filename=path.name,
        url="https://example.invalid/pinned.zip",
        digest=sha256(payload).hexdigest(),
        size=len(payload),
        version=downloader.ARCHIVE.version,
        commit=downloader.ARCHIVE.commit,
    )


def _write_complete_fixture(path: Path) -> None:
    root = downloader.ARCHIVE_ROOT
    task_ids = [f"{index}-fixture-task" for index in range(1, 101)]
    split = {"splits": {"train": task_ids, "test": []}}
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"{root}/LICENSE", "MIT fixture")
        archive.writestr(
            f"{root}/state_bench/domains/customer_support/splits/train_test.json",
            json.dumps(split),
        )
        for task_id in task_ids:
            filename = f"{task_id}.json"
            archive.writestr(
                f"{root}/datasets/train_task_trajectories/customer_support/{filename}",
                '{"conversation": []}',
            )
            archive.writestr(
                f"{root}/state_bench/domains/customer_support/tasks/{filename}",
                json.dumps({"task_id": task_id}),
            )
            archive.writestr(
                f"{root}/state_bench/domains/customer_support/task_envs/{filename}",
                '{"orders": []}',
            )
        archive.writestr(f"{root}/README.md", "must not be extracted")


def test_source_is_pinned_to_exact_tag_commit_size_and_sha256() -> None:
    assert downloader.ARCHIVE.version == "v0.8.1"
    assert downloader.ARCHIVE.commit == "4efcbf2d4fe60df04878859b692d9391f3d5b33a"
    assert downloader.ARCHIVE.size == 2_980_182
    assert (
        downloader.ARCHIVE.digest
        == "5fd2a2d403d7345e82f1fc1aada8d8dfa0a07ee5abb7fa742910a3c7d01c5879"
    )
    assert downloader.ARCHIVE.commit in downloader.ARCHIVE.url


def test_download_is_atomic_verified_and_reuses_exact_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"pinned archive fixture"
    source = downloader.SourceArchive(
        filename="fixture.zip",
        url="https://example.invalid/fixture.zip",
        digest=sha256(payload).hexdigest(),
        size=len(payload),
        version="fixture",
        commit="fixture-commit",
    )
    destination = tmp_path / source.filename

    monkeypatch.setattr(
        downloader,
        "urlopen",
        lambda _request, timeout: BytesIO(payload),
    )
    downloader.download(source, destination)
    assert destination.read_bytes() == payload
    assert downloader.verified(destination, source)

    def fail_if_called(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("a verified archive must not be downloaded again")

    monkeypatch.setattr(downloader, "urlopen", fail_if_called)
    downloader.download(source, destination)


def test_checksum_mismatch_is_rejected_before_extraction(tmp_path: Path) -> None:
    archive_path = tmp_path / "not-the-pinned-archive.zip"
    archive_path.write_bytes(b"not a zip")
    source = downloader.SourceArchive(
        filename=archive_path.name,
        url="https://example.invalid/wrong.zip",
        digest="0" * 64,
        size=archive_path.stat().st_size,
        version="fixture",
        commit=downloader.ARCHIVE.commit,
    )
    output = tmp_path / "output"

    with pytest.raises(RuntimeError, match="unverified"):
        downloader.extract_verified_archive(archive_path, output, source)
    assert not output.exists()


def test_extracts_only_100_join_triples_manifest_and_license(tmp_path: Path) -> None:
    archive_path = tmp_path / "complete.zip"
    _write_complete_fixture(archive_path)
    output = tmp_path / "output"

    written = downloader.extract_verified_archive(
        archive_path,
        output,
        _source(archive_path),
    )

    assert len(written) == 302
    assert len(list((output / downloader.TRAJECTORIES_RELATIVE).glob("*.json"))) == 100
    assert len(list((output / downloader.TASKS_RELATIVE).glob("*.json"))) == 100
    assert len(list((output / downloader.TASK_ENVS_RELATIVE).glob("*.json"))) == 100
    assert (output / downloader.SPLIT_RELATIVE).is_file()
    assert (output / "LICENSE").read_text(encoding="utf-8") == "MIT fixture"
    assert not (output / "README.md").exists()
    source = _source(archive_path)
    assert downloader.verify_extracted_corpus(archive_path, output, source)

    task_path = output / downloader.TASKS_RELATIVE / "1-fixture-task.json"
    original = task_path.read_bytes()
    task_path.write_bytes(b'{"task_id":"tampered"}')
    with pytest.raises(RuntimeError, match="differs from archive"):
        downloader.verify_extracted_corpus(archive_path, output, source)
    task_path.write_bytes(original)

    extra = output / downloader.TRAJECTORIES_RELATIVE / "999-extra.json"
    extra.write_text('{"conversation":[]}', encoding="utf-8")
    with pytest.raises(RuntimeError, match="IDs differ"):
        downloader.verify_extracted_corpus(archive_path, output, source)


@pytest.mark.parametrize("unsafe_name", ["../escape", "/absolute", "safe\\escape"])
def test_rejects_unsafe_zip_paths_before_writing(
    tmp_path: Path,
    unsafe_name: str,
) -> None:
    archive_path = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr(unsafe_name, "unsafe")
    output = tmp_path / "output"

    with pytest.raises(RuntimeError, match="Unsafe ZIP member path"):
        downloader.extract_verified_archive(archive_path, output, _source(archive_path))
    assert not output.exists()


def test_rejects_symlink_zip_member_before_writing(tmp_path: Path) -> None:
    archive_path = tmp_path / "symlink.zip"
    link = zipfile.ZipInfo(f"{downloader.ARCHIVE_ROOT}/link")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr(link, "../../outside")
    output = tmp_path / "output"

    with pytest.raises(RuntimeError, match="symlink"):
        downloader.extract_verified_archive(archive_path, output, _source(archive_path))
    assert not output.exists()
