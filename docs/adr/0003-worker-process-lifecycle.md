# ADR-0003: Shared worker-process lifecycle with distinct protocol adapters

## Status

Accepted

## Context

Sandcastle process adapters independently rebuilt child observation, output capture, nested versus owned process-group handling, timeout policy execution, graceful termination, forced termination, and group-exit confirmation. The duplication caused a startup ordering defect: adapters could deliver trusted stdin input before registering output and completion listeners.

The process protocols are intentionally different. Agent workers, review workers, architecture-review workers, Git execution, and conflict resolution each own fixed launch authority, arguments, environment construction, checkout and artifact decisions, protocol parsing, and business error mapping.

## Decision

Use one private `worker-process-lifecycle` module for child admission, listener-first startup delivery, stdout/stderr capture, semantic owner/nested group disposition, timeout execution through `job-timeout`, graceful and forced POSIX group termination, and group-exit confirmation.

A protocol adapter launches its fixed child through callback inversion. The lifecycle module supplies a one-use admission function and the derived detached/inherited disposition; it installs all listeners before delivering the adapter-provided startup payload and closes stdin. The lifecycle module accepts neither executable, worker file, arguments, environment, checkout, artifact, parser, nor business error factory.

Nested inheritance derives only from the inherited whole-job marker in the trusted process environment. An owner and a standalone nested child each form a bounded detached group. A nested child already inside the whole-job group creates no inner deadline and never signals the shared group.

The lifecycle result is transport-only: completed output includes complete stdout, stderr, a numeric-or-null exit code, and a recorded first output-sink error. A timeout is returned only after required group cleanup. Launch, PID, child-event, stdin, stream, probe, and signal failures reject. The output remains unbounded. Only `ESRCH` proves a group absent; every other probe or signal error fails closed.

`job-timeout` remains a focused implementation dependency of the lifecycle module. Direct-child exit can occur before stream closure, so lifecycle cleanup observes the direct `exit` event while `close` remains the output-completeness boundary. Final group-exit confirmation after `SIGKILL` is intentionally unbounded: an abnormal kernel or process-group state can prevent a lifecycle result rather than falsely report cleanup.

## Consequences

The deletion test must show that removing the lifecycle module forces multiple adapters to reconstruct lifecycle mechanics, while deleting an adapter removes only its fixed protocol contract. A universal process runner is rejected: it would centralize command authority and weaken the existing static launch-authority model. This design assumes POSIX detached process groups and negative-PID signaling; cross-platform tree control is out of scope.
