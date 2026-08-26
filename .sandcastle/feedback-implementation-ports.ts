import {
  runFeedbackImplementationAutomationCommand,
  type FeedbackImplementationPorts,
  type FeedbackReplyIntent,
} from "./feedback-implementation-automation.ts";
import { classifyGithubReadError } from "./github-cli.ts";

export function createFeedbackImplementationPorts(options: Omit<FeedbackImplementationPorts, "classifyReadError">): FeedbackImplementationPorts {
  return {
    ...options,
    classifyReadError: classifyGithubReadError,
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
  options: Omit<FeedbackImplementationPorts, "classifyReadError">,
) {
  return runFeedbackImplementationAutomationCommand(request, createFeedbackImplementationPorts(options));
}

export function createFeedbackImplementationEntry(
  optionsFor: (pullRequestNumber: number) => Omit<FeedbackImplementationPorts, "classifyReadError">,
) {
  return {
    runDirect(
      pullRequestNumber: number,
      reconcile?: {
        readonly invocation: "reconcile";
        readonly baseRevision?: string;
        readonly expectedPost?: string;
        readonly expectedReply?: FeedbackReplyIntent;
      },
    ) {
      return runFeedbackImplementation({
        pullRequestNumber,
        ...(reconcile === undefined ? {} : { invocation: reconcile.invocation }),
        ...(reconcile?.baseRevision === undefined ? {} : { baseRevision: reconcile.baseRevision }),
        ...(reconcile?.expectedPost === undefined ? {} : { expectedPost: reconcile.expectedPost }),
        ...(reconcile?.expectedReply === undefined ? {} : { expectedReply: reconcile.expectedReply }),
      }, optionsFor(pullRequestNumber));
    },
    runDispatcher(pullRequestNumber: number) {
      return runFeedbackImplementation({ pullRequestNumber }, optionsFor(pullRequestNumber));
    },
  };
}
