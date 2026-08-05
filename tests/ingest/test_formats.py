from __future__ import annotations

from io import StringIO

import pytest

from wordless.ingest.base import AdapterError, normalize_author, normalize_channel, parse_datetime
from wordless.ingest.formats import _JsonStream, iter_json_records, lookup


def test_incremental_json_reader_yields_wrapped_array_records() -> None:
    handle = StringIO('{"count":2,"tickets":[{"id":1,"body":"[x]"},{"id":2}],"next":null}')
    assert [record["id"] for record in iter_json_records(handle, root_keys=("tickets",))] == [1, 2]


def test_json_stream_decodes_across_tiny_chunks() -> None:
    stream = _JsonStream(StringIO('[{"text":"escaped \\\" quote"},{"text":"second"}]'), chunk_size=3)
    assert [item["text"] for item in stream.array()] == ['escaped " quote', "second"]


def test_json_reader_rejects_truncated_record() -> None:
    with pytest.raises(AdapterError, match="truncated"):
        list(iter_json_records(StringIO('[{"id":1}')))


def test_common_normalizers_are_conservative() -> None:
    assert normalize_author("requester") == "customer"
    assert normalize_author(1) == "agent"
    assert normalize_channel("Channel::WebWidget") == "chat"
    assert parse_datetime(1_700_000_000_000).tzinfo is not None
    assert lookup({"a": [{"b": 2}]}, "a.0.b") == 2
