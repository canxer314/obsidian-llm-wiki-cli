import { parseControlEnvelope, type AuthenticatedGitHubSnapshot } from "@llm-wiki/afk-delivery-core";
import type { ManagedPullRequestContinuationPorts } from "./managed-pr-continuation.js";
import {
  extractControlEnvelope,
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
}

export interface ManagedPullRequestRecoveryPorts {
  listOpenPullRequests(limit: number): Promise<RecoveryPullRequestCandidate[]>;
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

const AFK_SYNC_AUTHOR = { name: "AFK Delivery", email: "afk-delivery@invalid" };

export function createManagedPullRequestReconstructor(input: {
  repository: string;
  targetBranch: string;
  trustedActors: ManagedPullRequestRecoveryPolicy["trustedActors"];
  maximumPullRequests: number;
  candidates: ManagedPullRequestRecoveryPorts;
  loadTicket(): Promise<AuthenticatedGitHubSnapshot["ticket"]>;
  loadTargetRevision(): Promise<string>;
}): Pick<ManagedPullRequestContinuationPorts, "reconstruct"> {
  return {
    async reconstruct() {
      const [ticket, targetBranchRevision, candidates] = await Promise.all([
        input.loadTicket(),
        input.loadTargetRevision(),
        input.candidates.listOpenPullRequests(input.maximumPullRequests),
      ]);
      const snapshot = await reconstructManagedPullRequestSnapshot({
        repository: input.repository,
        targetBranchRevision,
        ticket,
        candidates: { listOpenPullRequests: async () => candidates },
        trustedActors: input.trustedActors,
        maximumPullRequests: input.maximumPullRequests,
      });
      const candidate = candidates.find((value) =>
        value.ticketNumbers.length === 1 && value.ticketNumbers[0] === ticket.number,
      );
      if (
        candidate !== undefined &&
        candidate.headParents.length === 2 &&
        candidate.headParents.includes(targetBranchRevision) &&
        candidate.headMessage === `AFK Delivery synchronize ${targetBranchRevision} into ${candidate.headParents.find((parent) => parent !== targetBranchRevision)}` &&
        candidate.headAuthor.name === AFK_SYNC_AUTHOR.name &&
        candidate.headAuthor.email === AFK_SYNC_AUTHOR.email &&
        !snapshot.controlComments.some((comment) => {
          const envelope = parseControlEnvelope(comment.envelope);
          return envelope?.kind === "synchronization" && envelope.outputRevision === candidate.headRevision;
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
  targetBranchRevision: string;
  ticket: AuthenticatedGitHubSnapshot["ticket"];
  candidates: ManagedPullRequestRecoveryPorts;
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
    candidate.ticketNumbers.length === 1 &&
    candidate.ticketNumbers[0] === input.ticket.number,
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
        narrative: comment.body,
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
      managed: candidate.headRepository === input.repository &&
        recognizeManagedPullRequest(candidate, {
          repository: input.repository,
          ticketNumber: input.ticket.number,
          targetBranch: candidate.baseBranch,
          trustedActors: input.trustedActors,
        }).managed,
      body: candidate.body,
    };
  });
  return {
    repository: input.repository,
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
