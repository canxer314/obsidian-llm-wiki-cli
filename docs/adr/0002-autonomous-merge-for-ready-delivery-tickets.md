# Let ready delivery tickets complete through autonomous merge

A Delivery Ticket's `ready-for-agent` designation authorizes the AFK delivery system to implement, independently review, repair, validate, and merge its Implementation PR without a second `auto-merge` label or mandatory human review. Human review does not scale with the intended volume of autonomous changes, so safety comes from independent agent roles, exact-Revision evidence, deterministic merge gates, bounded repair rounds, and fail-closed escalation to Needs Human. Before merging, the system posts a Merge Report to the PR; a ticket's Open Blockers or an explicit AFK prohibition still prevents autonomous progress.

## Considered Options

- A separate per-ticket `auto-merge` label was rejected because it duplicates the delivery authorization already conveyed by `ready-for-agent` and would require continuous human queue management.
- Mandatory human approval was rejected because it would turn review throughput into the bottleneck the AFK workflow exists to remove.
- Unconditional agent merge was rejected because an agent's prose approval alone cannot prove that the current Revision is the one reviewed and validated.

## Decision contract

An autonomous merge is authorized only when the freshly reconstructed Managed PR head, the latest successful validation Revision, and the latest independently approved Review Handoff Revision are the same exact 40-character Git SHA. The trusted evidence must form one authenticated Revision chain, validation and review rounds must agree, no unresolved or later `changes-required` record may apply, and the configured repair bound must not be exceeded.

Immediately before mutation, the orchestrator reconstructs that the Delivery Ticket is open, retains `ready-for-agent`, has no Open Blockers or `afk:prohibited`, and maps to exactly one authenticated Managed PR targeting `master`. Required checks must pass and GitHub mergeability must be explicitly known and true. Missing, stale, contradictory, or ambiguous evidence yields Needs Human.

The mutation order is fixed:

1. Create or reuse linked follow-up issues for actionable non-blocking findings. Follow-ups never receive `ready-for-agent` automatically.
2. Publish one complete authenticated Merge Report for the Proven Revision.
3. Reconstruct all authorization and evidence, including the PR head, after report publication.
4. Merge with the repository's configured `merge`, `squash`, or `rebase` strategy and GitHub's exact-head precondition.

The linked PR, not a separate issue mutation, closes the Delivery Ticket. Stable effect identities make follow-up and report publication idempotent; an already merged PR makes replay a no-op. A changed head or gate after report publication aborts the merge and records an exact-Revision-bound Needs Human disposition.

## Consequences

The merge authority belongs to the workflow's verified transition, not to an individual implementation, review, or repair agent. Any stale Revision, incomplete evidence chain, unresolved blocker, exceeded repair bound, unknown mergeability, or ambiguous state prevents merge and yields Needs Human instead.

Publishing a Merge Report creates an auditable decision record but is not itself sufficient authority. Operators can safely replay after worker loss because every external effect has a deterministic identity and the merge command names the proven head SHA. Actionable observations can be preserved without silently expanding the authorized Delivery Frontier.
