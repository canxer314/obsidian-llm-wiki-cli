import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PublishedReview, ReviewAutomationPorts } from "./review-automation.ts";

const executeFile = promisify(execFile);

type Execute = (
  file: string,
  arguments_: readonly string[],
  environment?: Readonly<Record<string, string>>,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

function reviewEvent(review: PublishedReview): "APPROVE" | "REQUEST_CHANGES" {
  return review.verdict === "Approved" ? "APPROVE" : "REQUEST_CHANGES";
}

function reviewBody(review: PublishedReview): string {
  if (review.findings.length === 0) return review.summary;
  const findings = review.findings.map((finding) => {
    if (
      typeof finding !== "object" ||
      finding === null ||
      !("summary" in finding) ||
      !("details" in finding) ||
      typeof finding.summary !== "string" ||
      typeof finding.details !== "string"
    ) {
      throw new Error("Review findings must contain a summary and details");
    }
    return `- **${finding.summary}**: ${finding.details}`;
  });
  return `${review.summary}\n\n${findings.join("\n")}`;
}

export function createAutomationGithubPort(options: {
  readonly execute?: Execute;
  readonly environment?: Readonly<Record<string, string>>;
}): ReviewAutomationPorts["github"] & ReviewAutomationPorts["publisher"] {
  const execute = options.execute ?? (async (file, arguments_, environment) => {
    const result = await executeFile(file, [...arguments_], { env: environment });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  return {
    async readPullRequest(pullRequestNumber) {
      const { stdout } = await execute("gh", [
        "pr", "view", String(pullRequestNumber), "--json",
        "number,state,isDraft,baseRepository,headRepository,headRefOid,labels",
      ], options.environment);
      const pullRequest = JSON.parse(stdout) as {
        readonly number: number;
        readonly state: string;
        readonly isDraft: boolean;
        readonly baseRepository: { readonly nameWithOwner: string } | null;
        readonly headRepository: { readonly nameWithOwner: string } | null;
        readonly headRefOid: string;
        readonly labels: readonly { readonly name: string }[];
      };
      if (pullRequest.baseRepository === null || pullRequest.headRepository === null) {
        throw new Error(`Pull Request #${pullRequestNumber} repository identity is unavailable`);
      }
      return {
        number: pullRequest.number,
        state: pullRequest.state,
        isDraft: pullRequest.isDraft,
        baseRepository: pullRequest.baseRepository.nameWithOwner,
        headRepository: pullRequest.headRepository.nameWithOwner,
        headSha: pullRequest.headRefOid,
        labels: pullRequest.labels.map(({ name }) => name),
      };
    },
    async addPullRequestLabel(pullRequestNumber, label) {
      await execute("gh", ["pr", "edit", String(pullRequestNumber), "--add-label", label], options.environment);
    },
    async removePullRequestLabel(pullRequestNumber, label) {
      await execute("gh", ["pr", "edit", String(pullRequestNumber), "--remove-label", label], options.environment);
    },
    async addBlockedDiagnostic(pullRequestNumber, diagnostic) {
      await execute("gh", [
        "pr", "comment", String(pullRequestNumber), "--body",
        `Automation review is blocked (${diagnostic.reason}; job ${diagnostic.jobId}). Remove agent:blocked, restore agent:review, then retry.`,
      ], options.environment);
    },
    async publish(request) {
      await execute("gh", [
        "api", `repos/{owner}/{repo}/pulls/${request.pullRequestNumber}/reviews`, "--method", "POST",
        "-f", `commit_id=${request.revision}`,
        "-f", `event=${reviewEvent(request.review)}`,
        "-f", `body=${reviewBody(request.review)}`,
      ], options.environment);
    },
  };
}
