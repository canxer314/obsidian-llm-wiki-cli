# LLM CLI for Obsidian

This context covers a personal workflow in which Claude Code reliably operates an Obsidian vault. The product outcome is implementation-neutral: an Obsidian plugin, MCP server, local service, or a combination may provide it.

## Language

**Primary Operator**:
The plugin's sole MVP user, who personally uses Claude Code to work in the ThinkFlywheel Vault. Broader Obsidian users are not the initial design target.
_Avoid_: End user, general user

**ThinkFlywheel Vault**:
The Primary Operator's Obsidian vault located at `C:\Obsidian\ThinkFlywheelVault`, and the sole vault targeted by the MVP.
_Avoid_: Workspace, repository

**Vault Operation Bridge**:
The implementation-neutral, agent-first interface through which Claude Code searches, reads, changes, and verifies the ThinkFlywheel Vault. Any Obsidian-hosted controls support oversight rather than serving as the primary editing interface.
_Avoid_: Obsidian plugin, CLI wrapper, note editor

**Change Set**:
A collection of related Vault mutations that is validated and previewed as one unit, then either completes in full or restores the pre-execution state after a failure.
_Avoid_: Command batch, script

**Exact Read**:
A single-note or ordered multi-note read that returns complete, untrimmed content with no silent excerpting or normalization. Transport pagination may carry an Exact Read without changing its semantics.
_Avoid_: Full-text fallback, preview

**Content Version**:
A SHA-256-compatible identity for one exact state of a note, shared by discovery, outline, section, and Exact Read results and used to reject stale reads and writes.
_Avoid_: Modification time, latest version

**Agent Session**:
One independently running Claude Code session connected to the Vault Operation Bridge. Multiple Agent Sessions routinely read and prepare changes against the same ThinkFlywheel Vault.
_Avoid_: User session, editor window

**Submission Key**:
An Agent Session-generated identity that makes Change Set submission idempotent across retries and temporary disconnects. Reusing it with identical content returns the existing result; reusing it with different content is rejected.
_Avoid_: Change log ID, Git commit

**Read Dependency**:
A note whose observed Content Version materially informed a Change Set even though that note is not modified. Claude Code may declare it so execution rejects conclusions based on a stale source without treating every previously read note as a dependency.
_Avoid_: Read lock, search result

**Recovery Journal**:
Short-lived durable state that lets the Vault Operation Bridge restore an interrupted Change Set before accepting further writes. It exists only for crash recovery and is removed after success or completed restoration.
_Avoid_: Audit log, version history, Git backup

**Managed Trash**:
The Bridge-owned private trash location inside the Vault's Bridge state directory. Trashing a note or attachment hard-links its exact bytes there before the public path disappears, so every trash is reversible during crash recovery and the Bridge never permanently deletes Vault content. Its private paths never appear in public results.
_Avoid_: Recycle bin, system trash, deletion

**Semantic Evidence**:
The Obsidian-layer confirmation that a Change Set's mutations became visible to the rest of the Vault — required Vault events for ordinary operations, plus targeted metadata-cache and reference probes for Managed Trash and restore, which emit no generic events. Success is reported only after Semantic Evidence converges within its deadline; otherwise the Change Set rolls back or fails closed.
_Avoid_: Indexing, search results, cache warm-up

## Repository Automation Language

**Automation Command**:
A request for one repository automation operation on an Automation Work Item. The command may be requested by the Primary Operator or by a defined automation transition, remains independently visible and retryable, and does not rely on a previous Agent Session remaining alive.
_Avoid_: In-memory pipeline stage, automatic repair

**Automation Work Item**:
The durable repository record that carries one unit of automation work, its proposed changes, and its discussion across independent Agent Sessions.
_Avoid_: Claim receipt, local job record

**Blocked Automation**:
An Automation Command that stopped without a publishable result and requires the Primary Operator to inspect the failure before explicitly retrying it. It is not a terminal state of the Automation Work Item.
_Avoid_: Failed issue, repair-budget exhaustion

**Legacy Run State**:
Local, partially completed execution state created by the retired repository automation system. It is not an Automation Work Item and is not adopted, resumed, or treated as migration input by the replacement system.
_Avoid_: Issue #127, recoverable job, migration checkpoint

**Dispatcher**:
The trusted scheduler that discovers Automation Commands, starts isolated jobs, enforces concurrency and time limits, and reports outcomes. It does not decide the business behavior of an Automation Command.
_Avoid_: Workflow engine, claim service

**Target Checkout**:
A disposable repository copy at the exact revision authorized by an Automation Command. It contains the operation, rules, dependencies, source code, and Git state used by that job and shares no mutable worktree registration with the Primary Operator's development checkout.
_Avoid_: Control snapshot, shared worktree, permanent workspace
