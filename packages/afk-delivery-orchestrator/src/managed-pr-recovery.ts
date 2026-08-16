import { parseControlEnvelope, type AuthenticatedGitHubSnapshot } from "@llm-wiki/afk-delivery-core";
import {
  synchronizationStagingRef,
  type ManagedPullRequestContinuationPorts,
} from "./managed-pr-continuation.js";
import {
  extractControlEnvelope,
  extractControlNarrative,
  recognizeManagedPullRequest,
  type ManagedPullRequestRecord,
} from "./managed-pr.js";

export interface RecoveryPullRequestCandidate extends ManagedPullRequestRecord {
  repository: string;
  headRepository: string;
  open: boolean;
  ticketNumbers: number[];
  baseRevision: string;
  mergeable: boolean | "unknown";
  requiredChecksPass: boolean;
  headParents: string[];
  headMessage: string;
  headAuthor: { name: string; email: string };
  diff: string;
}

export interface ManagedPullRequestRecoveryPorts {
  listOpenPullRequests(limit: number): Promise<RecoveryPullRequestCandidate[]>;
  readSynchronizationStaging(input: {
    prNumber: number;
    inputRevision: string;
    targetRevision: string;
  }): Promise<{ revision: string; parents: string[] } | undefined>;
}

export interface ManagedPullRequestReviewContext {
  repositoryInstructions: string;
  domainDocuments: Array<{ path: string; content: string }>;
  architectureDecisions: Array<{ path: string; content: string }>;
}

export interface ManagedPullRequestReviewContextPorts {
  loadReviewContext(): Promise<ManagedPullRequestReviewContext>;
}

export interface ManagedPullRequestRecoveryPolicy {
  repository: string;
  targetBranch: string;
  trustedActors: Array<{ login: string; type: "Bot" | "App" }>;
  maximumPullRequests: number;
}

export interface ManagedPullRequestRecoveryResult {
  managedPullRequests: Array<{
    ticketNumber: number;
    prNumber: number;
    headRevision: string;
  }>;
  ambiguousTicketNumbers: number[];
}

const actorIsTrusted = (
  actor: { login: string; type: "Bot" | "App" | "User" },
  trustedActors: ManagedPullRequestRecoveryPolicy["trustedActors"],
): boolean => trustedActors.some((trusted) =>
  trusted.login === actor.login && trusted.type === actor.type,
);

export function createManagedPullRequestReconstructor(input: {
  repository: string;
  targetBranch: string;
  trustedActors: ManagedPullRequestRecoveryPolicy["trustedActors"];
  maximumPullRequests: number;
  candidates: ManagedPullRequestRecoveryPorts;
  loadReviewContext(): Promise<ManagedPullRequestReviewContext>;
  loadTicket(): Promise<AuthenticatedGitHubSnapshot["ticket"]>;
  loadTargetRevision(): Promise<string>;
}): Pick<ManagedPullRequestContinuationPorts, "reconstruct"> {
  return {
    async reconstruct() {
      const [ticket, targetBranchRevision, candidates, reviewContext] = await Promise.all([
        input.loadTicket(),
        input.loadTargetRevision(),
        input.candidates.listOpenPullRequests(input.maximumPullRequests),
        input.loadReviewContext(),
      ]);
      const snapshot = await reconstructManagedPullRequestSnapshot({
        repository: input.repository,
        targetBranch: input.targetBranch,
        targetBranchRevision,
        ticket,
        candidates: {
          listOpenPullRequests: async () => candidates,
          readSynchronizationStaging: input.candidates.readSynchronizationStaging,
        },
        reviewContext,
        trustedActors: input.trustedActors,
        maximumPullRequests: input.maximumPullRequests,
      });
      const candidate = candidates.find((value) =>
        value.ticketNumbers.length === 1 && value.ticketNumbers[0] === ticket.number,
      );
      if (candidate === undefined || snapshot.pullRequests.length !== 1) return { snapshot };
      const snapshotPr = snapshot.pullRequests[0];
      const trustedSynchronizationRecords = candidate.comments
        .filter((comment) => actorIsTrusted(comment.author, input.trustedActors))
        .map((comment) => parseControlEnvelope(extractControlEnvelope(comment.body)))
        .filter((envelope): envelope is NonNullable<typeof envelope> =>
          envelope?.kind === "synchronization" &&
          envelope.repository === input.repository &&
          envelope.ticketNumber === ticket.number &&
          envelope.prNumber === candidate.number &&
          envelope.targetRevision === targetBranchRevision
        );
      const readyRecords = trustedSynchronizationRecords.filter((envelope) =>
        envelope.disposition === "ready" && envelope.outputRevision !== undefined
      );
      const trustedCandidate = snapshotPr?.managed === true &&
        candidate.repository === input.repository &&
        candidate.headRepository === input.repository &&
        candidate.baseBranch === input.targetBranch;
      const startedRecords = trustedSynchronizationRecords.filter((envelope) =>
        envelope.disposition === "started" &&
        envelope.outputRevision === undefined &&
        envelope.transitionId.endsWith(":intent")
      );
      if (trustedCandidate && readyRecords.length === 0 && startedRecords.length === 1 &&
          candidate.headRevision === startedRecords[0]!.inputRevision) {
        const started = startedRecords[0]!;
        const staged = await input.candidates.readSynchronizationStaging({
          prNumber: candidate.number,
          inputRevision: started.inputRevision,
          targetRevision: targetBranchRevision,
        });
        if (
          staged !== undefined && staged.parents.length === 2 &&
          staged.parents.includes(started.inputRevision) &&
          staged.parents.includes(targetBranchRevision)
        ) {
          const readyEnvelope = {
            ...started,
            transitionId: `${started.transitionId.slice(0, -":intent".length)}:ready`,
            outputRevision: staged.revision,
            disposition: "ready",
          };
          return {
            snapshot,
            preparedSynchronization: {
              prNumber: candidate.number,
              headBranch: candidate.headBranch,
              inputRevision: started.inputRevision,
              outputRevision: staged.revision,
              targetRevision: targetBranchRevision,
              narrative: `Recovered prepared synchronization Revision ${staged.revision}.`,
              readyEnvelope,
            },
          };
        }
      }
      if (readyRecords.length !== 1) return { snapshot };
      const ready = readyRecords[0]!;
      const matchingStarted = startedRecords.filter((envelope) =>
        envelope.inputRevision === ready.inputRevision &&
        ready.transitionId === `${envelope.transitionId.slice(0, -":intent".length)}:ready`
      );
      if (matchingStarted.length !== 1) return { snapshot };
      if (
        trustedCandidate &&
        ready !== undefined &&
        candidate.headRevision === ready.inputRevision
      ) {
        return {
          snapshot,
          preparedSynchronization: {
            prNumber: candidate.number,
            headBranch: candidate.headBranch,
            inputRevision: ready.inputRevision,
            outputRevision: ready.outputRevision!,
            targetRevision: targetBranchRevision,
            narrative: `Published prepared synchronization Revision ${ready.outputRevision}.`,
          },
        };
      }
      if (
        trustedCandidate &&
        ready !== undefined &&
        candidate.headRevision === ready.outputRevision &&
        candidate.headParents.length === 2 &&
        candidate.headParents.includes(targetBranchRevision) &&
        candidate.headParents.includes(ready.inputRevision) &&
        !snapshot.controlComments.some((comment) => {
          const envelope = parseControlEnvelope(comment.envelope);
          return envelope?.kind === "synchronization" && envelope.disposition === "succeeded" &&
            envelope.outputRevision === candidate.headRevision;
        })
      ) {
        const inputRevision = candidate.headParents.find((parent) => parent !== targetBranchRevision)!;
        return {
          snapshot,
          interruptedSynchronization: {
            prNumber: candidate.number,
            inputRevision,
            outputRevision: candidate.headRevision,
            targetRevision: targetBranchRevision,
            narrative: `Recovered synchronization Revision ${candidate.headRevision}.`,
          },
        };
      }
      return { snapshot };
    },
  };
}

export async function reconstructManagedPullRequestSnapshot(input: {
  repository: string;
  targetBranch: string;
  targetBranchRevision: string;
  ticket: AuthenticatedGitHubSnapshot["ticket"];
  candidates: ManagedPullRequestRecoveryPorts;
  reviewContext: ManagedPullRequestReviewContext;
  trustedActors: ManagedPullRequestRecoveryPolicy["trustedActors"];
  maximumPullRequests: number;
}): Promise<AuthenticatedGitHubSnapshot> {
  const candidates = await input.candidates.listOpenPullRequests(input.maximumPullRequests);
  if (candidates.length > input.maximumPullRequests) {
    throw new Error("recovery scan exceeded the configured pull request bound");
  }
  const linked = candidates.filter((candidate) =>
    candidate.repository === input.repository &&
    candidate.open &&
    candidate.ticketNumbers.includes(input.ticket.number),
  );
  const controlComments: AuthenticatedGitHubSnapshot["controlComments"] = [];
  const pullRequests = linked.map((candidate) => {
    candidate.comments.forEach((comment, index) => {
      if (!comment.body.includes("<!-- afk-control-envelope\n")) return;
      const envelope = parseControlEnvelope(extractControlEnvelope(comment.body));
      controlComments.push({
        commentId: `pr-${candidate.number}-comment-${index + 1}`,
        author: comment.author,
        envelope: envelope ?? extractControlEnvelope(comment.body) ?? comment.body,
        narrative: extractControlNarrative(comment.body),
      });
    });
    return {
      number: candidate.number,
      ticketNumber: input.ticket.number,
      open: candidate.open,
      targetBranch: candidate.baseBranch,
      headBranch: candidate.headBranch,
      headRevision: candidate.headRevision,
      baseRevision: candidate.baseRevision,
      mergeable: candidate.mergeable,
      requiredChecksPass: candidate.requiredChecksPass,
      managed: candidate.ticketNumbers.length === 1 &&
        candidate.baseBranch === input.targetBranch &&
        candidate.headRepository === input.repository &&
        recognizeManagedPullRequest(candidate, {
          repository: input.repository,
          ticketNumber: input.ticket.number,
          targetBranch: input.targetBranch,
          trustedActors: input.trustedActors,
        }).managed,
      body: candidate.body,
      diff: candidate.diff,
    };
  });
  return {
    repository: input.repository,
    ...input.reviewContext,
    targetBranchRevision: input.targetBranchRevision,
    ticket: input.ticket,
    pullRequests,
    controlComments,
  };
}

export async function discoverManagedPullRequestRecovery(
  ports: ManagedPullRequestRecoveryPorts,
  policy: ManagedPullRequestRecoveryPolicy,
): Promise<ManagedPullRequestRecoveryResult> {
  if (!Number.isSafeInteger(policy.maximumPullRequests) || policy.maximumPullRequests <= 0) {
    throw new Error("maximumPullRequests must be a positive integer");
  }
  const candidates = await ports.listOpenPullRequests(policy.maximumPullRequests);
  if (candidates.length > policy.maximumPullRequests) {
    throw new Error("recovery scan exceeded the configured pull request bound");
  }

  const authenticated = new Map<number, Array<{ prNumber: number; headRevision: string }>>();
  for (const candidate of candidates) {
    if (
      !candidate.open ||
      candidate.repository !== policy.repository ||
      candidate.headRepository !== policy.repository ||
      candidate.baseBranch !== policy.targetBranch ||
      candidate.ticketNumbers.length !== 1
    ) continue;
    const ticketNumber = candidate.ticketNumbers[0]!;
    const managed = recognizeManagedPullRequest(candidate, {
      repository: policy.repository,
      ticketNumber,
      targetBranch: policy.targetBranch,
      trustedActors: policy.trustedActors,
    });
    if (!managed.managed) continue;
    const records = authenticated.get(ticketNumber) ?? [];
    records.push({ prNumber: candidate.number, headRevision: candidate.headRevision });
    authenticated.set(ticketNumber, records);
  }

  const managedPullRequests: ManagedPullRequestRecoveryResult["managedPullRequests"] = [];
  const ambiguousTicketNumbers: number[] = [];
  for (const [ticketNumber, records] of authenticated) {
    if (records.length === 1) {
      managedPullRequests.push({ ticketNumber, ...records[0]! });
    } else {
      ambiguousTicketNumbers.push(ticketNumber);
    }
  }
  managedPullRequests.sort((left, right) => left.ticketNumber - right.ticketNumber);
  ambiguousTicketNumbers.sort((left, right) => left - right);
  return { managedPullRequests, ambiguousTicketNumbers };
}
