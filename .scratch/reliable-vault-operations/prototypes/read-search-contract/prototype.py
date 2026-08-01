"""PROTOTYPE — interactive terminal for the Vault read/search contract."""

from __future__ import annotations

import json
import os

from contract_logic import (
    Note,
    continue_read,
    discover,
    exact_read,
    initial_state,
    mutate_note,
    read_section,
)


BOLD = "\x1b[1m"
DIM = "\x1b[2m"
RESET = "\x1b[0m"


def corpus() -> tuple[Note, ...]:
    return (
        Note(
            "MOCs/MOC-Work.md",
            "# MOC-Work\n\n## Atomics\nFirst branch.\n\n## Atomics\nSecond branch.\n",
            ((1, "MOC-Work"), (2, "Atomics"), (2, "Atomics")),
        ),
        Note(
            "Sources/processed/2026-05-27-中交信科风电施工智能化算法方案汇报.md",
            "风电施工方案\r\n" + "无标题的完整正文。\r\n" * 2600,
            (),
        ),
        Note(
            "Tasks/waiting/审查G109基础底座采购材料.md",
            "---\nstatus: waiting\ntags: [采购, 审查]\n---\n# 审查G109\nLink [[MOC-Work]].\n",
            ((1, "审查G109"),),
        ),
        Note(
            "Tasks/waiting/并发会话.md",
            "# Agent Sessions\nConcurrent Agent Sessions read Content Versions.\n",
            ((1, "Agent Sessions"),),
        ),
    )


def render(state) -> None:
    os.system("cls" if os.name == "nt" else "clear")
    print(f"{BOLD}PROTOTYPE — Vault read/search contract{RESET}")
    print(f"{DIM}In-memory only. Revision {state.revision}; active continuations: {len(state.continuations)}{RESET}\n")
    print(f"{BOLD}Last request{RESET}")
    print(json.dumps(state.request, ensure_ascii=False, indent=2) if state.request else "(none)")
    print(f"\n{BOLD}Last response{RESET}")
    print(json.dumps(state.response, ensure_ascii=False, indent=2) if state.response else "(none)")
    print(f"\n{BOLD}Snapshot state{RESET}")
    print(json.dumps(dict(state.versions), ensure_ascii=False, indent=2))
    print(f"\n{BOLD}Scenarios{RESET}")
    print(f"{BOLD}1{RESET} {DIM}discover with bounded context + outline{RESET}")
    print(f"{BOLD}2{RESET} {DIM}ambiguous repeated heading hierarchy{RESET}")
    print(f"{BOLD}3{RESET} {DIM}ordered Exact Read with transport continuation{RESET}")
    print(f"{BOLD}4{RESET} {DIM}continue the current immutable snapshot{RESET}")
    print(f"{BOLD}5{RESET} {DIM}reject an over-limit Exact Read batch as a whole{RESET}")
    print(f"{BOLD}6{RESET} {DIM}simulate concurrent edit invalidating continuation{RESET}")
    print(f"{BOLD}q{RESET} {DIM}quit{RESET}")


def main() -> None:
    notes = corpus()
    state = initial_state(notes)
    while True:
        render(state)
        choice = input("\nAction: ").strip().lower()
        if choice == "q":
            return
        if choice == "1":
            state = discover(state, notes, "Agent Sessions")
        elif choice == "2":
            state = read_section(state, notes, "MOCs/MOC-Work.md", ("MOC-Work", "Atomics"))
        elif choice == "3":
            state = exact_read(
                state,
                notes,
                (
                    "Tasks/waiting/审查G109基础底座采购材料.md",
                    "Sources/processed/2026-05-27-中交信科风电施工智能化算法方案汇报.md",
                ),
                max_response_bytes=8_000,
            )
        elif choice == "4":
            cursor = state.continuations[0] if state.continuations else "cont:missing"
            state = continue_read(state, cursor)
        elif choice == "5":
            state = exact_read(
                state,
                notes,
                (
                    "Sources/processed/2026-05-27-中交信科风电施工智能化算法方案汇报.md",
                    "Sources/processed/2026-05-27-中交信科风电施工智能化算法方案汇报.md",
                ),
            )
        elif choice == "6":
            state, notes = mutate_note(state, notes, "Sources/processed/2026-05-27-中交信科风电施工智能化算法方案汇报.md")


if __name__ == "__main__":
    main()
