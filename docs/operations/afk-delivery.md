# AFK Delivery operations

This runbook operates the repository's scheduled AFK Delivery worker. The worker treats GitHub as its durable record, performs one bounded transition per invocation, and may autonomously merge only an exact Revision proven by authenticated validation and independent review evidence.

## Worker setup

Use a dedicated self-hosted GitHub Actions runner with the `afk-delivery` label. Install Docker, Git, GitHub CLI (`gh`), Node.js 24.14.0 or newer, and npm. The runner must be able to build and run the delivery and reviewer images, reach GitHub, and reach the configured model gateway. Do not mount the Docker socket, host Claude configuration, or GitHub credentials into an implementation, repair, conflict-resolution, or reviewer container.

Build and identify both images before enabling the schedule:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run sandcastle:docker:build
npm run sandcastle:reviewer:docker:build
```

Set repository variables:

- `AFK_DELIVERY_IMAGE`: immutable delivery image reference, preferably a digest.
- `AFK_REVIEWER_IMAGE`: immutable reviewer image reference, preferably a digest.

Do not store the GitHub App private key or model gateway credential in repository secrets, variables, artifacts, Issue comments, or PR comments. The repository-scoped runner service loads these local-only values:

- `GITHUB_REPOSITORY`: the fixed `owner/repository` installation target.
- `AFK_GITHUB_APP_CONFIG`: optional path to the App config; defaults to `~/.config/afk-delivery/github-app.json`.
- `AFK_CLAUDE_SETTINGS`: optional path to the mode `0600` container-only Claude settings; defaults to `~/.claude/settings-docker.json`. Its `env` object carries `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for the local gateway.

Both the App config and private key must be mode `0600`. The config stores only identifiers and a path relative to the config file:

```json
{
  "appId": "12345",
  "installationId": 67890,
  "repository": "owner/repository",
  "privateKeyFile": "private-key.pem"
}
```

Each discovery job and each bounded delivery job calls `afk-delivery app-token`. The helper verifies `GET /app`, checks the configured App ID, derives the canonical `<slug>[bot]` actor, and requests a new repository-limited installation token. It masks the token before writing it to the step output. The workflow does not persist checkout credentials; deterministic Git mutations use a process-scoped `gh auth git-credential` helper, while stage launchers receive only model-gateway fields.

The workflow maps the model gateway into isolated stages; it must not expose GitHub credentials through that gateway. Configure cc-switch so the workflow's selected model alias resolves deterministically, and verify connectivity with the worker preflight before enabling the schedule. A gateway outage is a preflight or stage failure, never permission to skip review or validation.

## Pinned skills

`.sandcastle/skills.lock` is the authorization manifest for the audited `implement`, `tdd`, and `code-review` skills. Every entry is a SHA-256 digest. Treat a skill change like a code change: review it, update the digest deliberately, rebuild the image, and rerun all validation. Never update the manifest automatically on a worker. Preflight must fail when a required skill is absent or its digest differs.

## GitHub App permissions

Use a repository-scoped GitHub App when possible. The discovery job needs read access to repository contents, issues, pull requests, checks, and metadata. The delivery job needs:

- Contents: read and write, to publish deterministic implementation and repair branches.
- Issues: read and write, to read native dependencies, record Needs Human, and create linked follow-ups.
- Pull requests: read and write, to create/adopt Managed PRs, publish authenticated control records and Merge Reports, and merge.
- Checks/statuses and metadata: read, to reconstruct required-check and mergeability evidence.

The App identity is verified from the App JWT response and must match the configured App ID. The helper exports the API actor as `<slug>[bot]` with type `Bot`; the workflow uses those values for trusted control records. Branch protection must permit that identity to use the configured merge strategy after required checks pass. Do not grant administration, Actions-management, secrets, organization, or package permissions unless a separate reviewed requirement needs them.

## Commissioning sequence

Before registering or starting the runner, disable `.github/workflows/afk-delivery.yml`, cancel every historical queued run, and add `afk:prohibited` without removing `ready-for-agent` from all existing Delivery Tickets. Register the runner at repository scope, add the `afk-delivery` label, and configure its service environment with the local values above.

With no eligible Delivery Ticket, run:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm exec -w @llm-wiki/afk-delivery-orchestrator -- afk-delivery app-token
npm exec -w @llm-wiki/afk-delivery-orchestrator -- afk-delivery preflight
AFK_CONTAINER_SMOKE=1 npm run test:container-smoke -w @llm-wiki/afk-delivery-orchestrator
```

Preflight verifies Docker, the local model gateway, both images, pinned skills, container settings, the verified App actor, repository access, and a writable workspace. The smoke runs both stage images read-only and fails if either can see GitHub credentials, a Docker socket, host GitHub/SSH state, or host Claude configuration. Do not enable the workflow until every command succeeds. Enabling the workflow is separate from authorizing a canary: all existing tickets remain prohibited, and a canary must wait for its native blocker to close.

## Schedule and Delivery Lease

`.github/workflows/afk-delivery.yml` runs every 15 minutes and supports manual dispatch. Discovery computes the Delivery Frontier; delivery uses a bounded matrix with at most four tickets in parallel. GitHub Actions concurrency group
`afk-delivery-<repository>-ticket-<ticket>` is the Delivery Lease. `cancel-in-progress: false` prevents a later schedule from interrupting an active transition.

A lease only excludes concurrent mutation. It does not preserve authorization. Every transition reconstructs GitHub state after acquiring the lease, and the merge path reconstructs it again after publishing the Merge Report. Never replace the concurrency group with a label or claim comment.

## Authorization and prohibition

`ready-for-agent` authorizes the complete autonomous lifecycle, including deterministic merge. It does not override native Open Blockers. Add `afk:prohibited` to stop new autonomous transitions for a ticket. The worker then fails closed or excludes the ticket from the frontier; it does not remove either label.

For incident response, add `afk:prohibited` to affected tickets and disable the schedule. Do not cancel an active delivery run unless continued execution is more dangerous than interruption: the run may be between an external mutation and its durable control record. Letting it finish or fail closed produces the best recovery evidence. If immediate cancellation is necessary, keep the PR and branch unchanged and use recovery inspection before resuming.

## Managed PR creation, adoption, and recovery

A new implementation uses a deterministic branch and a PR body that closes exactly one Delivery Ticket. The orchestrator publishes a trusted `managed-pr` envelope bound to the initial Revision. On retry, it reuses the deterministic branch and PR rather than creating duplicates.

Only explicitly adopt an existing PR after verifying that it is open, belongs to the same repository, targets `master`, closes exactly one intended ticket, and has a trustworthy current head. Run the CLI adoption command in a GitHub Actions context with the trusted actor token, run identity, and target branch configured:

```sh
npm exec -w @llm-wiki/afk-delivery-orchestrator -- \
  afk-delivery adopt <ticket-number> <pr-number>
```

Recovery scans are bounded by `AFK_RECOVERY_SCAN_LIMIT`. A worker reconstructs the full textual diff, native ticket link, exact head/base identities, commit metadata, required checks, and all trusted comments. Missing, truncated, contradictory, cross-repository, or ambiguous data is Needs Human. Do not repair recovery by editing control envelopes manually.

## Review, repair, and validation

Review is independent and read-only. The reviewer receives no GitHub credentials and records a complete Review Handoff for one exact Revision. `changes-required` starts at most the configured number of repair rounds. Repair starts from the rejected Revision, creates a new commit, and records a complete Repair Handoff. Any head change invalidates prior review and validation evidence; the new Revision requires fresh successful validation and fresh independent approval in the same round.

Stage agents cannot push, comment, approve, or merge. Only the deterministic orchestrator performs GitHub mutations after reconstructing state.

## Merge semantics

The merge gate requires all three identities to be equal:

```text
current Managed PR head == successfully validated Revision == independently approved Revision
```

Immediately before merge it also requires an open authorized ticket, no Open Blockers or `afk:prohibited`, exactly one authenticated Managed PR targeting `master`, passing required checks, a known mergeable state, no later trusted `changes-required` evidence, and an unexceeded repair bound.

The orchestrator first creates idempotent linked follow-up issues for actionable non-blocking findings. These issues intentionally receive no `ready-for-agent` label. It then posts one authenticated Merge Report containing ticket/PR identities, base/head/validated/approved Revisions, command evidence, review and repair rounds, follow-ups, remaining observations, merge strategy, and workflow run identity.

After posting the report, the orchestrator reconstructs every gate and rechecks the PR head. It invokes `gh pr merge` with the configured `merge`, `squash`, or `rebase` strategy plus `--match-head-commit <proven-sha>`. The PR's native closing link closes the Delivery Ticket. It does not close the ticket separately. Report markers, follow-up markers, exact-head merge preconditions, and merged-state detection make replay idempotent.

## Needs Human

Needs Human means the worker cannot prove a safe next mutation. Common causes include unauthenticated or malformed control history, stale or contradictory Revisions, multiple candidate PRs, unknown mergeability, failed checks, exceeded repair bounds, interrupted publication with ambiguous results, or post-report gate changes.

When triaging:

1. Preserve the ticket, PR, branches, comments, and workflow logs.
2. Read the exact reason and evidence links on the trusted Needs Human record.
3. Compare the current PR head with the latest validation, review, repair, and Merge Report envelopes.
4. Correct the external condition without rewriting history—for example, restore checks, close a blocker, or explicitly adopt the one correct PR.
5. Remove `afk:prohibited` only after the incident is understood, then manually dispatch the workflow. Replay should reuse durable effects.

Never delete trusted records, forge idempotency markers, force-push a Managed PR, or manually label an automatically created follow-up `ready-for-agent` as part of recovery.

## Incident-safe shutdown and restart

To stop intake safely, disable the schedule and add `afk:prohibited` to tickets that must not progress. Wait for active lease holders to complete. Keep the runner, Git refs, and GitHub comments intact. Rotate the App and model-gateway credentials if compromise is suspected, then rebuild both images from reviewed sources.

Before restart, run repository verification, restore gateway health, confirm the GitHub App ID/slug through `afk-delivery app-token`, and run preflight plus both image smokes. Then manually dispatch one workflow. Inspect reconstruction and the next bounded transition before re-enabling the schedule. A restart is a replay from GitHub state, not a continuation of a local agent session.
