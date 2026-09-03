# ADR-0004: Auto-recover provably-dead Interrupted Automation

## Status

Accepted

## Context

The Dispatcher's #219 settlement rule refuses to adopt or clear an `agent:in-progress` Automation Work Item automatically, so a live job's visible ownership evidence is never cleared. Host and WSL shutdowns kill the job process with SIGTERM before the settlement path runs, stranding the Work Item in `agent:in-progress` with no `agent:blocked`, its trigger removed or still present — a state now named Interrupted Automation.

## Decision

The Dispatcher auto-recovers an Interrupted Automation, but only when the owning job is provably dead: no live scheduler job, the local job log metadata still reads `running`, and its `startedAt` is at least five minutes old. It clears `agent:in-progress`, restores the trigger from that metadata's `operation` when absent, and leaves a diagnostic comment. Missing or ambiguous metadata fails closed, leaving the Work Item for operator inspection. `agent:blocked` stays never-retried-automatically.

## Consequences

A Work Item interrupted by host shutdown resumes on the next dispatch round without operator action. The five-minute floor and liveness check bound the risk of adopting a still-running job; a false negative only delays recovery one round. Crashed Target Checkouts and logs remain on the existing seven-day retention and are discarded, never resumed.
