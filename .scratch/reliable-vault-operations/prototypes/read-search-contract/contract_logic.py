"""PROTOTYPE — pure state model for the Vault read/search contract."""

from __future__ import annotations

import json
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
class ExactSnapshot:
    index: int
    path: str
    content_version: str
    content: str

    @property
    def encoded(self) -> bytes:
        return self.content.encode("utf-8")


@dataclass(frozen=True)
class ExactContinuation:
    token: str
    items: tuple[ExactSnapshot, ...]
    item_position: int
    byte_offset: int
    max_response_bytes: int


@dataclass(frozen=True)
class ProtocolState:
    revision: int
    request: dict[str, Any] | None
    response: dict[str, Any] | None
    continuations: tuple[ExactContinuation, ...]
    consumed_continuations: tuple[str, ...]
    unavailable_continuations: tuple[str, ...]
    versions: tuple[tuple[str, str], ...]
    next_continuation_id: int
    response_limit: int | None


@dataclass(frozen=True)
class Page:
    response: dict[str, Any]
    item_position: int
    byte_offset: int
    complete: bool


def initial_state(notes: tuple[Note, ...]) -> ProtocolState:
    return ProtocolState(
        revision=0,
        request=None,
        response=None,
        continuations=(),
        consumed_continuations=(),
        unavailable_continuations=(),
        versions=tuple((note.path, note.content_version) for note in notes),
        next_continuation_id=1,
        response_limit=None,
    )


def response_size_bytes(response: dict[str, Any]) -> int:
    return len(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _envelope(state: ProtocolState, result: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "vault_revision": state.revision, "result": result}


def _error(state: ProtocolState, code: str, message: str, details: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": False,
        "vault_revision": state.revision,
        "error": {"code": code, "message": message, "retryable": False, "details": details},
    }


def _ordered_notes(notes: tuple[Note, ...]) -> list[Note]:
    return sorted(notes, key=lambda note: (note.path.casefold(), note.path.encode("utf-8")))


def _outline(note: Note) -> list[dict[str, Any]]:
    lines = note.content.splitlines(keepends=True)
    stack: list[tuple[int, str]] = []
    occurrences: dict[tuple[str, ...], int] = {}
    result = []
    heading_number = 0
    byte_offset = 0
    for line_number, line_with_ending in enumerate(lines, start=1):
        line = line_with_ending.rstrip("\r\n")
        if heading_number >= len(note.headings):
            break
        level, title = note.headings[heading_number]
        marker = "#" * level + " " + title
        if line != marker:
            byte_offset += len(line_with_ending.encode("utf-8"))
            continue
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, title))
        hierarchy = tuple(item[1] for item in stack)
        occurrences[hierarchy] = occurrences.get(hierarchy, 0) + 1
        result.append({
            "level": level,
            "title": title,
            "hierarchy": list(hierarchy),
            "occurrence": occurrences[hierarchy],
            "start_line": line_number,
            "start_offset": byte_offset,
        })
        heading_number += 1
        byte_offset += len(line_with_ending.encode("utf-8"))
    return result


def discover(state: ProtocolState, notes: tuple[Note, ...]) -> ProtocolState:
    request = {
        "tool": "vault_discover",
        "input": {
            "query": {
                "all": [
                    {"path": {"prefix": "Tasks/"}},
                    {"text": {"query": "Agent Sessions", "mode": "literal", "case_sensitive": False}},
                ]
            },
            "select": ["identity", "outline", "matches"],
            "context": {
                "before_lines": 1,
                "after_lines": 1,
                "max_chars_per_match": 240,
                "max_matches_per_note": 20,
            },
            "page": {"max_items": 2},
        },
    }
    query = "Agent Sessions"
    hits = []
    for note in _ordered_notes(notes):
        if not note.path.startswith("Tasks/"):
            continue
        lines = note.content.splitlines(keepends=True)
        plain_lines = [line.rstrip("\r\n") for line in lines]
        line_index = next(
            (index for index, line in enumerate(plain_lines) if query.casefold() in line.casefold()),
            None,
        )
        if line_index is None:
            continue
        matched_line = plain_lines[line_index]
        character_index = matched_line.casefold().index(query.casefold())
        line_start = sum(len(line.encode("utf-8")) for line in lines[:line_index])
        start_offset = line_start + len(matched_line[:character_index].encode("utf-8"))
        end_offset = start_offset + len(matched_line[character_index:character_index + len(query)].encode("utf-8"))
        context_start = max(0, line_index - 1)
        context_end = min(len(lines), line_index + 2)
        context_text = "".join(lines[context_start:context_end])
        max_chars = 240
        truncated = len(context_text) > max_chars
        if truncated:
            context_text = context_text[:max_chars]
        hits.append({
            "note": {
                "path": note.path,
                "content_version": note.content_version,
                "size_bytes": note.size_bytes,
            },
            "matches": [{
                "line": line_index + 1,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "text": matched_line[character_index:character_index + len(query)],
                "context": {
                    "start_line": context_start + 1,
                    "end_line": context_end,
                    "text": context_text,
                    "truncated": truncated,
                },
            }],
            "outline": _outline(note),
        })
    response = _envelope(state, {
        "ordering": [
            {"field": "path", "direction": "asc", "comparison": "unicode_casefold", "tie_breaker": "path_utf8_bytes"}
        ],
        "items": hits[:2],
        "continuation": None,
        "complete": True,
    })
    return replace(state, request=request, response=response, continuations=(), response_limit=None)


def read_section(
    state: ProtocolState,
    notes: tuple[Note, ...],
    path: str,
    hierarchy: tuple[str, ...],
    occurrence: int | None = None,
) -> ProtocolState:
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
    candidates = [item for item in _outline(note) if item["hierarchy"] == list(hierarchy)]
    if len(candidates) > 1 and occurrence is None:
        response = _error(state, "ambiguous_heading", "Heading hierarchy resolves more than once.", {
            "path": path,
            "content_version": note.content_version,
            "candidates": [
                {"hierarchy": item["hierarchy"], "occurrence": item["occurrence"]}
                for item in candidates
            ],
        })
    else:
        response = _envelope(state, {
            "order": [0],
            "items": [{
                "index": 0,
                "path": path,
                "mode": "section",
                "content_version": note.content_version,
                "heading": {"hierarchy": list(hierarchy), "occurrence": occurrence or 1},
                "content": f"## {hierarchy[-1]}\nSelected section body.\n",
                "complete": True,
            }],
            "complete": True,
            "continuation": None,
        })
    return replace(state, request=request, response=response, continuations=(), response_limit=None)


def _newline_kind(content: str) -> str:
    crlf = content.count("\r\n")
    without_crlf = content.replace("\r\n", "")
    lf = without_crlf.count("\n")
    cr = without_crlf.count("\r")
    kinds = sum(value > 0 for value in (crlf, lf, cr))
    if kinds == 0:
        return "none"
    if kinds > 1:
        return "mixed"
    if crlf:
        return "crlf"
    if lf:
        return "lf"
    return "cr"


def _chunk(snapshot: ExactSnapshot, start: int, content: str, complete: bool) -> dict[str, Any]:
    encoded = content.encode("utf-8")
    return {
        "index": snapshot.index,
        "path": snapshot.path,
        "mode": "exact",
        "content_version": snapshot.content_version,
        "size_bytes": len(snapshot.encoded),
        "start_offset": start,
        "end_offset": start + len(encoded),
        "content": content,
        "encoding": "utf-8",
        "newline": _newline_kind(snapshot.content),
        "complete": complete,
    }


def _page_response(
    state: ProtocolState,
    snapshots: tuple[ExactSnapshot, ...],
    chunks: list[dict[str, Any]],
    continuation: str | None,
    initial: bool,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "order": [item.index for item in snapshots],
        "items": chunks,
        "continuation": continuation,
        "complete": continuation is None,
    }
    if initial:
        result["snapshot"] = {
            "items": [
                {"index": item.index, "path": item.path, "content_version": item.content_version}
                for item in snapshots
            ]
        }
    else:
        result["snapshot_preserved"] = True
    return _envelope(state, result)


def _build_page(
    state: ProtocolState,
    snapshots: tuple[ExactSnapshot, ...],
    item_position: int,
    byte_offset: int,
    max_response_bytes: int,
    next_token: str,
    initial: bool,
) -> Page:
    chunks: list[dict[str, Any]] = []
    position = item_position
    offset = byte_offset
    while position < len(snapshots):
        snapshot = snapshots[position]
        remaining_text = snapshot.encoded[offset:].decode("utf-8")
        full_chunk = _chunk(snapshot, offset, remaining_text, True)
        has_later_item = position + 1 < len(snapshots)
        full_response = _page_response(
            state,
            snapshots,
            chunks + [full_chunk],
            next_token if has_later_item else None,
            initial,
        )
        if response_size_bytes(full_response) <= max_response_bytes:
            chunks.append(full_chunk)
            position += 1
            offset = 0
            if position == len(snapshots):
                return Page(
                    _page_response(state, snapshots, chunks, None, initial),
                    position,
                    offset,
                    True,
                )
            continue
        low = 1
        high = len(remaining_text)
        best_text: str | None = None
        while low <= high:
            middle = (low + high) // 2
            candidate_text = remaining_text[:middle]
            candidate = _chunk(snapshot, offset, candidate_text, False)
            candidate_response = _page_response(
                state,
                snapshots,
                chunks + [candidate],
                next_token,
                initial,
            )
            if response_size_bytes(candidate_response) <= max_response_bytes:
                best_text = candidate_text
                low = middle + 1
            else:
                high = middle - 1
        if best_text is None:
            if chunks:
                return Page(
                    _page_response(state, snapshots, chunks, next_token, initial),
                    position,
                    offset,
                    False,
                )
            response = _error(state, "response_item_too_large", "Transport limit cannot carry one content character plus metadata.", {
                "index": snapshot.index,
                "path": snapshot.path,
                "limit_bytes": max_response_bytes,
            })
            return Page(response, position, offset, True)
        partial = _chunk(snapshot, offset, best_text, False)
        return Page(
            _page_response(state, snapshots, chunks + [partial], next_token, initial),
            position,
            partial["end_offset"],
            False,
        )
    return Page(_page_response(state, snapshots, chunks, None, initial), position, offset, True)


def _next_token(state: ProtocolState) -> str:
    return f"opaque:exact:{state.next_continuation_id:04d}"


def exact_read(
    state: ProtocolState,
    notes: tuple[Note, ...],
    paths: tuple[str, ...],
    max_response_bytes: int = DEFAULT_RESPONSE_BYTES,
) -> ProtocolState:
    request = {
        "tool": "vault_read",
        "input": {
            "reads": [{"path": path, "mode": "exact"} for path in paths],
            "transport": {"max_response_bytes": max_response_bytes},
        },
    }
    selected = [next(note for note in notes if note.path == path) for path in paths]
    snapshots = tuple(
        ExactSnapshot(index, note.path, note.content_version, note.content)
        for index, note in enumerate(selected)
    )
    total = sum(len(item.encoded) for item in snapshots)
    if total > MAX_EXACT_READ_BYTES:
        response = _error(state, "exact_read_batch_too_large", "The ordered Exact Read batch is rejected as a whole.", {
            "limit_bytes": MAX_EXACT_READ_BYTES,
            "requested_bytes": total,
            "items": [
                {
                    "index": item.index,
                    "path": item.path,
                    "content_version": item.content_version,
                    "size_bytes": len(item.encoded),
                }
                for item in snapshots
            ],
            "suggested_groups": [[item.index] for item in snapshots],
        })
        return replace(state, request=request, response=response, continuations=(), response_limit=None)

    token = _next_token(state)
    page = _build_page(state, snapshots, 0, 0, max_response_bytes, token, True)
    continuations: tuple[ExactContinuation, ...] = ()
    if not page.complete:
        continuations = (ExactContinuation(
            token,
            snapshots,
            page.item_position,
            page.byte_offset,
            max_response_bytes,
        ),)
    return replace(
        state,
        request=request,
        response=page.response,
        continuations=continuations,
        next_continuation_id=state.next_continuation_id + 1,
        response_limit=max_response_bytes,
    )


def continue_read(state: ProtocolState, cursor: str) -> ProtocolState:
    request = {"tool": "vault_continue", "input": {"continuation": cursor}}
    continuation = next((item for item in state.continuations if item.token == cursor), None)
    if continuation is None:
        if cursor in state.unavailable_continuations:
            response = _error(
                state,
                "continuation_snapshot_unavailable",
                "The immutable bytes bound to this continuation are no longer available.",
                {"continuation": cursor},
            )
        elif cursor in state.consumed_continuations:
            response = _error(
                state,
                "continuation_consumed",
                "This single-use continuation has already been consumed.",
                {"continuation": cursor},
            )
        else:
            response = _error(
                state,
                "invalid_continuation",
                "Continuation was never issued by this in-memory protocol state.",
                {"continuation": cursor},
            )
        return replace(state, request=request, response=response, response_limit=None)

    next_token = _next_token(state)
    page = _build_page(
        state,
        continuation.items,
        continuation.item_position,
        continuation.byte_offset,
        continuation.max_response_bytes,
        next_token,
        False,
    )
    remaining: tuple[ExactContinuation, ...] = ()
    if not page.complete:
        remaining = (ExactContinuation(
            next_token,
            continuation.items,
            page.item_position,
            page.byte_offset,
            continuation.max_response_bytes,
        ),)
    return replace(
        state,
        request=request,
        response=page.response,
        continuations=remaining,
        consumed_continuations=state.consumed_continuations + (cursor,),
        next_continuation_id=state.next_continuation_id + 1,
        response_limit=continuation.max_response_bytes,
    )


def mutate_note(
    state: ProtocolState,
    notes: tuple[Note, ...],
    path: str,
) -> tuple[ProtocolState, tuple[Note, ...]]:
    mutated = tuple(replace(note, content=note.content + "External edit.\n") if note.path == path else note for note in notes)
    invalidated = tuple(
        continuation.token
        for continuation in state.continuations
        if any(item.path == path for item in continuation.items)
    )
    active = tuple(
        continuation
        for continuation in state.continuations
        if continuation.token not in invalidated
    )
    next_state = replace(
        state,
        revision=state.revision + 1,
        request={"simulation": "concurrent note edit", "path": path},
        response={
            "new_content_version": next(note.content_version for note in mutated if note.path == path),
            "invalidated_continuations": list(invalidated),
        },
        versions=tuple((note.path, note.content_version) for note in mutated),
        continuations=active,
        unavailable_continuations=state.unavailable_continuations + invalidated,
        response_limit=None,
    )
    return next_state, mutated
