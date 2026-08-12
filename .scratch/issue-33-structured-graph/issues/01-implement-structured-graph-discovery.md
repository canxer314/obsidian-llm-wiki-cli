# Implement structured and graph discovery

Type: task
Status: resolved

Source: https://github.com/canxer314/obsidian-llm-wiki-cli/issues/33
Blocked by: Issue #32 / PR #48 (resolved)

Implement the feature described in `../spec.md` using the existing contract parser, `vault_discover` service, Search Snapshot manager, and installed Obsidian runtime adapter boundaries.

## Answer

Implemented the closed structured/graph query and projection contract, installed-runtime reference registry and target validation, unique UTF-16-to-UTF-8 span verification, graph-bound immutable snapshots, 250 ms successor publication quiet window, fixtures, runtime tests, and combined projection coverage.

## Comments

- TDD seams: contract parser/schema, Search Snapshot data source/manager, `VaultDiscoverService.execute`, and installed Obsidian adapter.
- Review findings for quiet-window publication and unique target candidates were fixed before completion.
