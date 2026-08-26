import {
  runFeedbackImplementationAutomationCommand,
  type FeedbackImplementationPorts,
  type FeedbackReplyIntent,
} from "./feedback-implementation-automation.ts";
import { isTransientGithubReadError } from "./github-cli.ts";

export function createFeedbackImplementationPorts(options: Omit<FeedbackImplementationPorts, "isTransientReadError">): FeedbackImplementationPorts {
  return {
    ...options,
    isTransientReadError: isTransientGithubReadError,
  };
}

export function runFeedbackImplementation(
  request: {
    readonly pullRequestNumber: number;
    readonly invocation?: "ordinary" | "reconcile";
    readonly baseRevision?: string;
    readonly expectedPost?: string;
    readonly expectedReply?: FeedbackReplyIntent;
  },
  options: Omit<FeedbackImplementationPorts, "isTransientReadError">,
) {
  return runFeedbackImplementationAutomationCommand(request, createFeedbackImplementationPorts(options));
}
