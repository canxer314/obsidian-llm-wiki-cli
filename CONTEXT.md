# LLM CLI for Obsidian

This context covers a personal workflow in which Claude Code reliably operates one or more independently managed Obsidian Vaults. Each Agent Session and operation belongs to exactly one Vault, even when several Vaults are open and operable at the same time.

## Language

**Primary Operator**:
The product's sole MVP user, who personally uses Claude Code to work with their Managed Vaults. Broader Obsidian users are not the initial design target.
_Avoid_: End user, general user

**Open Vault**:
An Obsidian Vault currently loaded by an Obsidian app instance. Being open does not by itself make the Vault available through the Vault Operation Bridge.
_Avoid_: Active workspace, mounted Vault

**Managed Vault**:
An Open Vault in which the Primary Operator has enabled and initialized the Vault Operation Bridge. Each Managed Vault is an independent operation and recovery boundary.
_Avoid_: Configured ThinkFlywheel Vault, shared workspace

**Vault Operation Bridge**:
The agent-first interface through which Claude Code searches, reads, changes, and verifies a Managed Vault. Any Obsidian-hosted controls support oversight and recovery rather than serving as the primary editing interface.
_Avoid_: CLI wrapper, note editor, cross-Vault broker

**Bridge Instance**:
One running Vault Operation Bridge belonging to exactly one Managed Vault. Agent Sessions may share a Bridge Instance only when they operate that same Vault.
_Avoid_: Global bridge, machine bridge

**Multi-Vault Coexistence**:
The ability for multiple Managed Vaults to be open and independently operable at the same time. It does not permit one request or Change Set to span Vaults.
_Avoid_: Cross-Vault operation, unified Vault

**Cross-Vault Operation**:
A discovery, read, Change Set, transaction, link resolution, or recovery action that spans more than one Vault. Cross-Vault Operations are outside the MVP boundary.
_Avoid_: Multi-Vault coexistence

**Change Set**:
A collection of related mutations within one Managed Vault that is validated and previewed as one unit, then either completes in full or restores the pre-execution state after a failure.
_Avoid_: Command batch, script, cross-Vault transaction

**Exact Read**:
A single-note or ordered multi-note read that returns complete, untrimmed content with no silent excerpting or normalization. Transport pagination may carry an Exact Read without changing its semantics.
_Avoid_: Full-text fallback, preview

**Content Version**:
A SHA-256-compatible identity for one exact state of a note, shared by discovery, outline, section, and Exact Read results and used to reject stale reads and writes.
_Avoid_: Modification time, latest version

**Agent Session**:
One independently running Claude Code session bound to one Managed Vault through its Bridge Instance. Multiple Agent Sessions may routinely read and prepare changes against the same Managed Vault.
_Avoid_: User session, editor window, cross-Vault session

**Submission Key**:
An Agent Session-generated identity that makes Change Set submission idempotent across retries and temporary disconnects. Reusing it with identical content returns the existing result; reusing it with different content is rejected.
_Avoid_: Change log ID, Git commit

**Read Dependency**:
A note whose observed Content Version materially informed a Change Set even though that note is not modified. Claude Code may declare it so execution rejects conclusions based on a stale source without treating every previously read note as a dependency.
_Avoid_: Read lock, search result

**Recovery Journal**:
Short-lived durable state that lets one Bridge Instance restore an interrupted Change Set before accepting further writes to its Managed Vault. It is operational recovery state rather than an audit log or version history.
_Avoid_: Audit log, version history, Git backup
