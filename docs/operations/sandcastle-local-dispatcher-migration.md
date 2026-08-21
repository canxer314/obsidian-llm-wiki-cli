# Sandcastle migration design

Status: accepted design; implementation has not started.

## Decision summary

Replace the repository's custom Sandcastle claim/watch/worktree/repair pipeline with a local WSL Dispatcher that preserves Matt Pocock's label-driven Issue and Pull Request workflows.

The upstream baseline is:

```text
mattpocock/course-video-manager
commit f5b0e037d7c5be3f7f87033881443a14b4441a77
@ai-hero/sandcastle 0.10.0
```

This repository keeps its locked `@ai-hero/sandcastle` 0.12.0 and proves compatibility through tests. It does not downgrade to the upstream version.

The migration priority is:

1. Preserve the upstream workflow behavior.
2. Use the smallest reliable local replacement for GitHub Actions scheduling.
3. Keep only the repository-specific CC-Switch, WSL, and proxy adaptation.

## Why replace instead of repair

The current implementation owns several coupled concerns:

- deterministic claim branches and Git ref ownership;
- a local watch process and claim receipts;
- Docker/worktree replacement lifecycle;
- one integrated implement/review/repair state machine;
- terminal failure finalization;
- local claim inspection and reconciliation.

Three observed failures follow directly from these concerns:

1. `claimIssue()` fetches a branch and then tries to create the already-created remote-tracking ref with a zero old SHA.
2. Workspace replacement can remove the host worktree administration directory before the final push.
3. A Reviewer execution or structured-output error terminalizes an existing Draft Pull Request with no resume entry point.

The upstream design avoids these systems. GitHub Issues, Pull Requests, branches, labels, and comments carry durable progress. Each operation is independently triggerable and retryable.

## Ubiquitous language

The canonical terms are defined in [`CONTEXT.md`](../../CONTEXT.md):

- **Automation Command** — one visible and independently retryable repository operation.
- **Automation Work Item** — the durable repository record carrying the work and discussion.
- **Blocked Automation** — an operation failure that requires operator inspection, not a terminal Work Item.
- **Dispatcher** — the thin trusted local scheduler.
- **Target Checkout** — a disposable repository copy at the exact authorized revision.
- **Legacy Run State** — local partial state from the retired system, never adopted by the replacement.

## Runtime topology

```text
GitHub Issue / Pull Request labels
                 |
                 v
       WSL systemd oneshot timer
                 |
                 v
       repository-local Dispatcher
                 |
      +----------+----------+
      |                     |
      v                     v
Target Checkout A      Target Checkout B
operation/wrapper      operation/wrapper
prompt/project code    prompt/project code
      |                     |
      +----------+----------+
                 |
                 v
       GitHub branch / PR / comments
```

GitHub remains the only durable business state. The Dispatcher has no durable claim ledger, checkpoint database, or automatic repair state.

### Why local dispatch

Agent jobs run locally because GitHub Actions scheduling may be delayed and the required CC-Switch and WSL proxy environment already exists on the Primary Operator's machine.

GitHub Actions is not retained as a fallback consumer. Two consumers would reintroduce ownership and duplicate-execution problems.

## Dispatcher responsibilities

The Dispatcher is repository code under `.sandcastle/dispatcher/`. Systemd and manual commands execute it directly from the trusted local `master` checkout through Node 24 type stripping. There is no build, install, release directory, symlink, or separate rollback mechanism.

It owns only:

- discovery of Automation Commands;
- general scheduling preflight;
- command acquisition labels;
- global and per-work-item concurrency;
- Target Checkout creation;
- frozen dependency installation;
- job time limits and process-tree termination;
- common blocked/finally behavior;
- local job logging and cleanup;
- read-only inspection;
- queued-Issue promotion.

It does not own Issue/PR shape rules, review-thread logic, PRD progression, branch content, review verdicts, or architecture proposals. Those remain in operation modules migrated from the upstream workflows.

### CLI

The initial command surface is:

```text
npm run sandcastle -- dispatch-once
npm run sandcastle -- inspect
npm run sandcastle -- run <operation> <number>
npm run sandcastle -- architecture-review
```

`run` performs the same label and preflight lifecycle as normal dispatch. It does not create an implicit Automation Command.

The first implementation performs one bounded scheduling round. Its internal API should allow a future drain-until-empty outer loop, but that mode is not exposed initially.

## Scheduling

### Round boundary

Each `dispatch-once` invocation:

1. acquires the global scheduler file lock;
2. updates the trusted local `master` checkout;
3. reads the current command frontier;
4. selects commands whose concurrency keys do not conflict;
5. starts at most the configured number of jobs;
6. waits for all selected jobs;
7. exits.

Commands created while the round runs are processed by a later round.

### Automatic local `master` update

While holding the global lock, the Dispatcher:

1. requires the current branch to be `master`;
2. requires no tracked local changes;
3. runs `git fetch origin master`;
4. allows only `git merge --ff-only origin/master`;
5. refuses to dispatch if local `master` is ahead, diverged, dirty, or cannot update.

It never resets, rebases, or stashes automatically.

### Concurrency

The default maximum is two jobs and is configured through:

```text
SANDCASTLE_MAX_CONCURRENCY=2
```

It is parsed as a bounded positive integer and may be overridden by a non-sensitive CLI option. It is not hard-coded into scheduling logic.

Concurrency keys match the upstream workflows:

```text
issue:<number>
prd:<number>
pr:<number>
architecture-review
```

Review, PR-feedback implementation, and branch update share `pr:<number>`.

A global `flock` prevents overlapping scheduling rounds. Jobs selected in one round run concurrently in that process. The first implementation does not add a distributed lock, database, or claim lease.

### Selection priority

For multiple commands on one Pull Request:

```text
update branch > implement feedback > review
```

Across the queue:

```text
PR update
> PR feedback implementation
> PR review
> PRD/Issue implementation
> PRD split
> queue promotion
> architecture review
```

Within one type, GitHub number ascending is a deterministic tie-breaker.

A Blocked Automation is never bypassed by a lower-priority command.

## Command lifecycle

### Acquisition

Under the scheduler lock:

1. re-read the Work Item;
2. verify the trigger label remains present;
3. verify `agent:blocked` and `agent:in-progress` are absent;
4. add `agent:in-progress`;
5. remove the trigger label;
6. start the job.

Adding in-progress first prevents a command from silently disappearing if the second mutation fails. If both labels remain, `inspect` reports an inconsistent state and the Dispatcher does not execute it.

### Ownership of labels

The Dispatcher owns only:

```text
trigger label
agent:in-progress
agent:blocked
```

Operations own business transitions such as PRD continuation, final review requests, architecture source labels, and Issue/PR creation or closure.

### Outcomes

Preflight refusal:

- remove the trigger;
- explain the refusal on the Work Item;
- exit successfully;
- do not add `agent:blocked`.

Execution, timeout, push, or publication failure:

- add `agent:blocked`;
- publish a short classified reason and local job ID;
- attempt to remove `agent:in-progress` in `finally`;
- do not retry the whole job.

Retry is manual:

1. inspect GitHub state and the local job;
2. remove `agent:blocked`;
3. re-add the required trigger label.

The structured-output wrapper keeps its bounded same-session extraction retry. It does not repeat the side-effecting produce phase.

A stale `agent:in-progress` after a host crash is reported by `inspect`; it is never automatically adopted, cleared, or resumed.

## Target Checkout

Each job gets an independent Git repository. It is not a registered worktree of the Primary Operator's checkout.

Creation begins with:

```sh
git clone --local --no-checkout "$SANDCASTLE_LOCAL_REPOSITORY" "$JOB_REPOSITORY"
```

Then the job:

1. restores the GitHub HTTPS origin;
2. targeted-fetches the required remote revision;
3. verifies it equals the dispatch snapshot SHA;
4. checks out that exact revision;
5. runs `npm ci`;
6. invokes the fixed operation entry in the Target Checkout.

`git clone --shared` is forbidden. A normal local clone reuses local objects without sharing the mutable worktree registry. Fetch downloads only missing objects.

The source repository path is trusted machine configuration. It never comes from an Issue, Pull Request, prompt, or target manifest.

### Target trust boundary

There is no Control Snapshot. The Target Checkout supplies its own:

- operation module;
- Sandcastle wrapper;
- prompt and extraction prompt;
- project rules and ADRs;
- dependencies and package lifecycle;
- project source code.

Adding an `agent:*` label authorizes execution of that exact same-repository revision. Fork Pull Requests are rejected. Only the Primary Operator or fully trusted maintainers may manage trigger labels.

The local Dispatcher itself is loaded from the trusted local `master` checkout and cannot be replaced by the target job.

Sandcastle 0.12.0 automatically resolves `.sandcastle/.env` from its working directory. A Target Checkout that tracks `.sandcastle/.env` is rejected before execution. The repository already ignores this path, so an ordinary clone does not receive the Primary Operator's private file.

## Workflow migration

The migration covers the eight active upstream workflow behaviors and their nine wrapper roles. It deliberately excludes the reference repository's unused `.sandcastle/main.ts` Planner/Docker/Reviewer/Merger batch path.

No executable GitHub Actions copies are retained. Their behavior and provenance are represented by local operation modules and mapping tests.

### Mapping

| Upstream workflow | Local operation | Trigger or schedule | Concurrency |
|---|---|---|---|
| `agent-implement.yml` | `.sandcastle/operations/implement-issue.ts` | Issue `agent:implement` | `issue:<n>` |
| `agent-implement-prd.yml` | `.sandcastle/operations/implement-prd.ts` | PRD `agent:implement` | `prd:<n>` |
| `agent-implement-pr.yml` | `.sandcastle/operations/implement-pr.ts` | PR `agent:implement` | `pr:<n>` |
| `agent-review.yml` | `.sandcastle/operations/review-pr.ts` | PR `agent:review` | `pr:<n>` |
| `agent-update-branch.yml` | `.sandcastle/operations/update-branch.ts` | PR `agent:update-branch` | `pr:<n>` |
| `agent-to-issues-prd.yml` | `.sandcastle/operations/split-prd.ts` | PRD `agent:to-issues` | `prd:<n>` |
| `agent-promote-queued.yml` | Dispatcher queue-promotion scan | current `agent:queued` state | no Agent job |
| `architecture-review.yml` | `.sandcastle/operations/architecture-review.ts` | systemd schedule/manual | `architecture-review` |

Wrapper responsibilities remain separate from operation modules. Operations migrate the workflow YAML shell:

- business preflight;
- branch preparation;
- wrapper invocation;
- push;
- Issue/PR creation or update;
- review/comment publication;
- business label transitions.

The Dispatcher invokes only fixed operation paths. Neither repository configuration nor a Work Item can provide an arbitrary operation command.

### Preserved automatic transitions

The upstream automatic behavior is retained:

- after one PRD child completes, request the next implementation;
- after the final child completes, request review;
- promote queued Issues when all blockers are closed;
- run architecture review on schedule.

The promotion mechanism changes from an `issues:closed` event to state-based reconciliation. A periodic scan reads every `agent:queued` Issue and its current blockers. This cannot miss promotion while the Dispatcher is offline and requires no event cursor.

### Revision and push behavior

PR operations capture the full current head SHA during acquisition and checkout that revision. Same-PR mutations are serialized. Push uses the upstream explicit `--force-with-lease` expected SHA. Review payloads identify the reviewed commit with `commit_id`.

The previous multi-stage exact-head service and repair-orchestrator revision state are not migrated.

## Quality and structured output

The upstream quality model is preserved:

- prompts require the Agent to choose and run appropriate type checks and tests;
- Sandcastle does not add a second local-quality state machine;
- normal repository CI and branch protection may remain separate merge requirements.

The repository keeps npm. The frozen-install equivalent is:

```sh
npm ci
```

Each Target Checkout has independent `node_modules`; only the npm download cache is shared.

Target dependency installation receives proxy and CA settings but not Claude or GitHub credentials.

Structured work uses the upstream produce/extract split:

1. produce without rigid structured output;
2. resume the same Agent Session for extraction;
3. retry only structured extraction failures;
4. fail closed when session identity is unavailable;
5. never convert execution failure into a fabricated review finding.

## Environment adaptation

The CC-Switch, WSL, and proxy behavior is retained as a thin adapter. The existing `.sandcastle/private-config.ts` provides the starting implementation:

- explicit environment allowlists;
- Claude Code settings loading;
- private file loading and mode `0600` validation;
- proxy extraction;
- role model selection.

Configuration precedence is:

```text
repository non-sensitive defaults
< Claude Code / CC-Switch settings
< private environment file
< non-sensitive CLI options
```

The private file is outside the repository, for example:

```text
~/.config/obsidian-llm-wiki-sandcastle/environment
```

One dispatch round reads configuration once; all jobs in the round use that immutable in-memory value.

Child process environments are purpose-specific:

- npm: proxy, CA, and cache only;
- Git: proxy, CA, and HTTPS credential mechanism;
- `gh`: `GH_TOKEN`, proxy, and CA;
- Claude Code: Claude endpoint, authentication, model settings, and required proxy values.

The complete parent environment is never forwarded by default.

The initial concurrency default is repository configuration; `SANDCASTLE_MAX_CONCURRENCY` and a non-sensitive CLI option may override it.

## GitHub and Git credentials

The repository keeps HTTPS origin and the existing repository-scoped PAT approach.

- `GH_TOKEN` comes from the protected private environment file.
- Git push uses the existing HTTPS credential helper or a protected askpass mechanism.
- A token is never embedded in a remote URL, Git config, command-line argument, job metadata, or GitHub comment.
- No GitHub App is introduced for this migration.

## Time limits and logs

Each job runs in its own process group. At the upstream operation timeout, the Dispatcher:

1. sends `SIGTERM` to the group;
2. waits for a short grace interval;
3. sends `SIGKILL` if required;
4. waits for all processes to exit;
5. applies Blocked Automation and common cleanup behavior.

This is a local replacement for an Actions job timeout, not the retired watch/claim cancellation state machine.

A job ID contains only non-sensitive operation, Work Item, time, and random-suffix information. Full subprocess output remains local. GitHub receives only a short reason, the job ID, and retry guidance.

Retention:

- success: delete the Target Checkout; retain small metadata and logs for seven days;
- failure/timeout: retain the checkout, output, and logs for seven days;
- dispatcher-round logs use the systemd journal.

## Systemd

Version-controlled templates live under `.sandcastle/systemd/`:

```text
sandcastle-dispatch.service
sandcastle-dispatch.timer
sandcastle-architecture-review.service
sandcastle-architecture-review.timer
```

There is no installer. The Primary Operator manually copies or links units, supplies the local repository working directory, and explicitly enables timers.

The normal timer runs every minute. If the previous round still holds the lock, the new invocation exits without work.

Architecture review uses a separate timer with the upstream schedule. Missed architecture runs are not replayed; the next schedule or a manual command is sufficient.

## Labels

An idempotent setup command creates labels but never edits a Work Item:

```text
agent:implement
agent:review
agent:update-branch
agent:to-issues
agent:queued
agent:in-progress
agent:blocked
source:architecture-review
```

Normal dispatch fails closed if required labels are missing.

Old `Sandcastle` and `sandcastle:*` labels do not trigger the replacement system and are not automatically converted. During canary, no new trigger label is added to preserved historical Work Items.

## Implementation sequence

One migration Pull Request contains reviewable commits but is not activated before merge:

1. migrate upstream wrappers, prompts, schemas, and tests;
2. add eight operation behaviors;
3. add the Dispatcher, local-clone workspace, locks, and inspection;
4. add environment adaptation, process-group timeout, and local logging;
5. add systemd templates and operations documentation;
6. replace the production entry and remove the retired pipeline and Inspector;
7. run all mapping, unit, integration, and type tests.

## Verification

### Behavior mapping tests

Each local operation has tests covering the corresponding upstream workflow's:

- trigger and shape selection;
- business preflight refusal;
- label transitions;
- concurrency key;
- target revision selection;
- push and lease behavior;
- success, failure, and finally paths;
- wrapper output files;
- timeout.

The upstream structured-output and diff-line tests are migrated directly. GitHub and Agent calls are stubbed for deterministic operation tests.

### Workspace acceptance

A Target Checkout test must prove:

- object reuse comes from the configured local repository;
- the checkout has an independent `.git` directory;
- it is absent from the source repository's worktree registry;
- only missing target objects are fetched;
- the fetched revision equals the GitHub snapshot;
- commit and dry-run push remain valid after Agent execution;
- cleanup cannot remove the source repository or unrelated worktrees.

### Claim-race regression

The replacement has no claim branch or manual remote-tracking ref creation. A regression test asserts no dispatched path invokes the retired claim behavior or creates `refs/remotes/origin/*` with `git update-ref`.

### Reviewer recovery

A canary or integration fixture must prove:

- malformed structured output retries only extraction in the same session;
- generic execution failure adds `agent:blocked` without fabricated findings;
- the existing Draft Pull Request remains open;
- re-adding `agent:review` operates on that Pull Request's current full head;
- no replacement Issue, branch, or Pull Request is created.

## Canary and cutover

The migration Pull Request merges with timers disabled.

Cutover order:

1. stop the retired Sandcastle process and verify no old job is active;
2. discard Legacy Run State rather than adopting or resuming it;
3. initialize and review the new labels;
4. prepare the protected private environment file;
5. run `inspect` manually;
6. run dedicated migration-canary Work Items;
7. enable the normal timer after the core flow passes;
8. run architecture review manually, then enable its timer.

Canary coverage:

1. ordinary Issue to Draft Pull Request;
2. Pull Request review;
3. implementation of Pull Request feedback;
4. branch update;
5. PRD split;
6. PRD child automatic continuation and final review request;
7. queued blocker promotion;
8. manual architecture review.

Historical #216 / PR #217, #166, archive branches, and other preserved evidence are not canary inputs.

## Retired-system deletion boundary

The migration Pull Request removes the retired tracked implementation immediately:

- claim/watch/receipt orchestration;
- Planner/Implementer/Reviewer/Merger integrated loop;
- Docker workspace replacement and host-worktree management;
- repair and failure-finalization state machines;
- local-quality orchestration;
- claim Inspector and reconciliation adapters;
- their obsolete tests, fixtures, and dedicated documentation.

At cutover, delete this exact untracked local recovery path:

```text
/home/canxer/repos/obsidian-llm-wiki-cli/.sandcastle/recovered/
```

Do not batch-delete:

```text
.sandcastle/worktrees/
.sandcastle/logs/
.git/worktrees/
.claude/worktrees/
```

The replacement ignores those directories. In particular, no cleanup touches a possible dirty #166 worktree.

This migration does not close, edit, relabel, or delete historical GitHub Work Items. It does not delete or rewrite remote `sandcastle/*`, `archive/*`, or other branches, and it does not rewrite historical commits. #216 / PR #217 and #166 remain untouched.

## Accepted differences from upstream

| Area | Upstream | This repository |
|---|---|---|
| Job scheduler | GitHub Actions | WSL systemd oneshot Dispatcher |
| Package manager | pnpm | npm (`npm ci`) |
| Base branch | `main` | `master` |
| Node | Node 22 | repository-required Node 24 |
| Sandcastle | locked 0.10.0 | keep locked 0.12.0 after compatibility tests |
| Runtime environment | Actions secrets / hosted environment | CC-Switch, WSL proxy, protected local environment file |
| Workspace | Actions checkout | disposable local clone plus targeted fetch |
| Queue promotion trigger | `issues:closed` event | current-state scan of queued Issues and blockers |
| Workflow representation | YAML + wrapper | local operation module + wrapper |

No other behavior difference is accepted in the initial migration. Improvements beyond the upstream baseline require a separate decision after canary.

## Non-goals

- repairing or resuming Legacy Run State;
- using replacement Issues as recovery;
- preserving the retired claim or repair model;
- running the upstream unused `.sandcastle/main.ts` batch loop;
- supporting fork Pull Requests;
- multiple dispatcher hosts or high availability;
- a webhook receiver, event ledger, database, or distributed lease;
- a Control Snapshot or local release/install system;
- automatic whole-job retries;
- migration from npm to pnpm;
- cleaning historical remote branches or Work Items;
- modifying #216 / PR #217 or #166.
