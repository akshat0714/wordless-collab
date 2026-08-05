"""Read-only adapter for the pinned STATE-Bench customer-support corpus.

This module reads the JSON files shipped in the upstream repository directly.
It deliberately does not import the ``state_bench`` runtime package: task
definitions, task environments, and training trajectories are joined by their
shared task ID and normalized at the ordinary Wordless ingest boundary.

STATE-Bench supplies one logical ``task.now`` value, but no wall-clock time per
turn.  That value therefore anchors the interaction, every message, the
point-in-time environment snapshot, and the resolution.  The limitation is
recorded as ``temporal_granularity=task_now`` in canonical metadata.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
import json
from pathlib import Path, PurePosixPath
import re
from typing import Any, ClassVar

from wordless.core.models import Interaction
from wordless.core.redact import Redactor

from .base import Adapter, AdapterError, clean_scalar, parse_datetime


STATE_BENCH_VERSION = "v0.8.1"
STATE_BENCH_COMMIT = "4efcbf2d4fe60df04878859b692d9391f3d5b33a"
STATE_BENCH_ARCHIVE_SHA256 = (
    "5fd2a2d403d7345e82f1fc1aada8d8dfa0a07ee5abb7fa742910a3c7d01c5879"
)
STATE_BENCH_REPOSITORY_URL = "https://github.com/microsoft/STATE-Bench"
STATE_BENCH_SOURCE_URL = f"{STATE_BENCH_REPOSITORY_URL}/tree/{STATE_BENCH_COMMIT}"
STATE_BENCH_LICENSE = "MIT"
STATE_BENCH_LICENSE_URL = (
    f"{STATE_BENCH_REPOSITORY_URL}/blob/{STATE_BENCH_COMMIT}/LICENSE"
)

TRAJECTORIES_RELATIVE = Path("datasets/train_task_trajectories/customer_support")
TASKS_RELATIVE = Path("state_bench/domains/customer_support/tasks")
TASK_ENVS_RELATIVE = Path("state_bench/domains/customer_support/task_envs")
SPLIT_RELATIVE = Path("state_bench/domains/customer_support/splits/train_test.json")

_ROLE_MAP = {
    "user": "customer",
    "assistant": "agent",
    "system": "system",
}
_CLOSED_ORDER_STATUSES = {
    "canceled": "cancelled",
    "cancelled": "cancelled",
    "delivered": "delivered",
    "fully_returned": "returned",
    "returned": "returned",
}
_STATUS_TOKEN_RE = re.compile(r"[^a-z0-9]+")
_TASK_NUMBER_RE = re.compile(r"\A(?P<number>\d+)(?:-|\Z)")
_TASK_DONE_RE = re.compile(r"\s*\[TASK_DONE\]\s*\Z")


class StateBenchCustomerSupportAdapter(Adapter):
    """Normalize the 100 published customer-support training trajectories."""

    source_system: ClassVar[str] = "state_bench_customer_support"

    def __init__(
        self,
        corpus_salt: str | bytes | None = None,
        *,
        salt: str | bytes | None = None,
        redactor: Redactor | None = None,
    ) -> None:
        # The corpus is synthetic, but it crosses the same mandatory
        # Presidio+regex boundary as customer exports.
        super().__init__(
            corpus_salt=corpus_salt,
            salt=salt,
            redactor=redactor or Redactor(),
        )

    def detect(self, path: Path) -> bool:
        root = _corpus_root(Path(path))
        return all(
            (root / relative).is_dir()
            for relative in (TRAJECTORIES_RELATIVE, TASKS_RELATIVE, TASK_ENVS_RELATIVE)
        ) and (root / SPLIT_RELATIVE).is_file() and any(
            (root / TRAJECTORIES_RELATIVE).glob("*.json")
        )

    def load(self, path: Path) -> Iterator[Interaction]:
        root = _corpus_root(Path(path))
        trajectories_dir = root / TRAJECTORIES_RELATIVE
        tasks_dir = root / TASKS_RELATIVE
        task_envs_dir = root / TASK_ENVS_RELATIVE
        missing = [
            str(relative)
            for relative, directory in (
                (TRAJECTORIES_RELATIVE, trajectories_dir),
                (TASKS_RELATIVE, tasks_dir),
                (TASK_ENVS_RELATIVE, task_envs_dir),
            )
            if not directory.is_dir()
        ]
        if missing:
            raise AdapterError(
                "STATE-Bench customer-support fixture is missing: " + ", ".join(missing)
            )
        split_path = root / SPLIT_RELATIVE
        if not split_path.is_file():
            raise AdapterError(
                f"STATE-Bench customer-support fixture is missing: {SPLIT_RELATIVE}"
            )

        split = _read_object(split_path, label="customer-support split manifest")
        train_task_ids = _train_task_ids(split)
        trajectory_by_id = {
            path.stem: path
            for path in sorted(
                trajectories_dir.glob("*.json"),
                key=lambda item: _task_sort_key(item.stem),
            )
        }
        manifest_ids = set(train_task_ids)
        trajectory_ids = set(trajectory_by_id)
        if manifest_ids != trajectory_ids:
            missing_ids = sorted(manifest_ids - trajectory_ids, key=_task_sort_key)
            unexpected_ids = sorted(trajectory_ids - manifest_ids, key=_task_sort_key)
            raise AdapterError(
                "STATE-Bench train trajectories do not match splits.train "
                f"(missing={missing_ids[:5]!r}, unexpected={unexpected_ids[:5]!r})"
            )
        trajectory_paths = tuple(
            trajectory_by_id[task_id] for task_id in train_task_ids
        )
        if not trajectory_paths:
            raise AdapterError("STATE-Bench customer-support fixture has no trajectories")

        task_paths: dict[str, Path] = {}
        task_env_paths: dict[str, Path] = {}
        for trajectory_path in trajectory_paths:
            task_id = trajectory_path.stem
            task_path = tasks_dir / f"{task_id}.json"
            task_env_path = task_envs_dir / f"{task_id}.json"
            if not task_path.is_file() or not task_env_path.is_file():
                raise AdapterError(
                    f"STATE-Bench task {task_id!r} is missing its task definition "
                    "or task environment"
                )
            task_paths[task_id] = task_path
            task_env_paths[task_id] = task_env_path

        for trajectory_path in trajectory_paths:
            task_id = trajectory_path.stem
            trajectory = _read_object(trajectory_path, label=f"trajectory {task_id}")
            task = _read_object(task_paths[task_id], label=f"task {task_id}")
            task_env = _read_object(
                task_env_paths[task_id], label=f"task environment {task_id}"
            )
            yield self._normalize(task_id, trajectory, task, task_env)

    def _normalize(
        self,
        task_id: str,
        trajectory: Mapping[str, Any],
        task: Mapping[str, Any],
        task_env: Mapping[str, Any],
    ) -> Interaction:
        declared_task_id = clean_scalar(task.get("task_id"))
        if declared_task_id != task_id:
            raise AdapterError(
                f"STATE-Bench task ID mismatch: filename {task_id!r}, "
                f"definition {declared_task_id!r}"
            )
        _validate_declared_env_path(task.get("task_env_path"), task_id=task_id)

        user_id = clean_scalar(task.get("user_id"))
        if not user_id:
            raise AdapterError(f"STATE-Bench task {task_id!r} has no user_id")
        task_now = parse_datetime(task.get("now"), field=f"task {task_id}.now")

        conversation = _mapping_sequence(
            trajectory.get("conversation"),
            field=f"trajectory {task_id}.conversation",
        )
        messages: list[dict[str, Any]] = []
        successful_actions: list[str] = []
        final_assistant_text: str | None = None
        for index, turn in enumerate(conversation):
            raw_role = clean_scalar(turn.get("role")).casefold()
            author = _ROLE_MAP.get(raw_role)
            if author is None:
                raise AdapterError(
                    f"Unsupported role {raw_role!r} in trajectory {task_id} turn {index}"
                )
            content = turn.get("content")
            if not isinstance(content, str):
                raise AdapterError(
                    f"Missing text content in trajectory {task_id} turn {index}"
                )
            if author == "customer":
                content = _TASK_DONE_RE.sub("", content).rstrip()
            if content:
                messages.append(
                    {
                        "author": author,
                        "sent_at": task_now,
                        "text": content,
                        "redacted": False,
                    }
                )
            if author == "agent":
                final_assistant_text = content
            successful_actions.extend(
                _successful_confirmed_actions(
                    turn.get("tool_calls"),
                    task_id=task_id,
                    turn_index=index,
                )
            )

        if final_assistant_text is None:
            raise AdapterError(f"STATE-Bench trajectory {task_id!r} has no assistant closing")

        customers = _mapping_sequence(
            task_env.get("customers"),
            field=f"task environment {task_id}.customers",
        )
        matching_customers = [
            customer
            for customer in customers
            if clean_scalar(customer.get("customer_id")) == user_id
        ]
        if len(matching_customers) != 1:
            raise AdapterError(
                f"STATE-Bench task environment {task_id!r} must contain exactly one "
                f"customer record for task user {user_id!r}"
            )

        # Preserve a minimal non-identifying exported-state anchor even for
        # privacy-edge tasks whose only order belongs to another customer.
        # This derives solely from the task environment and carries no task
        # summary, requirement, score, or other benchmark oracle.
        facts: list[dict[str, Any]] = [
            {
                "source": "account",
                "kind": "customer_account",
                "occurred_at": task_now,
                "fields": {"record_present": True},
                "provenance": "exported",
            }
        ]
        orders = _mapping_sequence(
            task_env.get("orders"),
            field=f"task environment {task_id}.orders",
        )
        for index, order in enumerate(orders):
            # A few privacy-edge tasks intentionally seed another customer's
            # order.  It is not part of this interaction's account snapshot.
            if clean_scalar(order.get("customer_id")) != user_id:
                continue
            order_id = clean_scalar(order.get("order_id"))
            if not order_id:
                raise AdapterError(
                    f"Missing order_id in task environment {task_id} order {index}"
                )
            fields: dict[str, Any] = {
                "order_id": order_id,
                "status": normalize_shipment_status(order),
            }
            order_status = _status_token(order.get("status"))
            shipping_status = _status_token(order.get("shipping_status"))
            if order_status:
                fields["order_status"] = order_status
            if shipping_status:
                fields["shipping_status"] = shipping_status
            promised_at = clean_scalar(order.get("delivery_promised_date"))
            delivered_at = clean_scalar(order.get("delivery_date"))
            if promised_at:
                # Validation happens here even though the canonical field keeps
                # the upstream ISO representation for detector transparency.
                parse_datetime(
                    promised_at,
                    field=f"task environment {task_id} order {order_id}.delivery_promised_date",
                )
                fields["promised_delivery_at"] = promised_at
            if delivered_at:
                parse_datetime(
                    delivered_at,
                    field=f"task environment {task_id} order {order_id}.delivery_date",
                )
                fields["delivered_at"] = delivered_at
            facts.append(
                {
                    "source": "shipping",
                    "kind": "shipment",
                    "occurred_at": task_now,
                    "fields": fields,
                    "provenance": "exported",
                }
            )

        # Task summaries, simulator instructions, state/task requirements,
        # scores, and diffs are benchmark oracles.  None crosses this boundary.
        metadata = {
            "task_id": task_id,
            "dataset_split": "train",
            "dataset_version": STATE_BENCH_VERSION,
            "source_url": STATE_BENCH_SOURCE_URL,
            "source_commit": STATE_BENCH_COMMIT,
            "source_archive_sha256": STATE_BENCH_ARCHIVE_SHA256,
            "license_name": STATE_BENCH_LICENSE,
            "license_url": STATE_BENCH_LICENSE_URL,
            "temporal_granularity": "task_now",
        }
        return self._finalize(
            interaction_id=f"state-bench:customer_support:{task_id}",
            raw_customer_id=user_id,
            opened_at=task_now,
            channel="chat",
            messages=messages,
            state_snapshot=facts,
            resolution={
                "resolved_at": task_now,
                "original_label": None,
                "actions": successful_actions,
                "closing_text": final_assistant_text,
            },
            metadata=metadata,
        )


def normalize_shipment_status(order: Mapping[str, Any]) -> str:
    """Return detector-safe status without inferring lateness from dates.

    A closed order lifecycle is authoritative over a stale shipping field.
    Otherwise the more specific shipping field wins, then the order lifecycle
    is used as a fallback.  Only closed aliases are semantically collapsed.
    """

    order_status = _status_token(order.get("status"))
    closed = _CLOSED_ORDER_STATUSES.get(order_status)
    if closed is not None:
        return closed
    shipping_status = _status_token(order.get("shipping_status"))
    if shipping_status:
        return _CLOSED_ORDER_STATUSES.get(shipping_status, shipping_status)
    if order_status:
        return _CLOSED_ORDER_STATUSES.get(order_status, order_status)
    return "unknown"


def _successful_confirmed_actions(
    value: Any,
    *,
    task_id: str,
    turn_index: int,
) -> list[str]:
    if value is None:
        return []
    calls = _mapping_sequence(
        value,
        field=f"trajectory {task_id} turn {turn_index}.tool_calls",
    )
    actions: list[str] = []
    for call_index, call in enumerate(calls):
        arguments = call.get("arguments")
        if arguments is not None and not isinstance(arguments, Mapping):
            raise AdapterError(
                f"Invalid arguments in trajectory {task_id} turn {turn_index} "
                f"tool call {call_index}"
            )
        if not isinstance(arguments, Mapping) or arguments.get("confirm") is not True:
            continue
        result = call.get("result")
        if not isinstance(result, Mapping) or result.get("error"):
            continue
        name = clean_scalar(call.get("name"))
        if not name:
            raise AdapterError(
                f"Missing tool name in trajectory {task_id} turn {turn_index} "
                f"tool call {call_index}"
            )
        actions.append(name)
    return actions


def _mapping_sequence(value: Any, *, field: str) -> list[Mapping[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise AdapterError(f"{field} must be a JSON array")
    output: list[Mapping[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, Mapping):
            raise AdapterError(f"{field}[{index}] must be a JSON object")
        output.append(item)
    return output


def _read_object(path: Path, *, label: str) -> Mapping[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AdapterError(f"Could not read STATE-Bench {label}: {exc}") from exc
    if not isinstance(value, Mapping):
        raise AdapterError(f"STATE-Bench {label} must be a JSON object")
    return value


def _train_task_ids(split: Mapping[str, Any]) -> tuple[str, ...]:
    splits = split.get("splits")
    if not isinstance(splits, Mapping):
        raise AdapterError("STATE-Bench split manifest has no splits object")
    values = splits.get("train")
    if not isinstance(values, Sequence) or isinstance(values, (str, bytes, bytearray)):
        raise AdapterError("STATE-Bench split manifest splits.train must be a JSON array")
    task_ids: list[str] = []
    for index, value in enumerate(values):
        task_id = clean_scalar(value)
        if (
            not task_id
            or task_id in {".", ".."}
            or "/" in task_id
            or "\\" in task_id
        ):
            raise AdapterError(
                f"Invalid task ID in STATE-Bench splits.train at index {index}: {value!r}"
            )
        task_ids.append(task_id)
    if not task_ids:
        raise AdapterError("STATE-Bench split manifest splits.train is empty")
    if len(set(task_ids)) != len(task_ids):
        raise AdapterError("STATE-Bench split manifest splits.train contains duplicate task IDs")
    return tuple(task_ids)


def _validate_declared_env_path(value: Any, *, task_id: str) -> None:
    if value is None or value == "":
        return
    text = clean_scalar(value)
    path = PurePosixPath(text)
    expected = PurePosixPath("state_bench/domains/customer_support/task_envs") / (
        f"{task_id}.json"
    )
    if path.is_absolute() or ".." in path.parts or path != expected:
        raise AdapterError(
            f"STATE-Bench task {task_id!r} declares unexpected task_env_path {text!r}"
        )


def _status_token(value: Any) -> str:
    text = clean_scalar(value).casefold()
    return _STATUS_TOKEN_RE.sub("_", text).strip("_")


def _task_sort_key(task_id: str) -> tuple[int, str]:
    match = _TASK_NUMBER_RE.match(task_id)
    return (int(match.group("number")) if match else 2**31, task_id)


def _corpus_root(path: Path) -> Path:
    candidate = path if path.is_dir() else path.parent
    for root in (candidate, *candidate.parents):
        if all(
            (root / relative).is_dir()
            for relative in (TRAJECTORIES_RELATIVE, TASKS_RELATIVE, TASK_ENVS_RELATIVE)
        ) and (root / SPLIT_RELATIVE).is_file():
            return root
    return candidate


__all__ = [
    "STATE_BENCH_ARCHIVE_SHA256",
    "STATE_BENCH_COMMIT",
    "STATE_BENCH_LICENSE",
    "STATE_BENCH_LICENSE_URL",
    "STATE_BENCH_REPOSITORY_URL",
    "STATE_BENCH_SOURCE_URL",
    "STATE_BENCH_VERSION",
    "StateBenchCustomerSupportAdapter",
    "normalize_shipment_status",
]
