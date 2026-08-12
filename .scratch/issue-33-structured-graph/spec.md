# Discover structured and graph evidence safely

Source: https://github.com/canxer314/obsidian-llm-wiki-cli/issues/33

## Goal

Extend the existing `vault_discover` operation so typed Frontmatter, tag, registered-reference, backlink, unresolved-link, and graph predicates compose with path and text predicates over one immutable Search Snapshot.

## Prerequisite

Issue #32 / PR #48 provides immutable Search Snapshot discovery and is merged into the implementation baseline.

## Acceptance criteria

- The closed query grammar composes typed Frontmatter, tag, reference, backlink, unresolved-link, graph, path, and text predicates.
- The installed-runtime registry exposes only proven wikilink, embed, Markdown inline-link, and Markdown embed profiles; unknown, ambiguous, and disabled grammar fails closed.
- Reference targets and renderers preserve registered syntax without normalization heuristics.
- Host UTF-16 positions are locators only; a reference span must map uniquely and verify against raw UTF-8 bytes.
- Rename, deletion, target creation, and unresolved-link changes invalidate new discovery and publish coherent successor evidence only after a 250 ms quiet window.
- Versioned fixtures and installed-runtime tests cover registered profiles, repeated text, ambiguous spans and targets, graph updates, and combined projections.

## Public boundary

This feature extends `vault_discover`; Search Snapshot identity and publication remain internal. It adds no public tool or snapshot handle.
