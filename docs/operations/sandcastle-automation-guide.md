# Using Sandcastle automation

Sandcastle turns explicit labels on GitHub Issues and Pull Requests into local
automation jobs. This guide is for contributors who want to submit and advance
work. For deployment, credentials, systemd, retained artifacts, or incident
response, use the [operator runbook](sandcastle-local-dispatcher-runbook.md).

## Before you add a label

Make the Issue, PRD, review thread, or Pull Request self-contained. State the
requested behavior, relevant constraints, and acceptance criteria. A label
authorizes an operation; it does not replace the work description.

The local Dispatcher scans GitHub every minute. You normally add a label and
wait for the next round; you do not need to run a local Sandcastle command.

> [!IMPORTANT]
> Sandcastle does not merge Pull Requests. A successful review makes the Draft
> Pull Request ready for human review. A person must still verify required
> checks and merge it.

## Label reference

### Labels contributors add

| GitHub object | Label | Requested operation | Successful stopping point |
| --- | --- | --- | --- |
| Top-level Issue without sub-issues | `agent:implement` | Plan and implement the Issue | One `sandcastle/issue-<n>` branch and one Draft Pull Request |
| Top-level Issue without sub-issues | `agent:to-issues` | Split a PRD into self-contained sub-issues | Linked sub-issues with blocking dependencies |
| Top-level Issue with sub-issues | `agent:implement` | Implement the next eligible PRD child | The next child is requested automatically; the final child requests PR review automatically |
| Draft Pull Request | `agent:review` | Review the exact current revision and fix it when needed | Published review and a Pull Request marked Ready for Review |
| Pull Request | `agent:implement` | Implement actionable review feedback | The same branch and Pull Request are updated |
| Pull Request | `agent:update-branch` | Update the head branch from its base branch | The same branch and Pull Request are updated |
| Top-level Issue | `agent:queued` | Wait for all blocking Issues to close | The label is changed to `agent:implement`, then normal implementation begins |

Do not put `agent:queued` or an operation label on a PRD child. The parent PRD
drives its children. Pull Requests from forks are not eligible for these write
operations.

### Labels Sandcastle manages

| Label | Meaning | Contributor action |
| --- | --- | --- |
| `agent:in-progress` | Sandcastle acquired the work item | Do not add or remove it during a job |
| `agent:blocked` | Execution, timeout, push, or publication failed | Diagnose the failure before authorizing a retry |

A trigger label is consumed when Sandcastle acquires its operation. Its absence
after acquisition does not mean the work was cancelled.

## Common workflows

### Implement an ordinary Issue

1. Write a complete, top-level Issue with no sub-issues.
2. Add the implementation label:

   ```bash
   gh issue edit <issue-number> --add-label agent:implement
   ```

3. Wait for Sandcastle to create `sandcastle/issue-<issue-number>` and exactly
   one Draft Pull Request whose body closes the Issue.
4. Inspect the implementation and then request automated review on that Draft
   Pull Request:

   ```bash
   gh pr edit <pr-number> --add-label agent:review
   ```

5. After Sandcastle publishes its review and marks the Pull Request Ready for
   Review, verify the required checks and merge it manually.

Ordinary Issue implementation does **not** add `agent:review` automatically.

```text
Issue + agent:implement
  -> implementation branch + Draft PR
  -> human adds agent:review
  -> automated review and possible fixes
  -> Ready for Review
  -> human merge
```

### Split and implement a PRD

Use this flow when one top-level Issue describes work that should be delivered
as ordered, independently understandable sub-issues.

1. Add the split trigger to the PRD:

   ```bash
   gh issue edit <prd-number> --add-label agent:to-issues
   ```

2. Check the generated sub-issues and their blocking relationships.
3. Add the implementation trigger to the **parent PRD**, not its children:

   ```bash
   gh issue edit <prd-number> --add-label agent:implement
   ```

4. Sandcastle implements one eligible child at a time on the shared
   `sandcastle/prd-<prd-number>` branch. After a child succeeds, it closes that
   child and requests the next one automatically.
5. When the last child succeeds, Sandcastle adds `agent:review` to the shared
   Draft Pull Request automatically.
6. After review makes the Pull Request ready, verify required checks and merge
   it manually.

```text
PRD + agent:to-issues
  -> linked sub-issues
  -> parent PRD + agent:implement
  -> children implemented in order
  -> automatic agent:review on the final Draft PR
  -> Ready for Review
  -> human merge
```

### Implement Pull Request feedback

1. Leave the requested change in an unresolved Pull Request review thread.
2. Add the implementation label to the Pull Request:

   ```bash
   gh pr edit <pr-number> --add-label agent:implement
   ```

3. Sandcastle implements the selected feedback on the existing head branch,
   pushes the result to the same Pull Request, and replies with reconciliation
   evidence.
4. If another automated review is wanted, add `agent:review` after the feedback
   implementation has finished.

On a Pull Request, `agent:implement` means **implement review feedback**. It
does not mean ordinary Issue implementation and does not merge the Pull
Request.

### Update a Pull Request branch

For a non-fork Pull Request that needs the latest base branch:

```bash
gh pr edit <pr-number> --add-label agent:update-branch
```

Sandcastle updates the existing head branch. If it is already current, it
leaves a comment and makes no commit. Request review separately when needed.

### Queue work behind blockers

Use GitHub blocking dependencies to describe the gate, then label the
**top-level Issue**:

```bash
gh issue edit <issue-number> --add-label agent:queued
```

Each dispatch round reads the current dependency state. Once every blocker is
closed, Sandcastle changes `agent:queued` to `agent:implement`; no event replay
or manual promotion is required. A queued sub-issue is refused because its
parent PRD owns child progression.

## Observe progress

GitHub is the durable status surface:

- the trigger label means the operation is waiting to be acquired;
- `agent:in-progress` means a job has acquired it;
- `agent:blocked` plus the diagnostic comment means the job failed;
- a branch, Draft Pull Request, review, comment, or label transition records a
  successful operation's result.

If you also operate the trusted local checkout, the read-only inspection is:

```bash
npm run sandcastle -- inspect
```

It reports local image and GitHub readiness, active jobs, and discovered
commands with eligibility such as `eligible`, `blocked`, `stale-in-progress`,
or `inconsistent`. It never changes GitHub or local job state.

## Recover blocked work

Sandcastle does not retry a whole blocked job automatically.

1. Read the classified diagnostic comment on the Issue or Pull Request.
2. Ask an operator to inspect the local job when the comment is insufficient.
   Operators use `npm run sandcastle -- inspect`, the systemd journal, and
   retained artifacts as described in the
   [runbook](sandcastle-local-dispatcher-runbook.md#blocked-automation-diagnosis).
3. Fix the underlying problem.
4. After confirming that no matching job is active, remove `agent:blocked` and
   restore the original trigger. For example:

   ```bash
   gh issue edit <issue-number> \
     --remove-label agent:blocked \
     --add-label agent:implement
   ```

   For a Pull Request, use `gh pr edit` and restore the appropriate
   `agent:review`, `agent:implement`, or `agent:update-branch` trigger.

Do not create a replacement Issue, branch, or Pull Request to bypass a blocked
job. A retry reuses the existing work item and implementation branch.

If `agent:in-progress` appears stale, do not clear it based only on elapsed
time. An operator must first confirm through inspection and local logs that no
matching job is active. A work item carrying both a trigger and
`agent:in-progress` is inconsistent and will not run until corrected manually.

A local image or GitHub credential readiness failure happens before acquisition:
the trigger remains present and Sandcastle does not add `agent:blocked`. An
operator fixes readiness, after which the next scheduled round can pick up the
unchanged command.

## What Sandcastle does not infer

The Dispatcher validates explicitly labelled work; it does not scan every
Issue and Pull Request and decide what the repository should do next. In
particular, it does not:

- infer that an unlabelled Issue is ready to implement;
- infer that an ordinary implementation Draft Pull Request is ready to review;
- infer that a Ready Pull Request may be merged;
- merge or enable GitHub auto-merge.

The explicit labels above are the authorization boundary. When unsure, leave
the work item unlabelled and ask a maintainer which single operation should run
next.
