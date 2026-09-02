# Installed cache and graph causality verdict

> PROTOTYPE ONLY — Obsidian 1.13.4, ThinkFlywheel Vault, 2026-08-01T14:30:22.002Z.

## Verdict

A bounded per-Change-Set barrier is supportable when every touched final Content Version is byte-verified, metadata-changed callback data is hashed and matched to that version, rename is correlated through Vault.rename, and resolvedLinks/unresolvedLinks are polled for the exact source/target postcondition. Timeout fails closed.

- MetadataCache changed callback data was hashable for every observation: **true**
- Stale or late version observations occurred in this run: **true**
- Bounded per-Change-Set success barrier supported by all scenarios: **true**
- Rename requires Vault.rename plus targeted graph probes: **true**

## Scenarios

| Scenario | Result | Barrier observations |
|---|---|---|
| single-write | PASS | single-write: ready @ 1162.2 ms |
| rapid-overwrite | PASS | rapid-final: ready @ 965.4 ms |
| target-rename | PASS | rename-before: ready @ 976.3 ms; rename-after: ready @ 1986.8 ms |
| link-repair | PASS | repair-unresolved: ready @ 1006.5 ms; repair-resolved: ready @ 982.3 ms |

## Evidence

- `report.json` contains the structured result.
- `events.jsonl` contains the complete monotonic event/sample timeline with SHA-256 Content Versions.
