# ADR-0002: Centralize Target operation outcome classification and keep projections independent

## Status

Accepted

## Decision

`.sandcastle/target-operation-outcome.ts` owns the operation-aware runtime classification of Target operation business outcomes. The same contract is applied at every trust seam where an unknown value enters: inside the Target Checkout callback before a filesystem disposition is chosen, after the whole-operation worker crosses the process boundary before local job-log finalization, and at the injectable Target operation boundary before trusted Automation Work Item settlement.

Classification preserves the original accepted business outcome and maps it to separate projection instructions. Accepted non-blocked outcomes, including `refused`, request checkout cleanup, a completed local job log, and completed Automation settlement. A typed `blocked` outcome requests checkout retention, a failed local job log, and Blocked Automation. Malformed, unsupported, or operation-mismatched values throw a stable error before any accepted disposition can be claimed.

The projections remain owned by their existing independent seams:

- Target Checkout owns authorized exact-revision checkout, repository and remote validation, clone isolation, private-environment rejection, dependency setup, and mandatory retain-or-cleanup filesystem action.
- The outer Target operation runner owns bounded process-group execution and mandatory local job-log finalization. Timeout remains the distinct local state `timed-out`.
- The trusted Automation Command acquisition path owns live GitHub reads, acquisition confirmation, physical labels, bounded redacted diagnostics, and Automation Work Item settlement.

These projections have an actual order, not an atomic cross-system transaction. A requested cleanup is awaited and mandatory; if physical deletion fails, its error overrides an otherwise accepted business outcome, the deletion state remains unclaimed, and later seams treat execution as failed. If cleanup succeeds and completed-log finalization later fails, the runner rejects and trusted settlement becomes Blocked Automation, but the already deleted Target Checkout is not restored or described as retained. Metadata is not falsely persisted as `completed`. If failure-path log finalization also fails, the original execution or cleanup error remains authoritative.

Acquisition confirmation remains independent of outcome classification. Physical labels and diagnostics stay in the trusted acquisition path, and an unconfirmed acquisition keeps its existing visible ownership evidence. Scheduled architecture review applies the same outcome contract and local projections without inventing an Automation Work Item or label settlement.

Public failure diagnostics are classifications, not transcripts. Errors whose messages embed child-process stderr — worker exits and checkout command failures — carry a trusted `publicSummary` classification alongside their full local message. The trusted acquisition path publishes only that classification (still bounded and pattern-redacted as defense in depth); untrusted stderr and any operation-transformed secret stay in local job logs. Free-text pattern redaction is retained only as a fallback for failures raised entirely by trusted code, because it cannot recognize transformed secrets such as base64-encoded credentials.

## Rejected alternatives

A single cross-seam lifecycle module was rejected. Filesystem deletion, local log persistence, and live GitHub mutation have different owners, failure modes, and partial-order facts. Combining them would imply an atomic terminal state that does not exist and would pull Target Checkout security or trusted GitHub settlement across established trust boundaries.

A classified worker completion envelope was rejected. The process boundary must validate untrusted output regardless, so wrapping the same business outcome would enlarge and migrate the wire protocol without removing runtime validation or adding leverage. Workers continue to emit the original Target operation business outcome. The same rejection applies to a classified error side channel: worker-exit publication therefore carries only the coarse trusted exit classification, and the specific failure reason remains available in local job logs.

“Target Job” is not added to the Automation Language. It remains an implementation-level worker/process label where present; the domain concepts stay Target operation, Target Checkout, Automation Command, Automation Work Item, and Blocked Automation.

## Consequences

The operation/status matrix has one policy owner, while filesystem, local-log, and trusted GitHub behavior remain distributed projections tested at their public seams. Removing the classifier would force each seam to recreate malformed-value validation, operation/status pairing, refusal semantics, and typed blocked classification. Removing any projection seam would instead remove a distinct security, diagnostic, or durable-settlement responsibility and is not a classifier simplification.

Adding or changing a Target operation status requires updating the centralized classifier contract and hand-authored drift tests. It does not authorize changes to Target Checkout security, worker transport, acquisition evidence, GitHub labels, diagnostic publication, or the Automation Language.

A new child-process failure surface (worker, checkout command, or similar) must carry a trusted `publicSummary` before its diagnostic may reach GitHub publication; embedding untrusted stderr in a message without that classification is a trust-boundary defect, and no amount of free-text pattern redaction can repair it after the fact.
