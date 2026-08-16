# Use GitHub as the durable AFK delivery record

AFK delivery may move between independent machines, so GitHub issues, native dependency relationships, pull requests, Git revisions, and authenticated workflow comments are the durable shared record. Workers may keep disposable worktrees, sessions, logs, and caches, but no transition may require another worker's local files or model session. Complete review and repair handoffs are posted to the Implementation PR and bound to exact Revisions; small machine-readable control envelopes coordinate the state machine without replacing those narratives. Distributed mutual exclusion remains a separate requirement because comments and labels are audit state, not atomic leases.

## Considered Options

- Machine-local handoff files or resumed model sessions were rejected because they cannot survive worker loss or transfer work across machines.
- A shared external workflow database was deferred because GitHub already owns the tickets, dependency graph, implementation revisions, reviews, and merge lifecycle; adding a second required record would create reconciliation and availability obligations.
- Structured findings alone were rejected because extraction can discard review rationale, interactions, and repair constraints needed by the next agent.

## Consequences

Every review, repair, validation, and merge decision must identify the exact PR Revision it applies to. The complete authenticated Merge Report is posted before merge, then authorization and the PR head are reconstructed again; the report cannot authorize a stale head. Linked follow-up issues and all publication effects use durable identities so retries reuse them, while the exact-head merge precondition prevents replay from merging a different Revision. Workers reconstruct progress from GitHub and fail closed when the handoff chain is incomplete, unauthenticated, stale, contradictory, or ambiguous. Local state may improve diagnostics or performance but is never authoritative.
