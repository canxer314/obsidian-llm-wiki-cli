# Sandcastle local Dispatcher runbook

Operator runbook for deploying, inspecting, and canarying the local WSL Dispatcher that replaced the retired Sandcastle claim/watch pipeline. Canonical terms (Automation Command, Automation Work Item, Blocked Automation, Dispatcher, Target Checkout, Legacy Run State) are defined in `CONTEXT.md`.

The Dispatcher runs directly from the trusted local `master` checkout through Node 24 type stripping. There is no TypeScript build, installer, release directory, symlink, or rollback mechanism. Its Agent workers use a separate content-addressed local Docker image prepared below.

## Protected configuration

The private environment file lives outside the repository at:

```text
~/.config/sandcastle/env
```

It must be a regular file with mode `0600`:

```bash
install -m 600 /dev/null ~/.config/sandcastle/env   # or: touch + chmod 600
$EDITOR ~/.config/sandcastle/env
```

Startup fails closed when the file is missing, is not a regular file, has any other mode, or lacks the provider configuration (`ANTHROPIC_BASE_URL` and either `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`). `GH_TOKEN` is intentionally not a startup prerequisite: a missing token reaches the read-only Agent-container readiness classification as `"missing"`, without launching its probe container. Only whitelisted keys are read:

- `GH_TOKEN` — optional only for read-only `inspect`; it is required by the Agent-container readiness preflight before any GitHub-capable operation can acquire a Work Item. Use a repository-scoped fine-grained PAT (Metadata read; Contents, Issues, Pull requests, Commit statuses read/write). Never place it in remote URLs, Git config, command-line arguments, or unit files.
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` — CC-Switch routing, authentication, and model mapping.
- `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and lowercase variants) — WSL transport settings.
- `SANDCASTLE_MODEL`, `SANDCASTLE_PLANNER_MODEL`, `SANDCASTLE_IMPLEMENTER_MODEL`, `SANDCASTLE_REVIEWER_MODEL` — role model selection (default `opus`).

Precedence is: repository non-sensitive defaults < whitelisted `env` values from `~/.claude/settings.json` < the private environment file < non-sensitive CLI options. Startup diagnostics report counts only — never routes, model names, proxy addresses, or secret values.

## Docker image readiness

Prepare the exact content-addressed image selected by Dispatcher startup after the protected configuration is valid:

```bash
npm run sandcastle -- build-image
```

The command is idempotent and uses the same repository inputs, host UID/GID, and protected proxy configuration as Agent runtime startup. It never prints the selected image name, proxy values, credentials, or raw Docker output. Re-run it after pulling changes to the Dockerfile, dependency manifests, or lockfile; the selected image changes when any image input changes.

Verify readiness through the read-only inspection command:

```bash
npm run sandcastle -- inspect
# JSON output must contain: "imageReadiness":"ready"
```

A `"missing"` result means no Automation Command may run. Every explicit execution, scheduled dispatch round, and architecture review fails before command acquisition until `build-image` succeeds. This failure does not consume a trigger label, add `agent:in-progress`, or create Blocked Automation. Do not create or label a canary and do not enable either timer until inspection reports `ready`.

## Agent-container GitHub readiness

GitHub-capable Agent Sessions authenticate through `GH_TOKEN` read from the container environment only (#267). Before a scheduled dispatch round acquires any Automation Work Item, and before every explicit GitHub-capable operation (`run review`, `run implement`, `run implement-prd`, `run split`, `run feedback`), the Dispatcher runs a read-only `gh auth status` probe inside the exact content-addressed Agent image with the exact GitHub-capable Agent environment (transport and Claude/API allowlist plus `GH_TOKEN` and the git identity variables described below). The probe never mutates GitHub. Token values and raw readiness-command output must never be copied into logs, retained artifacts, GitHub diagnostics, or error messages — only the classified result (`ready`, `missing`, `invalid`, `unavailable`) may be reported.

The GitHub-capable Agent environment also carries the operator git identity (`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` and `GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` read from the trusted checkout's git config) because container Agents commit on the operator's behalf and the container `HOME` has no `.gitconfig` (#269). Startup fails closed when the trusted checkout has no `user.name`/`user.email`. Identity values are non-sensitive but still never copied into GitHub diagnostics.

Failure classifications:

- `missing` — `GH_TOKEN` is absent from the private environment file. Add it there, then re-run the operation or the next dispatch round.
- `invalid` — the configured `GH_TOKEN` does not authenticate. Refresh it in the private environment file.
- `unavailable` — the probe itself could not run (missing image, missing `gh` inside the image, container network failure, Docker unavailable). Diagnose through `inspect` and the dispatch-round log.

A missing or invalid result fails the round or explicit operation closed before Work Item acquisition: no trigger label is removed, no `agent:in-progress` or `agent:blocked` label is added, and no diagnostic comment is written. The Automation Work Item is left untouched and the next round or retry picks it up after the credential is restored. Verify readiness through the read-only inspection command, which reports the probe result alongside image readiness:

```bash
npm run sandcastle -- inspect
# JSON output must contain: "imageReadiness":"ready" and "githubAgentReadiness":"ready"
```

GitHub-independent operations (`run update-branch`, `architecture-review`, `setup-labels`, `inspect`) never run the probe and never receive the GitHub-capable environment.

## Label setup

Labels are the only command surface. Initialize them once, idempotently:

```bash
npm run sandcastle -- setup-labels
```

This creates the Dispatcher-owned labels `agent:implement`, `agent:review`, `agent:update-branch`, `agent:queued`, `agent:in-progress`, `agent:blocked`. It never edits an Automation Work Item. Normal dispatch fails closed when any of these labels is absent.

Two further labels are not created by `setup-labels`:

- `agent:to-issues` (PRD split trigger) — create once if absent: `gh label create agent:to-issues --color 0E8A16`.
- `source:architecture-review` — created idempotently by the architecture-review publication itself.

Retired `Sandcastle` / `sandcastle:*` labels never trigger the replacement system and are never converted. Do not add trigger labels to preserved historical Work Items.

## Deploying the systemd units

Templates live under `.sandcastle/systemd/`:

```text
sandcastle-dispatch.service              one bounded dispatch round
sandcastle-dispatch.timer                every minute
sandcastle-architecture-review.service   one architecture review
sandcastle-architecture-review.timer     09:00 UTC, Monday-Friday (upstream schedule)
```

There is no installer. Deployment is an explicit local operation:

```bash
cp .sandcastle/systemd/sandcastle-* ~/.config/systemd/user/
```

Then edit the copies for this host:

1. `WorkingDirectory=` — the trusted local repository checkout (must be a clean `master`).
2. `ExecStart=` — the host's Node 24 binary path.
3. `Environment=PATH=` — must resolve `claude`, `gh`, `git`, `docker`, `node`, and `npm`.

Reload and verify offline (this starts nothing):

```bash
systemctl --user daemon-reload
systemd-analyze verify --user ~/.config/systemd/user/sandcastle-*.service ~/.config/systemd/user/sandcastle-*.timer
systemctl --user list-timers   # confirm neither timer is enabled yet
```

Merging or copying the templates never starts either write path: the services have no `[Install]` section, and the timers are only enabled by an explicit `systemctl --user enable`. Do not enable any timer until the cutover guard below is satisfied.

Behavior notes:

- A dispatch round that finds the scheduler lock held exits without work (`status: "locked"`); overlapping rounds never run concurrently.
- `.sandcastle/dispatcher.lock` records the holder's process ID. A round that finds the lock held by a dead process (for example after a host crash) reclaims it automatically. The one remaining manual case is a lock file without a readable holder PID (left between creation and the PID write by a hard kill): it is never reclaimed automatically. Verify through `journalctl --user -u sandcastle-dispatch.service` and `inspect` that no dispatcher is running, then delete `.sandcastle/dispatcher.lock` by hand.
- The architecture-review timer uses `Persistent=false`: a missed occurrence is never replayed. The next schedule or a manual run is sufficient.
- Job time limits are enforced by the Dispatcher (process-group SIGTERM, grace, SIGKILL), so the units disable the oneshot start timeout.

## Read-only inspection

```bash
npm run sandcastle -- inspect
```

Prints Docker image readiness, Agent-container GitHub readiness, the current command frontier with per-command eligibility (`eligible`, `blocked`, `stale-in-progress`, `inconsistent`), retry guidance, and locally active jobs. It never mutates GitHub or local state. A Work Item carrying both a trigger and `agent:in-progress` (partial label mutation) is reported as `inconsistent` and is never executed. Until inspection reports `"imageReadiness":"ready"` and `"githubAgentReadiness":"ready"`, no GitHub-capable command may be acquired and no canary may be run or retried.

## Explicit operation execution

Every operation runs the same preflight and label lifecycle as scheduled dispatch and cannot invent an implicit Automation Command:

```bash
npm run sandcastle -- run implement <issue-number>        # Issue -> branch + Draft Pull Request
npm run sandcastle -- run implement-prd <issue-number>    # one eligible PRD child, then continuation
npm run sandcastle -- run split <issue-number>            # PRD -> self-contained child Issues
npm run sandcastle -- run review <pr-number>              # Pull Request review
npm run sandcastle -- run feedback <pr-number>            # implement Pull Request feedback
npm run sandcastle -- run update-branch <pr-number>       # rebase/update the Pull Request branch
npm run sandcastle -- architecture-review                 # manual architecture review
npm run sandcastle -- dispatch [--concurrency <1-8>]      # one bounded round (default 2; env: SANDCASTLE_DISPATCH_CONCURRENCY)
```

GitHub-capable operations (`run review`, `run implement`, `run implement-prd`, `run split`, `run feedback`) run the Agent-container GitHub readiness probe as part of preflight, before any label or diagnostic mutation. `run update-branch` and `architecture-review` never do.

PRD implementation holds a mandatory cross-process issue lease for the complete child operation. Its implementer performs the upstream-compatible ordinary push to the accumulating `sandcastle/prd-<n>` branch; it does not force-push. The controlled publisher remains limited to feedback implementation, where an explicit `--force-with-lease` protects an existing Pull Request branch. Moving normal PRD publication into that publisher would add branch/PR recovery state without improving the lease guarantee, so it is intentionally not used.

## Blocked Automation diagnosis

An execution, timeout, push, or publication failure adds `agent:blocked` to the Work Item with a short classified reason and a non-sensitive local job identifier. The Work Item is not terminalized. Diagnose in order:

1. `npm run sandcastle -- inspect` — confirm the command is `blocked` and read its retry guidance. Check both readiness fields too: if `githubAgentReadiness` (or `imageReadiness`) is not `ready`, a later retry of any GitHub-capable command fails closed before acquisition no matter what the frontier reports.
2. Read the classified failure comment on the Issue or Pull Request.
3. Read the dispatch-round log locally: `journalctl --user -u sandcastle-dispatch.service` (or `-t sandcastle-architecture-review`). Full Agent output exists only in local logs, never in GitHub comments.
4. Inspect the retained job artifacts under `.sandcastle/jobs/` (failed or timed-out Target Checkouts, metadata, and logs are kept for seven days).

An Agent-container GitHub readiness failure is not Blocked Automation: it fails the round or explicit operation closed before Work Item acquisition, so it adds no `agent:blocked` label and writes no diagnostic comment. If a GitHub-capable operation failed without a classified comment and without label mutation, suspect readiness first — check `inspect` and the dispatch-round log, and treat the outcome exactly as classified in the Agent-container GitHub readiness section above. Never copy token values or raw readiness-command output into a GitHub diagnostic, a retained artifact, or an error message.

## Manual retry

Whole jobs are never retried automatically. Retry is a deliberate operator action:

1. Diagnose the Blocked Automation as above.
2. Remove `agent:blocked`: `gh issue edit <n> --remove-label agent:blocked` (or `gh pr edit`).
3. Re-add the appropriate trigger label (`agent:implement`, `agent:review`, `agent:update-branch`, `agent:to-issues`, …).
4. Verify readiness: `npm run sandcastle -- inspect` must report `"imageReadiness":"ready"` and, for any GitHub-capable command, `"githubAgentReadiness":"ready"` before retrying.

The next dispatch round, or an explicit `run` command, picks the command up. Review retry reuses the existing Work Item — never create a replacement Issue, branch, or Pull Request.

A readiness failure leaves the Work Item untouched with its trigger label intact and no `agent:blocked` to remove: restore the credential or image locally, re-verify through `inspect`, then simply re-run the operation or wait for the next dispatch round — do not mutate labels. Every GitHub-capable retry must create or reuse the existing `sandcastle/issue-<n>` branch and yield exactly one Draft Pull Request; a retry that would create a second Draft Pull Request or a replacement Work Item is a failure, not a workaround. A canary retry is executed exactly once, then its evidence (below) is recorded and verified before any later canary starts.

A stale `agent:in-progress` (e.g. after a host crash) is reported by `inspect` but never adopted, resumed, or cleared automatically. Remove it manually only after verifying through `inspect` and `journalctl` that no matching job is active.

## Job retention

The agreed retention policy is seven days for successful and failed job artifacts — recent failures stay diagnosable without creating permanent run state.

- Success: the Target Checkout is deleted automatically; small job metadata and logs are retained.
- Failure or timeout: the Target Checkout, output, and logs are retained locally for diagnosis.
- Review artifacts under `.sandcastle/jobs/review-artifacts/` expire automatically after seven days (swept on each command start). Failed or timed-out Target Checkouts and other retained job directories under `.sandcastle/jobs/` follow the same seven-day sweep; only structural state (`review-artifacts/`, `pull-request-leases/`, `implementation-leases/`) is excluded. The operator may still remove retained directories earlier, after diagnosis.
- Dispatch-round logs use the systemd journal and follow journald retention.

## Safe cleanup boundaries

At cutover, delete exactly this untracked local recovery path and nothing else:

```text
/home/canxer/repos/obsidian-llm-wiki-cli/.sandcastle/recovered/
```

Never batch-delete `.sandcastle/worktrees/`, `.sandcastle/logs/`, `.git/worktrees/`, or `.claude/worktrees/` — the replacement ignores them, and a possible dirty #166 worktree must not be touched. Never delete or rewrite remote `sandcastle/*` or `archive/*` branches, historical Issues or Pull Requests, or historical commits.

## Canary sequence

Use dedicated, newly created canary Work Items for every operation family. Historical failures are never test inputs: **#216 / PR #217, #166, Legacy Run State, and archive branches are excluded from canary use** — do not label, edit, close, or reference them.

Run each canary with timers disabled and only while `inspect` reports both `"imageReadiness":"ready"` and `"githubAgentReadiness":"ready"`, in this order. A readiness failure fails the canary closed before Work Item acquisition without label mutation; recover per the Agent-container GitHub readiness section and retry the same canary — never create or label a replacement canary:

1. **Issue implementation** — create a small dedicated Issue, add `agent:implement`, then `npm run sandcastle -- run implement <n>`. Verify a `sandcastle/issue-<n>` branch and Draft Pull Request appear.
2. **Pull Request review** — add `agent:review` to that Draft Pull Request, then `npm run sandcastle -- run review <pr>`. Verify the published review identifies the exact reviewed commit.
3. **Feedback implementation** — leave a change request on the Pull Request, add `agent:implement`, then `npm run sandcastle -- run feedback <pr>`. Verify the fix is pushed to the existing branch.
4. **Branch update** — add `agent:update-branch`, then `npm run sandcastle -- run update-branch <pr>`. Verify the branch is updated from `master` with an explicit force-with-lease push.
5. **PRD split** — create a dedicated PRD Issue, add `agent:to-issues`, then `npm run sandcastle -- run split <n>`. Verify self-contained child Issues are created.
6. **PRD continuation and final review** — add `agent:implement` to the PRD, then `npm run sandcastle -- run implement-prd <n>`. Verify exactly one eligible child is implemented and the next child is requested automatically; when the final child completes, verify Pull Request review is requested automatically.
7. **Queued promotion** — create a dedicated Issue blocked by another dedicated Issue, add `agent:queued`, then close the blocker and run `npm run sandcastle -- dispatch`. Verify promotion from `agent:queued` to `agent:implement` based on current blocker state.
8. **Manual architecture review** — `npm run sandcastle -- architecture-review`. Verify a proposal Issue labelled `source:architecture-review`, or a logged skip when the backlog guard or loose-duplicate filter applies.

Record each canary's evidence before moving on: classified image and Agent-container GitHub readiness, branch identity, Draft Pull Request identity and count, and confirmation that no timer was enabled. Canaries proceed in order — no later canary starts until the previous canary's evidence is recorded and verified (the issue-implementation canary must show exactly one Draft Pull Request). Close or clean up only the dedicated canary Work Items afterwards.

## Single-writer cutover guard

The old and new write paths must never be active at the same time. Before enabling any replacement timer:

1. Stop the retired Sandcastle watch process and verify no old job is active (no watch process, no running Docker job containers).
2. Discard Legacy Run State — never adopt, resume, or reconcile it. Cleanup is limited to the exact recovery path above.
3. Prepare the protected private environment file (mode `0600`), run `npm run sandcastle -- build-image`, then run `npm run sandcastle -- inspect` and require `"imageReadiness":"ready"` and `"githubAgentReadiness":"ready"`.
4. Run `setup-labels`, then run `inspect` again and confirm a clean frontier with image and Agent-container GitHub readiness still `ready`.
5. Run the canary sequence above with timers disabled. If repository image inputs change at any point, rebuild and re-verify before continuing.
6. Only after canaries 1-7 pass and image and Agent-container GitHub readiness are still `ready`: `systemctl --user enable --now sandcastle-dispatch.timer`.
7. Only after canary 8 passes and image readiness is still `ready`: `systemctl --user enable --now sandcastle-architecture-review.timer`.

GitHub Actions is not a fallback consumer: two consumers would reintroduce duplicate execution. If the replacement must be paused, `systemctl --user stop sandcastle-dispatch.timer sandcastle-architecture-review.timer` — do not start the retired writer instead.

Verify activation with `systemctl --user list-timers` and `journalctl --user -u sandcastle-dispatch.service -f`.

## Automated verification

`test/systemd-units.test.ts` proves unit syntax (offline `systemd-analyze verify --user`), calendar expressions, and command wiring through the real CLI parser without enabling, starting, or installing anything:

```bash
npx vitest run test/systemd-units.test.ts
```
