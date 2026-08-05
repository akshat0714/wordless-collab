"""Dependency-light streaming readers for customer export files."""

from __future__ import annotations

import csv
import gzip
import io
import json
import zipfile
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any, TextIO

import yaml

from .base import AdapterError


JSONL_SUFFIXES = {".jsonl", ".ndjson"}
TABULAR_SUFFIXES = {".csv", ".tsv"}
YAML_SUFFIXES = {".yaml", ".yml"}
SUPPORTED_SUFFIXES = JSONL_SUFFIXES | TABULAR_SUFFIXES | YAML_SUFFIXES | {".json"}


@contextmanager
def open_export_text(path: Path) -> Iterator[TextIO]:
    """Open a plain, gzip, or single-member zip export without extraction."""

    path = Path(path)
    suffix = path.suffix.casefold()
    if suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as handle:
            yield handle
        return
    if suffix == ".zip":
        with zipfile.ZipFile(path) as archive:
            members = [
                item
                for item in archive.infolist()
                if not item.is_dir()
                and Path(item.filename).suffix.casefold() in SUPPORTED_SUFFIXES
            ]
            if len(members) != 1:
                raise AdapterError(
                    "A zip export must contain exactly one JSON, JSONL, CSV, TSV, or YAML file"
                )
            with archive.open(members[0], "r") as raw:
                with io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as handle:
                    yield handle
        return
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        yield handle


class _JsonStream:
    """Small incremental JSON decoder that yields array elements one at a time."""

    def __init__(self, handle: TextIO, *, chunk_size: int = 65_536) -> None:
        self.handle = handle
        self.chunk_size = chunk_size
        self.buffer = ""
        self.position = 0
        self.eof = False
        self.decoder = json.JSONDecoder()

    def _read(self) -> bool:
        if self.eof:
            return False
        chunk = self.handle.read(self.chunk_size)
        if chunk == "":
            self.eof = True
            return False
        self.buffer += chunk
        return True

    def _compact(self) -> None:
        if self.position > self.chunk_size:
            self.buffer = self.buffer[self.position :]
            self.position = 0

    def skip_ws(self) -> None:
        while True:
            while self.position < len(self.buffer) and self.buffer[self.position].isspace():
                self.position += 1
            if self.position < len(self.buffer) or not self._read():
                self._compact()
                return

    def peek(self) -> str:
        self.skip_ws()
        while self.position >= len(self.buffer) and self._read():
            self.skip_ws()
        return self.buffer[self.position] if self.position < len(self.buffer) else ""

    def expect(self, character: str) -> None:
        found = self.peek()
        if found != character:
            raise AdapterError(f"Invalid JSON export: expected {character!r}, found {found!r}")
        self.position += 1

    def decode(self) -> Any:
        self.skip_ws()
        while True:
            try:
                value, end = self.decoder.raw_decode(self.buffer, self.position)
            except json.JSONDecodeError as exc:
                if self._read():
                    continue
                raise AdapterError(
                    f"Invalid or truncated JSON export at character {exc.pos}: {exc.msg}"
                ) from exc
            self.position = end
            self._compact()
            return value

    def array(self) -> Iterator[Any]:
        self.expect("[")
        if self.peek() == "]":
            self.position += 1
            return
        while True:
            yield self.decode()
            delimiter = self.peek()
            if delimiter == ",":
                self.position += 1
                continue
            if delimiter == "]":
                self.position += 1
                return
            if delimiter == "":
                raise AdapterError("Invalid or truncated JSON export: missing closing ']'")
            raise AdapterError(
                f"Invalid JSON export: expected ',' or ']' after array item, found {delimiter!r}"
            )


def iter_json_records(handle: TextIO, root_keys: Sequence[str] = ()) -> Iterator[Mapping[str, Any]]:
    """Yield top-level records while streaming JSON arrays.

    Vendor exports commonly wrap their record array in ``{"tickets": [...]}``.
    Only an individual record is decoded at once.  A lone object is treated as
    one record.
    """

    stream = _JsonStream(handle)
    first = stream.peek()
    if first == "[":
        for value in stream.array():
            if not isinstance(value, Mapping):
                raise AdapterError("Every JSON export record must be an object")
            yield value
        if stream.peek():
            raise AdapterError("Invalid JSON export: trailing content after top-level array")
        return
    if first != "{":
        raise AdapterError("JSON export must contain an object or an array of objects")

    stream.expect("{")
    record: dict[str, Any] = {}
    matched_array = False
    if stream.peek() == "}":
        stream.position += 1
        yield record
        return
    while True:
        key = stream.decode()
        if not isinstance(key, str):
            raise AdapterError("JSON object keys must be strings")
        stream.expect(":")
        if key in root_keys and stream.peek() == "[":
            matched_array = True
            for value in stream.array():
                if not isinstance(value, Mapping):
                    raise AdapterError(f"Items under {key!r} must be objects")
                yield value
        else:
            record[key] = stream.decode()
        delimiter = stream.peek()
        if delimiter == ",":
            stream.position += 1
            continue
        if delimiter == "}":
            stream.position += 1
            break
        if delimiter == "":
            raise AdapterError("Invalid or truncated JSON export: missing closing '}'")
        raise AdapterError(
            f"Invalid JSON export: expected ',' or '}}' after property, found {delimiter!r}"
        )
    if not matched_array:
        yield record
    if stream.peek():
        raise AdapterError("Invalid JSON export: trailing content after top-level object")


def iter_records(
    path: Path,
    *,
    format_name: str | None = None,
    root_keys: Sequence[str] = (),
    delimiter: str | None = None,
) -> Iterator[Mapping[str, Any]]:
    """Stream mapping records from supported export encodings."""

    path = Path(path)
    inferred_suffix = path.suffix.casefold()
    if inferred_suffix in {".gz", ".zip"}:
        if inferred_suffix == ".gz":
            inferred_suffix = Path(path.stem).suffix.casefold()
        else:
            try:
                with zipfile.ZipFile(path) as archive:
                    members = [
                        item
                        for item in archive.infolist()
                        if not item.is_dir()
                        and Path(item.filename).suffix.casefold() in SUPPORTED_SUFFIXES
                    ]
            except (OSError, zipfile.BadZipFile) as exc:
                raise AdapterError(f"Invalid zip export: {path}") from exc
            if len(members) != 1:
                raise AdapterError(
                    "A zip export must contain exactly one JSON, JSONL, CSV, TSV, or YAML file"
                )
            inferred_suffix = Path(members[0].filename).suffix.casefold()
    normalized_format = (format_name or inferred_suffix.lstrip(".")).casefold()
    if normalized_format == "ndjson":
        normalized_format = "jsonl"

    with open_export_text(path) as handle:
        if normalized_format in {"jsonl", "jsonlines"}:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise AdapterError(f"Invalid JSONL record on line {line_number}: {exc.msg}") from exc
                if not isinstance(value, Mapping):
                    raise AdapterError(f"JSONL record on line {line_number} is not an object")
                yield value
            return
        if normalized_format in {"csv", "tsv"}:
            actual_delimiter = delimiter or ("\t" if normalized_format == "tsv" else ",")
            reader = csv.DictReader(handle, delimiter=actual_delimiter)
            if reader.fieldnames is None:
                raise AdapterError("Tabular export has no header row")
            yield from reader
            return
        if normalized_format in {"yaml", "yml"}:
            for document in yaml.safe_load_all(handle):
                if document is None:
                    continue
                values = document if isinstance(document, list) else [document]
                for value in values:
                    if not isinstance(value, Mapping):
                        raise AdapterError("Every YAML export record must be an object")
                    yield value
            return
        if normalized_format in {"json", ""}:
            yield from iter_json_records(handle, root_keys=root_keys)
            return
        raise AdapterError(f"Unsupported export format: {normalized_format!r}")


def choose_export_file(
    path: Path,
    *,
    preferred_names: Sequence[str] = (),
) -> Path:
    """Resolve a file from an export directory without modifying it."""

    path = Path(path)
    if path.is_file():
        return path
    if not path.is_dir():
        raise AdapterError(f"Export path does not exist: {path}")
    lowered = {name.casefold() for name in preferred_names}
    files = sorted(item for item in path.rglob("*") if item.is_file())
    preferred = [item for item in files if item.name.casefold() in lowered]
    candidates = preferred or [
        item
        for item in files
        if item.suffix.casefold() in SUPPORTED_SUFFIXES | {".gz", ".zip"}
    ]
    if not candidates:
        raise AdapterError(f"No supported export file found under {path}")
    return candidates[0]


def lookup(value: Any, path: str | Sequence[str | int] | None, default: Any = None) -> Any:
    """Resolve a dotted path through dicts/lists, with escaped dots unsupported by design."""

    if path is None or path == "":
        return value
    parts: Sequence[str | int]
    if isinstance(path, str):
        parts = [int(part) if part.isdigit() else part for part in path.split(".")]
    else:
        parts = path
    current = value
    for part in parts:
        if isinstance(part, int) and isinstance(current, Sequence) and not isinstance(
            current, (str, bytes, bytearray)
        ):
            if part >= len(current):
                return default
            current = current[part]
        elif isinstance(current, Mapping) and part in current:
            current = current[part]
        else:
            return default
    return current


def first(value: Mapping[str, Any], *paths: str, default: Any = None) -> Any:
    for path in paths:
        found = lookup(value, path)
        if found is not None and found != "":
            return found
    return default


def peek_keys(path: Path) -> set[str]:
    """Read at most the first record for conservative adapter detection."""

    try:
        record = next(iter_records(path, root_keys=("tickets", "conversations", "payload", "data")))
    except (AdapterError, OSError, StopIteration, UnicodeError, yaml.YAMLError):
        return set()
    return {str(key).casefold() for key in record}
