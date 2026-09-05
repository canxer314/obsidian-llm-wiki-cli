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

## Automation Language

These terms govern the repository's label-driven automation (the local Dispatcher and its operations). GitHub Issues, Pull Requests, branches, labels, and comments are the only durable business state.

**Automation Command**:
One visible and independently retryable repository operation, represented by a trigger label or a defined schedule. The Dispatcher discovers, acquires, and executes Automation Commands; it never invents them implicitly.
_Avoid_: Job spec, hidden claim, task record

**Automation Work Item**:
The durable repository record — a GitHub Issue or Pull Request — that carries an Automation Command's work, discussion, labels, and history.
_Avoid_: Ticket database row, local work record

**Blocked Automation**:
An operation failure (execution, timeout, push, or publication) marked with `agent:blocked` that requires operator inspection and deliberate manual retry. It never terminalizes the Automation Work Item and is never retried automatically. Feedback failures are typed by stage (`feedback-execution`, `feedback-publication`, `feedback-convergence`, `feedback-head-conflict`, `feedback-reply`, `feedback-reconciliation`, `feedback-finalization`) and carry the published revision when publication already occurred, so an operator can classify safe action without guessing.
_Avoid_: Terminal failure, dead letter, automatic retry

**Interrupted Automation**:
An Automation Work Item whose owned Target job ended before settlement because its process was terminated — typically by a host or WSL shutdown — leaving `agent:in-progress` and no `agent:blocked` label, with the trigger removed or still present. The Dispatcher may clear `agent:in-progress`, restore the trigger when absent, and re-dispatch it, but only after proving the owning job is dead.
_Avoid_: Blocked Automation, crash loop, orphaned job

**Canonical Implementation Reply**:
The single orchestrator-owned review-thread reply for a feedback implementation, carrying a bounded machine-readable marker (`feedback-reconcile op=feedback pr=<n> pre=<PRE> post=<POST> root=<root>`) embedded in an otherwise human-readable body. Its encoded root must equal the reply's linked root and the immutable current feedback intent selected before Agent execution. All nested replies remain attributable to their root; malformed, conflicting, or follow-up evidence fails closed. After a successful or uncertain reply write, the orchestrator performs bounded read-only convergence against complete reply evidence, including resolved threads; the Agent never writes to GitHub.
_Avoid_: Agent-owned reply, duplicate reply, machine-only ledger comment

**Feedback Reconcile Authorization**:
The controlled re-entry entry for feedback implementation. It first proves complete feedback evidence and selects exactly one unresolved review-thread root as the immutable current intent; a prior selection must remain unchanged before push and reply. Multiple roots, malformed/current-thread conflicting evidence, non-canonical replies, or a same-thread follow-up after a marker fail closed. Only an explicit `reconcile feedback` invocation may adopt uniquely proven matching current-intent evidence; plain `run feedback` or Dispatcher dispatch returns typed `feedback-reconciliation` without Agent, checkout, push, or reply. Strict unique legacy evidence remains reconcile-only when the operator supplies the acquired revision, and reply-only completion also requires its supplied root to equal the selected intent.
_Avoid_: Whole-job retry, heuristic pick, second publication

**Dispatcher**:
The thin trusted local scheduler that runs directly from the trusted local `master` checkout. It owns discovery, acquisition labels, bounded concurrency, Target Checkout creation, job time limits, and read-only inspection — never operation-specific business behavior.
_Avoid_: Workflow engine, claim service, orchestrator

**Dispatch Session**:
The Dispatcher's one continuous scheduling lifetime (ADR-0005). It starts when the Dispatcher takes the scheduling lock, keeps its bounded workers refilled as Automation Commands become eligible and running jobs settle, and drains — releasing the lock — only when a clean discovery finds no eligible command and no worker is running. A session may refill without a maximum lifetime; the one-minute systemd timer is unchanged, and an overlapping timer invocation no-ops on the held scheduling lock.
_Avoid_: One-shot round, frozen frontier, long-lived daemon

**Target Checkout**:
A disposable, independent local Git repository created for one Agent job at the exact authorized revision. It is never a registered worktree of the Primary Operator's checkout, and its cleanup cannot affect the source repository.
_Avoid_: Shared worktree, shared clone, workspace replacement

**Legacy Run State**:
Local partial state left behind by the retired claim/watch pipeline. It is discarded at cutover, never adopted, resumed, or reconciled by the replacement system.
_Avoid_: Checkpoint, resume point, migration input
