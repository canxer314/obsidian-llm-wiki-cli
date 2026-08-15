import {
  implementationBranch,
  runImplementationStage,
  type ImplementationStagePorts,
  type ImplementationStageRequest,
  type ImplementationStageResult,
} from "./implementation.js";
import {
  publishManagedImplementation,
  recognizeManagedPullRequest,
  type ManagedImplementationPorts,
} from "./managed-pr.js";

export async function executeNewImplementationTransition(
  request: ImplementationStageRequest & {
    workflowRunId: string;
    trustedActor: { login: string; type: "Bot" | "App" };
  },
  ports: {
    stage: ImplementationStagePorts;
    publication: ManagedImplementationPorts;
  },
): Promise<
  | { status: "failed"; stage: Extract<ImplementationStageResult, { status: "failed" }> }
  | {
      status: "published";
      prNumber: number;
      outputRevision: string;
      created: boolean;
      managementRecordCreated: boolean;
    }
> {
  const branch = implementationBranch(request);
  const recoveredRevision = await ports.publication.findRemoteBranchRevision(branch);
  const stage = recoveredRevision === undefined
    ? await runImplementationStage(request, ports.stage)
    : {
        status: "succeeded" as const,
        branch,
        baseRevision: recoveredRevision,
        outputRevision: recoveredRevision,
        narrative: "Recovered the implementation Revision from the deterministic remote branch.",
      };
  if (stage.status === "failed") return { status: "failed", stage };
  const published = await publishManagedImplementation({
    repository: request.repository,
    ticket: request.ticket,
    targetBranch: request.targetBranch,
    branch: stage.branch,
    outputRevision: stage.outputRevision,
    transitionId: request.transitionId,
    workflowRunId: request.workflowRunId,
    trustedActor: request.trustedActor,
    narrative: stage.narrative,
  }, ports.publication);
  const candidates = await ports.publication.findOpenPullRequests(
    request.ticket.number,
    stage.branch,
    request.targetBranch,
  );
  const managed = candidates.length === 1
    ? recognizeManagedPullRequest(candidates[0]!, {
        repository: request.repository,
        ticketNumber: request.ticket.number,
        trustedActors: [request.trustedActor],
      })
    : { managed: false as const };
  if (!managed.managed || candidates[0]?.number !== published.prNumber ||
      managed.initialRevision !== stage.outputRevision) {
    throw new Error("fresh GitHub reconstruction did not recognize the published Managed PR");
  }
  return { status: "published", ...published };
}
