"""PROTOTYPE — interactive terminal for the Vault read/search contract."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import replace
from hashlib import sha256
from typing import Any

from contract_logic import (
    Note,
    continue_read,
    discover,
    exact_read,
    initial_state,
    mutate_note,
    read_section,
    response_size_bytes,
)


BOLD = "\x1b[1m"
DIM = "\x1b[2m"
RESET = "\x1b[0m"
LARGE_PATH = "Sources/processed/2026-05-27-中交信科风电施工智能化算法方案汇报.md"
SMALL_PATH = "Tasks/waiting/审查G109基础底座采购材料.md"


def corpus() -> tuple[Note, ...]:
    return (
        Note(
            "MOCs/MOC-Work.md",
            "# MOC-Work\n\n## Atomics\nFirst branch.\n\n## Atomics\nSecond branch.\n",
            ((1, "MOC-Work"), (2, "Atomics"), (2, "Atomics")),
        ),
        Note(
            LARGE_PATH,
            "风电施工方案\r\n" + "无标题的完整正文。\r\n" * 2600,
            (),
        ),
        Note(
            SMALL_PATH,
            "---\nstatus: waiting\ntags: [采购, 审查]\n---\n# 审查G109\nLink [[MOC-Work]].\n",
            ((1, "审查G109"),),
        ),
        Note(
            "Tasks/waiting/并发会话.md",
            "# Agent Sessions\nConcurrent Agent Sessions read Content Versions.\n",
            ((1, "Agent Sessions"),),
        ),
    )


def _for_display(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _display_content(item) if key == "content" else _for_display(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_for_display(item) for item in value]
    return value


def _display_content(value: Any) -> Any:
    if not isinstance(value, str) or len(value) <= 240:
        return value
    digest = sha256(value.encode("utf-8")).hexdigest()[:16]
    return f"{value[:160]}… <{len(value) - 240} chars folded in terminal> …{value[-80:]} [sha256:{digest}…]"


def sanity_check_display(state, result: dict[str, Any]):
    return replace(
        state,
        request={"prototype_action": "automatic_sanity_check"},
        response={"ok": True, "result": result},
        response_limit=None,
    )


def render(state) -> None:
    os.system("cls" if os.name == "nt" else "clear")
    print(f"{BOLD}PROTOTYPE — Vault read/search contract, round 3{RESET}")
    print(
        f"{DIM}In-memory only. Revision {state.revision}; "
        f"active: {len(state.continuations)}; "
        f"consumed: {len(state.consumed_continuations)}; "
        f"snapshot unavailable: {len(state.unavailable_continuations)}{RESET}\n"
    )
    print(f"{BOLD}Last request{RESET}")
    print(json.dumps(_for_display(state.request), ensure_ascii=False, indent=2) if state.request else "(none)")
    print(f"\n{BOLD}Last response{RESET}")
    print(json.dumps(_for_display(state.response), ensure_ascii=False, indent=2) if state.response else "(none)")
    if state.response is not None:
        size = response_size_bytes(state.response)
        limit = state.response_limit
        limit_text = f" / {limit}" if limit is not None else ""
        print(f"{DIM}Actual compact JSON response bytes: {size}{limit_text}{RESET}")
    print(f"\n{BOLD}Continuation state{RESET}")
    continuation_state = [
        {
            "token": item.token,
            "next_item_position": item.item_position,
            "next_byte_offset": item.byte_offset,
            "max_response_bytes": item.max_response_bytes,
        }
        for item in state.continuations
    ]
    print(json.dumps(continuation_state, ensure_ascii=False, indent=2))
    print(f"{DIM}Consumed tokens: {json.dumps(state.consumed_continuations)}{RESET}")
    print(f"{DIM}Snapshot-unavailable tokens: {json.dumps(state.unavailable_continuations)}{RESET}")
    print(f"\n{BOLD}Content Versions{RESET}")
    print(json.dumps(dict(state.versions), ensure_ascii=False, indent=2))
    print(f"\n{BOLD}Scenarios{RESET}")
    print(f"{BOLD}1{RESET} {DIM}composable all(path + text) discovery with bounded evidence{RESET}")
    print(f"{BOLD}2{RESET} {DIM}ambiguous repeated heading hierarchy{RESET}")
    print(f"{BOLD}3{RESET} {DIM}ordered Exact Read; fill page with the next item's UTF-8 prefix{RESET}")
    print(f"{BOLD}4{RESET} {DIM}consume the active continuation once{RESET}")
    print(f"{BOLD}5{RESET} {DIM}reuse the most recently consumed token{RESET}")
    print(f"{BOLD}6{RESET} {DIM}send a never-issued token{RESET}")
    print(f"{BOLD}7{RESET} {DIM}reject an over-limit Exact Read batch as a whole{RESET}")
    print(f"{BOLD}8{RESET} {DIM}simulate concurrent edit invalidating active continuation{RESET}")
    print(f"{BOLD}9{RESET} {DIM}retry the most recently snapshot-unavailable token{RESET}")
    print(f"{BOLD}s{RESET} {DIM}run automatic byte-for-byte sanity check{RESET}")
    print(f"{BOLD}r{RESET} {DIM}reset in-memory corpus and state{RESET}")
    print(f"{BOLD}q{RESET} {DIM}quit{RESET}")
    print(f"\n{DIM}Long content is folded only for display; response state retains the real text.{RESET}")


def _assert_exact_pages() -> dict[str, int]:
    notes = corpus()
    paths = (SMALL_PATH, SMALL_PATH, LARGE_PATH)
    expected = [next(note.content.encode("utf-8") for note in notes if note.path == path) for path in paths]
    assembled = [bytearray() for _ in paths]
    state = exact_read(initial_state(notes), notes, paths, max_response_bytes=8_000)
    first_token = state.continuations[0].token
    first_items = state.response["result"]["items"]
    assert [item["index"] for item in first_items] == [0, 1, 2]
    assert [item["complete"] for item in first_items] == [True, True, False]
    assert first_items[2]["start_offset"] == 0 < first_items[2]["end_offset"]
    assert response_size_bytes(state.response) > 7_900
    pages = 0
    chunks = 0
    while True:
        pages += 1
        assert state.response is not None and state.response["ok"] is True
        assert response_size_bytes(state.response) <= 8_000
        result = state.response["result"]
        assert result["order"] == [0, 1, 2]
        for item in result["items"]:
            chunks += 1
            index = item["index"]
            content_bytes = item["content"].encode("utf-8")
            assert item["path"] == paths[index]
            assert item["start_offset"] == len(assembled[index])
            assert item["end_offset"] == item["start_offset"] + len(content_bytes)
            assembled[index].extend(content_bytes)
            assert item["complete"] is (item["end_offset"] == len(expected[index]))
        if result["complete"]:
            break
        token = result["continuation"]
        assert token == state.continuations[0].token
        state = continue_read(state, token)
    assert pages >= 3
    assert [bytes(item) for item in assembled] == expected
    assert b"\r\n" in assembled[2]
    assert assembled[0] == assembled[1]

    consumed = continue_read(state, first_token)
    assert consumed.response["error"]["code"] == "continuation_consumed"
    unknown = continue_read(state, "opaque:never-issued")
    assert unknown.response["error"]["code"] == "invalid_continuation"
    return {
        "pages": pages,
        "chunks": chunks,
        "exact_bytes": sum(map(len, expected)),
        "first_page_bytes": response_size_bytes(exact_read(
            initial_state(notes), notes, paths, max_response_bytes=8_000
        ).response),
    }


def run_sanity_check() -> dict[str, Any]:
    notes = corpus()

    discovery = discover(initial_state(notes), notes)
    discovery_result = discovery.response["result"]
    assert discovery.request["input"]["query"]["all"]
    assert len(discovery_result["items"]) == 1
    match = discovery_result["items"][0]["matches"][0]
    assert match["start_offset"] < match["end_offset"]
    assert set(match["context"]) == {"start_line", "end_line", "text", "truncated"}
    outline = discovery_result["items"][0]["outline"][0]
    assert {"hierarchy", "occurrence", "start_line", "start_offset"} <= set(outline)

    ambiguous = read_section(initial_state(notes), notes, "MOCs/MOC-Work.md", ("MOC-Work", "Atomics"))
    assert ambiguous.response["error"]["code"] == "ambiguous_heading"
    assert [candidate["occurrence"] for candidate in ambiguous.response["error"]["details"]["candidates"]] == [1, 2]

    exact_stats = _assert_exact_pages()

    too_large = exact_read(initial_state(notes), notes, (LARGE_PATH, LARGE_PATH))
    assert too_large.response["error"]["code"] == "exact_read_batch_too_large"
    assert "result" not in too_large.response
    assert all("content" not in item for item in too_large.response["error"]["details"]["items"])
    assert [item["index"] for item in too_large.response["error"]["details"]["items"]] == [0, 1]

    state = exact_read(initial_state(notes), notes, (LARGE_PATH,), max_response_bytes=8_000)
    invalidated_token = state.continuations[0].token
    state, notes = mutate_note(state, notes, LARGE_PATH)
    state = continue_read(state, invalidated_token)
    assert state.response["error"]["code"] == "continuation_snapshot_unavailable"

    interactive_notes = corpus()
    interactive = exact_read(initial_state(interactive_notes), interactive_notes, (LARGE_PATH,), max_response_bytes=8_000)
    interactive = continue_read(interactive, interactive.continuations[0].token)
    interactive, interactive_notes = mutate_note(interactive, interactive_notes, LARGE_PATH)
    semantic_state = (
        interactive.revision,
        interactive.continuations,
        interactive.consumed_continuations,
        interactive.unavailable_continuations,
        interactive.versions,
        interactive.next_continuation_id,
    )
    displayed = sanity_check_display(interactive, {"independent_corpus": "passed"})
    assert (
        displayed.revision,
        displayed.continuations,
        displayed.consumed_continuations,
        displayed.unavailable_continuations,
        displayed.versions,
        displayed.next_continuation_id,
    ) == semantic_state
    assert displayed.versions == tuple((note.path, note.content_version) for note in interactive_notes)

    return {
        "discovery": "composable query and bounded evidence passed",
        "heading": "duplicate hierarchy ambiguity passed",
        "exact_read": exact_stats,
        "logical_limit": "whole-batch rejection passed",
        "continuations": "unknown, consumed, and unavailable classifications passed",
        "sanity_isolation": "interactive revision, versions, and token state preserved",
    }


def main() -> None:
    if "--check" in sys.argv:
        print(json.dumps(run_sanity_check(), ensure_ascii=False, indent=2))
        print("all round-3 prototype scenarios passed")
        return

    notes = corpus()
    state = initial_state(notes)
    while True:
        render(state)
        choice = input("\nAction: ").strip().lower()
        if choice == "q":
            return
        if choice == "r":
            notes = corpus()
            state = initial_state(notes)
        elif choice == "s":
            state = sanity_check_display(state, run_sanity_check())
        elif choice == "1":
            state = discover(state, notes)
        elif choice == "2":
            state = read_section(state, notes, "MOCs/MOC-Work.md", ("MOC-Work", "Atomics"))
        elif choice == "3":
            state = exact_read(state, notes, (SMALL_PATH, SMALL_PATH, LARGE_PATH), max_response_bytes=8_000)
        elif choice == "4":
            cursor = state.continuations[0].token if state.continuations else "opaque:no-active-token"
            state = continue_read(state, cursor)
        elif choice == "5":
            cursor = state.consumed_continuations[-1] if state.consumed_continuations else "opaque:no-consumed-token"
            state = continue_read(state, cursor)
        elif choice == "6":
            state = continue_read(state, "opaque:never-issued")
        elif choice == "7":
            state = exact_read(state, notes, (LARGE_PATH, LARGE_PATH))
        elif choice == "8":
            state, notes = mutate_note(state, notes, LARGE_PATH)
        elif choice == "9":
            cursor = state.unavailable_continuations[-1] if state.unavailable_continuations else "opaque:no-unavailable-token"
            state = continue_read(state, cursor)


if __name__ == "__main__":
    main()
