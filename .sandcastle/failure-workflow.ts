import { SandcastleCancellationError } from "./cli.ts";
import type { VerifiedPullRequest } from "./implementer.ts";
import {
  finalizeFailure,
  type FailureGithubPort,
} from "./failure-finalizer.ts";
import type { TerminalFailure } from "./repair-orchestrator.ts";

interface WorkflowProgress {
  enter(stage: string, pullRequest?: VerifiedPullRequest): void;
}

interface WorkflowResult<TResult> {
  readonly result: TResult;
  readonly terminalFailure?: TerminalFailure;
  readonly pullRequest?: VerifiedPullRequest;
}

interface FailureAwareWorkflowOptions<TResult> {
  readonly issueNumber: number;
  readonly github: FailureGithubPort;
  readonly run: (progress: WorkflowProgress) => Promise<WorkflowResult<TResult>>;
}

export class SandcastleWorkflowError extends Error {
  readonly stage: string;
  readonly finalizationFailures: readonly string[];

  constructor(
    stage: string,
    finalizationFailures: readonly string[],
    options?: ErrorOptions,
  ) {
    const suffix = finalizationFailures.length === 0
      ? ""
      : `; failure finalization incomplete: ${finalizationFailures.join("; ")}`;
    super(`Sandcastle stopped during ${stage}${suffix}`, options);
    this.name = "SandcastleWorkflowError";
    this.stage = stage;
    this.finalizationFailures = finalizationFailures;
  }
}

function isControlledCancellation(error: unknown): boolean {
  return error instanceof SandcastleCancellationError;
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runFailureAwareWorkflow<TResult>(
  options: FailureAwareWorkflowOptions<TResult>,
): Promise<TResult> {
  let stage = "planner";
  let pullRequest: VerifiedPullRequest | undefined;
  const progress: WorkflowProgress = {
    enter(nextStage, nextPullRequest) {
      stage = nextStage;
      if (nextPullRequest !== undefined) pullRequest = nextPullRequest;
    },
  };

  try {
    const outcome = await options.run(progress);
    if (outcome.terminalFailure === undefined) return outcome.result;
    pullRequest = outcome.pullRequest ?? pullRequest;
    const finalization = await finalizeFailure({
      issueNumber: options.issueNumber,
      ...(pullRequest === undefined ? {} : {
        pullRequestNumber: pullRequest.number,
      }),
      ...outcome.terminalFailure,
    }, options.github);
    throw new SandcastleWorkflowError(
      outcome.terminalFailure.stage,
      finalization.failures,
    );
  } catch (error) {
    if (error instanceof SandcastleWorkflowError || isControlledCancellation(error)) throw error;
    const finalization = await finalizeFailure({
      issueNumber: options.issueNumber,
      ...(pullRequest === undefined ? {} : {
        pullRequestNumber: pullRequest.number,
        revision: pullRequest.headSha,
      }),
      stage,
      summary: errorSummary(error),
    }, options.github);
    throw new SandcastleWorkflowError(stage, finalization.failures, { cause: error });
  }
}
