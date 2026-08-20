import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ClaimReconciliationPorts,
  ClaimReconciliationSnapshot,
} from "./claim-reconciliation.ts";
import { reconcileClaim } from "./claim-reconciliation.ts";
import type { SandcastleStatusFormat } from "./live-status.ts";

const execFileAsync = promisify(execFile);

export class ClaimInspectionStartupError extends Error {
  constructor() {
    super("Could not resolve claim inspection identity");
    this.name = "ClaimInspectionStartupError";
  }
}

export interface ClaimInspectionIdentity {
  readonly repository: string;
  readonly comparisonBaseSha: string;
}

export type ClaimInspectionCommand = (
  file: string,
  arguments_: readonly string[],
  options?: { readonly cwd?: string },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const runCommand: ClaimInspectionCommand = async (file, arguments_, options) => {
  const result = await execFileAsync(file, [...arguments_], { ...options, encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr };
};

export async function resolveClaimInspectionIdentity(
  repositoryPath: string,
  run: ClaimInspectionCommand = runCommand,
): Promise<ClaimInspectionIdentity> {
  try {
    const [{ stdout: repositoryOutput }, { stdout: baseShaOutput }] = await Promise.all([
      run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
        cwd: repositoryPath,
      }),
      run("gh", ["api", "repos/{owner}/{repo}/commits/HEAD", "--jq", ".sha"], {
        cwd: repositoryPath,
      }),
    ]);
    const repository = repositoryOutput.trim();
    const comparisonBaseSha = baseShaOutput.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
      !/^[0-9a-f]{40}$/u.test(comparisonBaseSha)) {
      throw new ClaimInspectionStartupError();
    }
    return { repository, comparisonBaseSha };
  } catch {
    throw new ClaimInspectionStartupError();
  }
}

export interface ClaimInspectionOptions {
  readonly repository: string;
  readonly issueNumber: number;
  readonly comparisonBaseSha: string;
  readonly ports: ClaimReconciliationPorts;
  readonly format?: SandcastleStatusFormat;
  readonly isTty?: () => boolean;
  readonly sink?: (line: string) => void;
}

function renderPullRequestItems(snapshot: ClaimReconciliationSnapshot): string {
  if (snapshot.pullRequests.items.length === 0) return "none";
  return snapshot.pullRequests.items.map((pullRequest) =>
    `#${pullRequest.number}:${pullRequest.state}:${pullRequest.headSha}:closes-issue=${pullRequest.closesIssue}`
  ).join(",");
}

export function renderClaimInspectionHuman(snapshot: ClaimReconciliationSnapshot): string {
  return [
    `repository=${snapshot.repository}`,
    `issue.number=${snapshot.issueNumber}`,
    `issue.existence=${snapshot.issue.existence}`,
    `issue.state=${snapshot.issue.state}`,
    `issue.eligibility=${snapshot.issue.eligibility}`,
    `claim-branch.name=${snapshot.branch}`,
    `claim-branch.state=${snapshot.claimBranch.state}`,
    `claim-branch.head-sha=${snapshot.claimBranch.headSha ?? "unknown"}`,
    `claim-branch.relation=${snapshot.branchRelation}`,
    `claim-branch.unique-commits.state=${snapshot.uniqueCommits.state}`,
    `claim-branch.unique-commits.count=${snapshot.uniqueCommits.state === "unknown" ? "unknown" : snapshot.uniqueCommits.count}`,
    `pull-requests.state=${snapshot.pullRequests.state}`,
    `pull-requests.count=${snapshot.pullRequests.count}`,
    `pull-requests.items=${renderPullRequestItems(snapshot)}`,
    `worktree=${snapshot.worktree}`,
    `container=${snapshot.container}`,
    `inconsistent=${snapshot.inconsistent}`,
    `classification=${snapshot.classification}`,
    `recommended-action=${snapshot.recommendedAction}`,
  ].join("\n");
}

export function renderClaimInspectionJson(snapshot: ClaimReconciliationSnapshot): string {
  return JSON.stringify({
    sandcastleClaimInspection: {
      version: 1,
      ...snapshot,
    },
  });
}

export async function inspectClaim(options: ClaimInspectionOptions): Promise<ClaimReconciliationSnapshot> {
  const snapshot = await reconcileClaim({
    repository: options.repository,
    issueNumber: options.issueNumber,
    branch: `sandcastle/issue-${options.issueNumber}`,
    comparisonBaseSha: options.comparisonBaseSha,
  }, options.ports);
  const format = options.format ?? ((options.isTty ?? (() => process.stdout.isTTY === true))()
    ? "human"
    : "json");
  const output = format === "human"
    ? renderClaimInspectionHuman(snapshot)
    : renderClaimInspectionJson(snapshot);
  (options.sink ?? ((line: string) => console.log(line)))(output);
  return snapshot;
}
