"""Download and safely extract the pinned STATE-Bench v0.8.1 replay corpus."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
from urllib.request import Request, urlopen
import zipfile

from wordless.ingest.state_bench import (
    STATE_BENCH_ARCHIVE_SHA256,
    STATE_BENCH_COMMIT,
    STATE_BENCH_VERSION,
    SPLIT_RELATIVE,
    TASK_ENVS_RELATIVE,
    TASKS_RELATIVE,
    TRAJECTORIES_RELATIVE,
)


ARCHIVE_SIZE = 2_980_182
EXPECTED_TRAJECTORIES = 100
ARCHIVE_ROOT = f"STATE-Bench-{STATE_BENCH_COMMIT}"


@dataclass(frozen=True)
class SourceArchive:
    filename: str
    url: str
    digest: str
    size: int
    version: str
    commit: str


ARCHIVE = SourceArchive(
    filename=f"state-bench-{STATE_BENCH_VERSION}-{STATE_BENCH_COMMIT}.zip",
    url=(
        "https://github.com/microsoft/STATE-Bench/archive/"
        f"{STATE_BENCH_COMMIT}.zip"
    ),
    digest=STATE_BENCH_ARCHIVE_SHA256,
    size=ARCHIVE_SIZE,
    version=STATE_BENCH_VERSION,
    commit=STATE_BENCH_COMMIT,
)


def file_digest(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verified(path: Path, source: SourceArchive = ARCHIVE) -> bool:
    return (
        path.is_file()
        and path.stat().st_size == source.size
        and file_digest(path) == source.digest
    )


def download(source: SourceArchive, destination: Path) -> None:
    """Download ``source`` atomically, accepting only its exact pinned bytes."""

    destination.parent.mkdir(parents=True, exist_ok=True)
    if verified(destination, source):
        return
    request = Request(
        source.url,
        headers={"User-Agent": "Wordless-Audit/0.1 state-bench-downloader"},
    )
    temporary_name: str | None = None
    try:
        with urlopen(request, timeout=60) as response, tempfile.NamedTemporaryFile(
            mode="wb",
            dir=destination.parent,
            prefix=f".{source.filename}.",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            while chunk := response.read(1024 * 1024):
                temporary.write(chunk)
        temporary_path = Path(temporary_name)
        if not verified(temporary_path, source):
            raise RuntimeError(
                "STATE-Bench archive did not match the pinned size and SHA-256 "
                f"for {source.version} ({source.commit})"
            )
        temporary_path.replace(destination)
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def extract_verified_archive(
    archive_path: Path,
    destination: Path,
    source: SourceArchive = ARCHIVE,
) -> tuple[Path, ...]:
    """Extract only the 100 customer-support trajectory/task/env joins.

    Every ZIP member is inspected before any file is written.  Absolute paths,
    traversal, backslash-separated paths, duplicate names, symlinks, and other
    special filesystem entries are rejected even when they are not selected
    for extraction.
    """

    if not verified(archive_path, source):
        raise RuntimeError(
            "Refusing to extract an unverified STATE-Bench archive; expected "
            f"sha256:{source.digest}"
        )
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = _validated_members(archive, expected_root=f"STATE-Bench-{source.commit}")
            selected = _required_customer_support_members(
                members,
                expected_root=f"STATE-Bench-{source.commit}",
            )
            destination.mkdir(parents=True, exist_ok=True)
            written: list[Path] = []
            for info, relative in selected:
                target = destination.joinpath(*relative.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary_name: str | None = None
                try:
                    with archive.open(info, "r") as source_handle, tempfile.NamedTemporaryFile(
                        mode="wb",
                        dir=target.parent,
                        prefix=f".{target.name}.",
                        delete=False,
                    ) as temporary:
                        temporary_name = temporary.name
                        shutil.copyfileobj(source_handle, temporary, length=1024 * 1024)
                    temporary_path = Path(temporary_name)
                    if temporary_path.stat().st_size != info.file_size:
                        raise RuntimeError(f"Truncated ZIP member {info.filename!r}")
                    temporary_path.replace(target)
                    written.append(target)
                finally:
                    if temporary_name is not None:
                        Path(temporary_name).unlink(missing_ok=True)
            return tuple(written)
    except zipfile.BadZipFile as exc:
        raise RuntimeError("Pinned STATE-Bench archive is not a valid ZIP file") from exc


def verify_extracted_corpus(
    archive_path: Path,
    corpus_root: Path,
    source: SourceArchive = ARCHIVE,
) -> bool:
    """Prove that the extracted read-only corpus still matches the archive."""

    if not verified(archive_path, source):
        raise RuntimeError(
            "Refusing to verify against an unverified STATE-Bench archive; expected "
            f"sha256:{source.digest}"
        )
    expected_root = f"STATE-Bench-{source.commit}"
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = _validated_members(archive, expected_root=expected_root)
            selected = _required_customer_support_members(
                members,
                expected_root=expected_root,
            )
            expected_ids = {
                relative.stem
                for _, relative in selected
                if relative.parent == PurePosixPath(TRAJECTORIES_RELATIVE.as_posix())
            }
            _verify_extracted_id_set(corpus_root, TRAJECTORIES_RELATIVE, expected_ids)
            _verify_extracted_id_set(corpus_root, TASKS_RELATIVE, expected_ids)
            _verify_extracted_id_set(corpus_root, TASK_ENVS_RELATIVE, expected_ids)
            for info, relative in selected:
                target = corpus_root.joinpath(*relative.parts)
                if target.is_symlink() or not target.is_file():
                    raise RuntimeError(
                        f"Extracted STATE-Bench file is missing or unsafe: {relative.as_posix()}"
                    )
                if target.stat().st_size != info.file_size:
                    raise RuntimeError(
                        f"Extracted STATE-Bench file differs from archive: {relative.as_posix()}"
                    )
                with archive.open(info, "r") as expected, target.open("rb") as actual:
                    while True:
                        expected_chunk = expected.read(1024 * 1024)
                        actual_chunk = actual.read(1024 * 1024)
                        if expected_chunk != actual_chunk:
                            raise RuntimeError(
                                "Extracted STATE-Bench file differs from archive: "
                                f"{relative.as_posix()}"
                            )
                        if not expected_chunk:
                            break
            return True
    except zipfile.BadZipFile as exc:
        raise RuntimeError("Pinned STATE-Bench archive is not a valid ZIP file") from exc


def _verify_extracted_id_set(
    corpus_root: Path,
    relative_directory: Path,
    expected_ids: set[str],
) -> None:
    directory = corpus_root / relative_directory
    if not directory.is_dir():
        raise RuntimeError(f"Extracted STATE-Bench directory is missing: {relative_directory}")
    actual_ids = {path.stem for path in directory.glob("*.json") if path.is_file()}
    if actual_ids != expected_ids:
        missing = sorted(expected_ids - actual_ids)
        extra = sorted(actual_ids - expected_ids)
        raise RuntimeError(
            f"Extracted STATE-Bench IDs differ in {relative_directory} "
            f"(missing={missing[:5]!r}, extra={extra[:5]!r})"
        )


def _validated_members(
    archive: zipfile.ZipFile,
    *,
    expected_root: str,
) -> dict[str, zipfile.ZipInfo]:
    members: dict[str, zipfile.ZipInfo] = {}
    for info in archive.infolist():
        name = info.filename
        if not name or "\\" in name:
            raise RuntimeError(f"Unsafe ZIP member path {name!r}")
        path = PurePosixPath(name)
        if (
            path.is_absolute()
            or ".." in path.parts
            or "." in path.parts
            or not path.parts
            or path.parts[0] != expected_root
        ):
            raise RuntimeError(f"Unsafe ZIP member path {name!r}")
        if name in members:
            raise RuntimeError(f"Duplicate ZIP member {name!r}")
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise RuntimeError(f"Refusing symlink ZIP member {name!r}")
        file_type = stat.S_IFMT(mode)
        if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
            raise RuntimeError(f"Refusing special ZIP member {name!r}")
        members[name] = info
    return members


def _required_customer_support_members(
    members: dict[str, zipfile.ZipInfo],
    *,
    expected_root: str,
) -> tuple[tuple[zipfile.ZipInfo, PurePosixPath], ...]:
    trajectory_prefix = f"{expected_root}/{TRAJECTORIES_RELATIVE.as_posix()}/"
    trajectory_names = sorted(
        name
        for name, info in members.items()
        if name.startswith(trajectory_prefix)
        and not info.is_dir()
        and PurePosixPath(name).parent.as_posix() == trajectory_prefix.rstrip("/")
        and name.endswith(".json")
    )
    if len(trajectory_names) != EXPECTED_TRAJECTORIES:
        raise RuntimeError(
            "Pinned STATE-Bench archive must contain exactly "
            f"{EXPECTED_TRAJECTORIES} customer-support train trajectories; "
            f"found {len(trajectory_names)}"
        )

    required_names = [
        f"{expected_root}/LICENSE",
        f"{expected_root}/{SPLIT_RELATIVE.as_posix()}",
    ]
    for trajectory_name in trajectory_names:
        filename = PurePosixPath(trajectory_name).name
        required_names.extend(
            (
                trajectory_name,
                f"{expected_root}/{TASKS_RELATIVE.as_posix()}/{filename}",
                f"{expected_root}/{TASK_ENVS_RELATIVE.as_posix()}/{filename}",
            )
        )

    selected: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
    for name in required_names:
        info = members.get(name)
        if info is None or info.is_dir():
            raise RuntimeError(f"Pinned STATE-Bench archive is missing required file {name!r}")
        relative = PurePosixPath(name).relative_to(expected_root)
        selected.append((info, relative))
    return tuple(selected)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(".wordless/public/state-bench-v0.8.1"),
        help="ignored local directory for the verified archive and extracted JSON",
    )
    args = parser.parse_args()
    archive_path = args.output / ARCHIVE.filename
    download(ARCHIVE, archive_path)
    extracted = extract_verified_archive(archive_path, args.output, ARCHIVE)
    verify_extracted_corpus(archive_path, args.output, ARCHIVE)
    print(
        f"verified {ARCHIVE.filename} sha256:{ARCHIVE.digest}; "
        f"extracted {len(extracted)} pinned files"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
