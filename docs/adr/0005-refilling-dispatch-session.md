# ADR-0005: Drain-to-idle refilling Dispatch Session

## Status

Accepted

## Context

The Dispatcher ran as a one-shot round: it froze one discovery snapshot into a frontier, ran that frontier to completion, and exited until the next timer tick restarted it. A command that became eligible after the snapshot — for example once a running job's completion unblocked it — waited a full round even while worker slots sat idle.

## Decision

Replace the one-shot round with a continuously-refilling Dispatch Session. One session takes the scheduling lock, keeps its bounded workers full by re-discovering on worker completion and a short idle poll, runs queue promotion before each discovery, and releases the lock only when a clean discovery finds no eligible command and no worker is running. A single job or refill failure is recorded but does not end the session, which has no maximum lifetime.

## Consequences

Newly-eligible work fills an idle slot within one poll interval instead of one round. The Dispatcher runs its session-start code until drained — prepare and Interrupted Automation recovery stay at session start, target revisions still come from GitHub HEAD, and the systemd timer is unchanged — while the frozen frontier's one-operation-per-Work-Item invariant is preserved by excluding in-flight identities from each refill.
