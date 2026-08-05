"""Download and verify the pinned CC BY 4.0 public replay corpus."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
import tempfile
from urllib.request import Request, urlopen


DATASET_ID = "btm76zndnt"
DATASET_VERSION = 2
BASE_URL = f"https://data.mendeley.com/public-files/datasets/{DATASET_ID}/files"


@dataclass(frozen=True)
class SourceFile:
    filename: str
    file_id: str
    digest: str
    size: int

    @property
    def url(self) -> str:
        return f"{BASE_URL}/{self.file_id}/file_downloaded"


FILES = (
    SourceFile("issues.csv", "2018b884-181a-482b-8a06-a86bbf41f4e7", "eab3b8857bc19bd917e0767fb9c30b7714d5468b25c5a1c1cd71a760e9602f02", 20_586_538),
    SourceFile("sample_utterances.csv", "4e1eec04-5c2f-44f5-a855-690519f57f4d", "6486067634164a8d9fc361887b9b700965e704c9b03c87ef4e19275cccf30196", 3_380_477),
    SourceFile("issues_snapshot_sample.xlsx", "693d3551-a8a5-42d4-8ad2-d9ad0d9dd18d", "f9b4d947e231ad518d97774bc74d99f44324e472a83198ee0656c6880edb5e92", 105_863),
    SourceFile("FEATURES.md", "1e69b233-0353-479c-9d38-5b612f5ce85d", "5b8055540d2879f5123f62ef2d87becfe5c4712d175ccc3d8a091c709c5157a4", 14_208),
    SourceFile("EXAMPLE.md", "a3f0fa69-733d-407f-b6c5-aeb5ce82e05f", "71de05944e1f1a3240d22716b292eb0586e00423b15bdf1a7513c6f66d945696", 27_503),
)


def file_digest(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verified(path: Path, source: SourceFile) -> bool:
    return path.is_file() and path.stat().st_size == source.size and file_digest(path) == source.digest


def download(source: SourceFile, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if verified(destination, source):
        return
    request = Request(source.url, headers={"User-Agent": "Wordless-Audit/0.1 public-corpus downloader"})
    temporary_name: str | None = None
    try:
        with urlopen(request, timeout=60) as response, tempfile.NamedTemporaryFile(
            mode="wb", dir=destination.parent, prefix=f".{source.filename}.", delete=False
        ) as temporary:
            temporary_name = temporary.name
            while chunk := response.read(1024 * 1024):
                temporary.write(chunk)
        temporary_path = Path(temporary_name)
        if not verified(temporary_path, source):
            raise RuntimeError(f"published checksum or size did not match for {source.filename}")
        temporary_path.replace(destination)
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(".wordless/public/mendeley-helpdesk-v2"),
    )
    args = parser.parse_args()
    for source in FILES:
        download(source, args.output / source.filename)
        print(f"verified {source.filename} sha256:{source.digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

