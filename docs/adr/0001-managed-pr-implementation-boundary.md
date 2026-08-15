# ADR 0001: Isolate implementation from Managed PR publication

## Status

Accepted

## Context

A Delivery Ticket at the Delivery Frontier needs an implementation commit before it can become a Managed PR. Ticket content and repository files are untrusted agent inputs, while branch pushes, pull request creation, and trusted Control Envelopes mutate the durable GitHub record.

An interrupted Delivery Worker may stop after producing or pushing a Revision but before creating the Implementation PR or posting its initial management record. Re-running the implementation agent could create a different Revision and make the transition ambiguous.

## Decision

The implementation stage runs in a disposable, non-root repository clone with bounded model, context, iteration, time, and CPU policy. It receives repository instructions, domain context, relevant architecture decisions, the complete Delivery Ticket, target branch, and validation policy. It receives no GitHub mutation credentials or host control mounts.

The deterministic Delivery Worker owns all GitHub mutation. It uses a branch name derived from the implementation transition identity, pushes the exact implementation Revision, creates a uniquely closing-linked Implementation PR, and posts the initial trusted Managed PR Control Envelope.

The deterministic remote branch is the recovery marker for an interrupted new-implementation transition. A fresh worker checks it before invoking an agent. If it exists, the worker resumes PR and management-record publication from that exact Revision instead of creating another implementation. After publication, the worker reconstructs the PR and trusted comment from GitHub and verifies that it is recognizable as a Managed PR.

## Consequences

- The agent cannot directly publish or forge durable workflow state.
- Retries after branch push, PR creation, or comment creation converge on one branch, PR, and initial management record.
- Branch identity and trusted Control Envelopes become protocol surfaces that require versioned, deterministic construction.
- A conflicting remote branch or multiple closing-linked Implementation PRs fail closed rather than being overwritten or guessed.
- Temporary clones, prompts, logs, and model sessions remain disposable; GitHub alone is sufficient for continuation.
