# AFK Delivery

This context covers autonomous delivery of implementation-ready GitHub work across multiple workers. GitHub issues, pull requests, relationships, revisions, and trusted workflow comments preserve enough shared state for any worker to continue the delivery safely.

## Language

**Delivery Ticket**:
An open GitHub issue marked `ready-for-agent` whose specification permits autonomous delivery. Readiness describes the ticket's quality and authorization, not whether its dependencies currently allow execution.
_Avoid_: Ready task, queued PR

**Open Blocker**:
An unresolved issue connected to a Delivery Ticket through GitHub's native `blocked by` relationship. A Delivery Ticket with any Open Blocker remains ready but is outside the Delivery Frontier.
_Avoid_: Blocked label, agent failure

**Delivery Frontier**:
The Delivery Tickets with no Open Blockers that are eligible for the next autonomous transition. A frontier ticket may require a new implementation or continuation of an existing Implementation PR.
_Avoid_: Ready-for-agent issues, issue queue

**Implementation PR**:
The single open pull request that carries the implementation of a Delivery Ticket. Its linked ticket supplies the specification; the pull request supplies the revisions, review history, repairs, validation evidence, and merge outcome.
_Avoid_: Review task, agent branch

**Managed PR**:
An Implementation PR whose AFK Delivery history can be authenticated and continued by any worker. Management does not make unrelated or external pull requests autonomous work inputs.
_Avoid_: Any open PR, claimed PR

**PR Continuation**:
Reconstructing the next delivery transition for a Managed PR from its linked Delivery Ticket, current revision, and trusted PR history. It continues the delivery workflow, not a previous agent session or worker process.
_Avoid_: Resume PR, resume session

**Revision**:
The exact commit identity of an Implementation PR at a point in its delivery history. Review, repair, and validation evidence is valid only for the Revision it names.
_Avoid_: Latest code, current version

**Review Handoff**:
A trusted, complete PR comment that preserves a review's findings, rationale, failure scenarios, constraints, and verdict for another worker. It names the reviewed Revision and is not replaced by a lossy summary.
_Avoid_: Review summary, local handoff file

**Repair Handoff**:
A trusted, complete PR comment that explains how review findings were addressed, what was preserved, what was validated, and which new Revision resulted. It connects one review round to the next without relying on machine-local state.
_Avoid_: Fix summary, session recap

**Control Envelope**:
Minimal machine-readable metadata embedded in a trusted workflow comment that identifies its kind, linked ticket, pull request, round, Revision, and disposition. It drives coordination but never substitutes for the full handoff narrative.
_Avoid_: Structured review, finding summary

**Merge Report**:
The final authenticated PR comment published before merge. It records ticket and PR identities, base and head Revisions, successful validation evidence, independent review and repair rounds, linked follow-ups, remaining non-blocking observations, deterministic merge strategy, and workflow run. Publishing it does not authorize merge by itself: the worker reconstructs all gates and rechecks the PR head afterward.
_Avoid_: Approval comment, release notes

**Proven Revision**:
The one exact commit for which the current Managed PR head, latest successful validation, and latest independent approval are identical. Only a Proven Revision may be passed to the deterministic exact-head merge operation.
_Avoid_: Approved branch, latest green commit

**Follow-up Issue**:
An issue created idempotently from an actionable non-blocking review observation and linked to its source Delivery Ticket and Managed PR. Creation records future work but never adds `ready-for-agent` or otherwise authorizes AFK Delivery.
_Avoid_: Automatic Delivery Ticket, deferred blocker

**Delivery Worker**:
A machine capable of performing one or more AFK Delivery transitions. Workers share no required local state and coordinate through authenticated GitHub state and distributed mutual exclusion.
_Avoid_: Agent session, runner process

**Delivery Lease**:
Exclusive, expiring authority for one Delivery Worker to mutate a Delivery Ticket or Managed PR. Status comments and labels describe progress but do not themselves constitute a lease.
_Avoid_: In-progress label, claim comment

**Needs Human**:
A terminal automated disposition indicating that delivery cannot safely continue without human intervention. It is distinct from waiting for Open Blockers.
_Avoid_: Blocked by, failed issue
