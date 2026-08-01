"""PROTOTYPE — pure state model for the Vault read/search contract."""

from __future__ import annotations

from dataclasses import dataclass, replace
from hashlib import sha256
from typing import Any


MAX_EXACT_READ_BYTES = 100_000
DEFAULT_RESPONSE_BYTES = 32_000


@dataclass(frozen=True)
class Note:
    path: str
    content: str
    headings: tuple[tuple[int, str], ...]

    @property
    def content_version(self) -> str:
        return f"sha256:{sha256(self.content.encode('utf-8')).hexdigest()}"

    @property
    def size_bytes(self) -> int:
        return len(self.content.encode("utf-8"))


@dataclass(frozen=True)
class ProtocolState:
    revision: int
    request: dict[str, Any] | None
    response: dict[str, Any] | None
    continuations: tuple[str, ...]
    versions: tuple[tuple[str, str], ...]


def initial_state(notes: tuple[Note, ...]) -> ProtocolState:
    return ProtocolState(
        revision=0,
        request=None,
        response=None,
        continuations=(),
        versions=tuple((note.path, note.content_version) for note in notes),
    )


def _envelope(state: ProtocolState, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "vault_revision": state.revision,
        "result": result,
    }


def _error(state: ProtocolState, code: str, message: str, details: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": False,
        "vault_revision": state.revision,
        "error": {"code": code, "message": message, "retryable": False, "details": details},
    }


def discover(state: ProtocolState, notes: tuple[Note, ...], query: str) -> ProtocolState:
    request = {
        "tool": "vault_discover",
        "input": {
            "query": {"text": query},
            "select": ["identity", "outline", "matches"],
            "context": {"before_lines": 1, "after_lines": 1, "max_chars_per_match": 240},
            "page": {"max_items": 2},
        },
    }
    hits = []
    for note in sorted(notes, key=lambda item: item.path.casefold()):
        line_index = next((i for i, line in enumerate(note.content.splitlines()) if query.casefold() in line.casefold()), None)
        if line_index is None:
            continue
        lines = note.content.splitlines()
        start = max(0, line_index - 1)
        end = min(len(lines), line_index + 2)
        hits.append({
            "note": {"path": note.path, "content_version": note.content_version, "size_bytes": note.size_bytes},
            "matches": [{
                "line": line_index + 1,
                "start_offset": len("\n".join(lines[:line_index]).encode("utf-8")) + (1 if line_index else 0),
                "text": lines[line_index],
                "context": lines[start:end],
            }],
            "outline": [{"level": level, "title": title} for level, title in note.headings],
        })
    page = hits[:2]
    cursor = "cont:discover:page-2" if len(hits) > 2 else None
    response = _envelope(state, {
        "ordering": "path_unicode_casefold_ascending",
        "items": page,
        "continuation": cursor,
        "complete": cursor is None,
    })
    return replace(state, request=request, response=response, continuations=(cursor,) if cursor else ())


def read_section(state: ProtocolState, notes: tuple[Note, ...], path: str, hierarchy: tuple[str, ...], occurrence: int | None = None) -> ProtocolState:
    request = {
        "tool": "vault_read",
        "input": {
            "reads": [{
                "path": path,
                "mode": "section",
                "heading": {"hierarchy": list(hierarchy), **({"occurrence": occurrence} if occurrence else {})},
            }]
        },
    }
    note = next(item for item in notes if item.path == path)
    count = sum(1 for _, title in note.headings if title == hierarchy[-1])
    if count > 1 and occurrence is None:
        response = _error(state, "ambiguous_heading", "Heading hierarchy resolves more than once.", {
            "path": path,
            "content_version": note.content_version,
            "candidates": [{"hierarchy": list(hierarchy), "occurrence": i + 1} for i in range(count)],
        })
    else:
        response = _envelope(state, {
            "items": [{
                "path": path,
                "mode": "section",
                "content_version": note.content_version,
                "heading": {"hierarchy": list(hierarchy), "occurrence": occurrence or 1},
                "content": f"## {hierarchy[-1]}\nSelected section body.\n",
                "complete": True,
            }]
        })
    return replace(state, request=request, response=response, continuations=())


def exact_read(state: ProtocolState, notes: tuple[Note, ...], paths: tuple[str, ...], max_response_bytes: int = DEFAULT_RESPONSE_BYTES) -> ProtocolState:
    request = {
        "tool": "vault_read",
        "input": {
            "reads": [{"path": path, "mode": "exact"} for path in paths],
            "transport": {"max_response_bytes": max_response_bytes},
        },
    }
    selected = [next(note for note in notes if note.path == path) for path in paths]
    total = sum(note.size_bytes for note in selected)
    if total > MAX_EXACT_READ_BYTES:
        response = _error(state, "exact_read_batch_too_large", "The ordered Exact Read batch is rejected as a whole.", {
            "limit_bytes": MAX_EXACT_READ_BYTES,
            "requested_bytes": total,
            "items": [{"path": n.path, "content_version": n.content_version, "size_bytes": n.size_bytes} for n in selected],
            "suggested_groups": [[n.path] for n in selected],
        })
        return replace(state, request=request, response=response, continuations=())

    cursor = "cont:exact:chunk-2" if total > max_response_bytes else None
    items = []
    remaining = max_response_bytes
    for note in selected:
        encoded = note.content.encode("utf-8")
        delivered = encoded[:remaining].decode("utf-8", errors="ignore") if cursor else note.content
        items.append({
            "path": note.path,
            "mode": "exact",
            "content_version": note.content_version,
            "size_bytes": note.size_bytes,
            "content": delivered,
            "complete": not cursor or len(delivered.encode("utf-8")) == note.size_bytes,
        })
        remaining = max(0, remaining - len(delivered.encode("utf-8")))
    response = _envelope(state, {
        "order": list(paths),
        "items": items,
        "continuation": cursor,
        "complete": cursor is None,
        "snapshot": {"content_versions": {n.path: n.content_version for n in selected}},
    })
    return replace(state, request=request, response=response, continuations=(cursor,) if cursor else ())


def continue_read(state: ProtocolState, cursor: str) -> ProtocolState:
    request = {"tool": "vault_continue", "input": {"continuation": cursor}}
    if cursor not in state.continuations:
        response = _error(state, "invalid_continuation", "Continuation is unknown, expired, or already consumed.", {})
    else:
        response = _envelope(state, {
            "items": [{"content": "<remaining exact bytes>", "complete": True}],
            "continuation": None,
            "complete": True,
            "snapshot_preserved": True,
        })
    return replace(state, request=request, response=response, continuations=())


def mutate_note(state: ProtocolState, notes: tuple[Note, ...], path: str) -> tuple[ProtocolState, tuple[Note, ...]]:
    mutated = tuple(replace(note, content=note.content + "External edit.\n") if note.path == path else note for note in notes)
    next_state = replace(
        state,
        revision=state.revision + 1,
        request={"simulation": "concurrent note edit", "path": path},
        response={"new_content_version": next(n.content_version for n in mutated if n.path == path)},
        versions=tuple((note.path, note.content_version) for note in mutated),
        continuations=(),
    )
    return next_state, mutated
