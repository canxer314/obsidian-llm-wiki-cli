# Sandcastle sandbox

`./sandbox.ts` is the shared runtime and private-config entry point for Sandcastle
Agent Sessions. Orchestration entry points must call `loadSandboxStartup()` and
use its `sandbox`, role models, and the role-specific `sandboxHooksFor()` selection
together; the unvalidated Docker provider constructor is not exported.

## Private configuration

Copy `.env.example` to `.env`, fill the repository-scoped `GH_TOKEN`, and restrict
the file before starting Sandcastle:

```bash
cp .sandcastle/.env.example .sandcastle/.env
chmod 600 .sandcastle/.env
```

The startup adapter reads only routing, authentication, model-mapping, and proxy
environment variables from `~/.claude/settings.json`. Non-empty whitelisted values
in `.sandcastle/.env` override those settings. It fails before creating an Agent
Session if `.env` is missing, is not mode `0600`, or required routing/authentication
values are unavailable. Startup logs contain counts only, not routes, model names,
proxy addresses, or secrets.

The default model is the Claude Code `opus` alias. `SANDCASTLE_MODEL` changes the
local default, while `SANDCASTLE_PLANNER_MODEL`, `SANDCASTLE_IMPLEMENTER_MODEL`,
and `SANDCASTLE_REVIEWER_MODEL` provide the supported role-level overrides.
Provider-specific model IDs belong only in this ignored private file or the local
Claude Code settings.

Neither the private env file nor complete Claude Code, CC-Switch, OAuth, or GitHub
CLI configuration is mounted into a container. The provider receives only the
adapter's filtered environment map.

## CLI startup validation

Run a single explicitly selected Issue with:

```bash
npm run sandcastle -- --issue 100
```

The default mode never scans the backlog. The target must exist, be open, and
have the exact `Sandcastle` label. `--watch` is an explicit alternative and
cannot be combined with `--issue`. Startup also creates or updates the
`sandcastle:failed` label idempotently.

Watch mode polls every five minutes and starts at most two Issues at once. It
writes JSONL records to stderr under the `sandcastleEvidence` key. Every record
in one process carries the same random `runId`; watch records add the claiming
`batchId`, and workflow records retain that run/batch/Issue context through
session, gate, merge, and terminal events. Capture a run with:

```bash
npm run sandcastle -- --watch 2>sandcastle-evidence.jsonl
```

The evidence contains only run/batch/Issue/PR identifiers, session role/name and
attempt, commit SHA, gate context/outcome, active count, merge expected head,
and terminal outcome/failure stage. It never includes prompts, findings or
command output, environment values, credentials, routing, or local paths.

The JSONL records what Sandcastle attempted; GitHub remains authoritative for
remote branches, Pull Requests, commit statuses, merges, closing relationships,
and Issue state. Acceptance must cross-check every recorded gate revision and
merge expected head against the GitHub API rather than treating the local log
as a second source of those facts.

After startup validation, the runner starts a fresh Planner Agent Session in the
sandbox. The Planner receives only the explicit Issue number, reads the latest
title, body, labels, and comments itself through `gh`, and returns a schema-validated
plan. The plan records `ready` or `blocked`, an implementation summary, an explicit
blocking reason, whether automation configuration changes are allowed, and the full
Issue context for a later Implementer session. Missing, free-text, mismatched-Issue,
or otherwise invalid output fails closed.

A ready plan runs in a separate Implementer Agent Session, which creates the
Issue branch and Draft Pull Request. Sandcastle then runs deterministic local
quality against the exact Pull Request head and publishes
`sandcastle/local-quality`. Only a successful result for that same revision can
start a fresh, read-only Reviewer Agent Session. The Reviewer checks out that
full commit SHA, returns a schema-validated `Approved` or `Changes requested`
verdict with a summary and findings, and must not create commits.

Review startup publishes `sandcastle/review=pending`. `Approved` maps to
`success`, `Changes requested` maps to `failure`, and session, schema, or stale
SHA results map to `error`. Every completed attempt leaves a regular Pull
Request comment with its reviewed revision. Sandcastle reads the Pull Request
head before starting and after the Reviewer returns, so a result for an
outdated head cannot publish success.

A local quality `failure` or Reviewer `Changes requested` verdict can start a
fresh Implementer repair session. Both failure sources share one budget of two
repairs, so a run evaluates at most three implementation revisions. Each repair
receives only bounded, redacted output or structured findings, must push a new
SHA to the existing Pull Request, and restarts local quality before review.
Infrastructure and Reviewer `error` results stop without consuming a repair.

Every unrecoverable stop, including a blocked Planner, an Agent Session or
infrastructure error, and exhausted repair budget, leaves the Issue open and
preserves the deterministic remote branch and any Draft Pull Request. Sandcastle
posts a bounded, redacted diagnosis to the verified Pull Request when available
or otherwise to the Issue. It then removes `Sandcastle` and adds
`sandcastle:failed`, so a future watch implementation cannot claim the failure
again. Comment and label operations are attempted independently; an incomplete
finalization remains a failed process and does not start repair, review, or merge
work.

## Runtime verification

The provider uses Docker host networking so a container can reach CC-Switch on
the WSL loopback interface. Sandcastle rebuilds one fixed runtime image from the
repository context before starting a workflow. The image seeds an npm cache tied
to the Dockerfile, lockfile, workspace manifests, Node, and npm versions without
retaining `node_modules`. Initial Implementer setup verifies that identity and
runs `npm ci --offline`; repair, Reviewer, and Merger sessions prefer the seeded
cache and use bounded registry retries only when the Pull Request added a new
dependency. Planner setup deliberately has no dependency-install hook because
Planner sessions share the host checkout and only read Issue context. Do not add
`node_modules` to `copyToWorktree`. Proxy variables are explicitly whitelisted;
credential files are excluded from every Docker build context.

Build and verify the image with:

```bash
npm run test:sandbox
```

The smoke test creates a detached Git worktree, mounts only that worktree, and
runs `npm ci`, build, typecheck, and the complete test suite in Node.js 24. It
does not load credentials or start an Agent Session.
