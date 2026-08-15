# Let ready delivery tickets complete through autonomous merge

A Delivery Ticket's `ready-for-agent` designation authorizes the AFK delivery system to implement, independently review, repair, validate, and merge its Implementation PR without a second `auto-merge` label or mandatory human review. Human review does not scale with the intended volume of autonomous changes, so safety comes from independent agent roles, exact-Revision evidence, deterministic merge gates, bounded repair rounds, and fail-closed escalation to Needs Human. Before merging, the system posts a Merge Report to the PR; a ticket's Open Blockers or an explicit AFK prohibition still prevents autonomous progress.

## Considered Options

- A separate per-ticket `auto-merge` label was rejected because it duplicates the delivery authorization already conveyed by `ready-for-agent` and would require continuous human queue management.
- Mandatory human approval was rejected because it would turn review throughput into the bottleneck the AFK workflow exists to remove.
- Unconditional agent merge was rejected because an agent's prose approval alone cannot prove that the current Revision is the one reviewed and validated.

## Consequences

The merge authority belongs to the workflow's verified transition, not to an individual implementation, review, or repair agent. Any stale Revision, incomplete evidence chain, unresolved blocker, exceeded repair bound, or ambiguous state prevents merge and yields Needs Human instead.
