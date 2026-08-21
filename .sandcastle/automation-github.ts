import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FeedbackImplementationPorts } from "./feedback-implementation-automation.ts";
import type { ImplementationAutomationPorts } from "./implementation-automation.ts";
import type {
  PublishedReview,
  ReviewAutomationPorts,
  ReviewFinding,
} from "./review-automation.ts";

const executeFile = promisify(execFile);

type Execute = (
  file: string,
  arguments_: readonly string[],
  environment?: Readonly<Record<string, string>>,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

function reviewEvent(review: PublishedReview): "APPROVE" | "REQUEST_CHANGES" {
  return review.verdict === "Approved" ? "APPROVE" : "REQUEST_CHANGES";
}

function findingBody(finding: ReviewFinding): string {
  return `**${finding.summary}**: ${finding.details}`;
}

function reviewBody(review: PublishedReview): string {
  if (review.findings.length === 0) return review.summary;
  return `${review.summary}\n\n${review.findings.map((finding) => `- ${findingBody(finding)}`).join("\n")}`;
}

interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
}

interface PullRequestFile {
  readonly filename: string;
  readonly patch?: string;
}

function diffLocations(files: readonly PullRequestFile[]): ReadonlyMap<string, { readonly LEFT: ReadonlySet<number>; readonly RIGHT: ReadonlySet<number> }> {
  const locations = new Map<string, { LEFT: Set<number>; RIGHT: Set<number> }>();
  for (const file of files) {
    const location = { LEFT: new Set<number>(), RIGHT: new Set<number>() };
    let left = 0;
    let right = 0;
    for (const line of file.patch?.split("\n") ?? []) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
      if (hunk !== null) {
        left = Number(hunk[1]);
        right = Number(hunk[2]);
      } else if (line.startsWith("-")) {
        location.LEFT.add(left);
        left += 1;
      } else if (line.startsWith("+")) {
        location.RIGHT.add(right);
        right += 1;
      } else if (line.startsWith(" ")) {
        location.LEFT.add(left);
        location.RIGHT.add(right);
        left += 1;
        right += 1;
      }
    }
    locations.set(file.filename, location);
  }
  return locations;
}

function inlineComments(
  review: PublishedReview,
  locations: ReadonlyMap<string, { readonly LEFT: ReadonlySet<number>; readonly RIGHT: ReadonlySet<number> }>,
): readonly InlineComment[] {
  return review.findings.flatMap((finding) => {
    if (finding.location === undefined) return [];
    const { path, line, side } = finding.location;
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      (side !== "LEFT" && side !== "RIGHT")
    ) {
      throw new Error("Review inline comment location is invalid");
    }
    return locations.get(path)?.[side].has(line) === true
      ? [{ path, line, side, body: findingBody(finding) }]
      : [];
  });
}

export function createAutomationGithubPort(options: {
  readonly execute?: Execute;
  readonly environment?: Readonly<Record<string, string>>;
}): ReviewAutomationPorts["github"] & ReviewAutomationPorts["publisher"] & ImplementationAutomationPorts["github"] & FeedbackImplementationPorts["github"] {
  const execute = options.execute ?? (async (file, arguments_, environment) => {
    const result = await executeFile(file, [...arguments_], { env: environment });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  return {
    async readIssue(issueNumber) {
      const [{ stdout: issueOutput }, { stdout: baseRevisionOutput }] = await Promise.all([
        execute("gh", [
          "api", `repos/{owner}/{repo}/issues/${issueNumber}`,
          "--jq", "{number, state, labels, pull_request}",
        ], options.environment),
        execute("gh", ["api", "repos/{owner}/{repo}/commits/HEAD", "--jq", ".sha"], options.environment),
      ]);
      const issue = JSON.parse(issueOutput) as {
        readonly number: number;
        readonly state: string;
        readonly labels: readonly { readonly name: string }[];
        readonly pull_request?: unknown;
      };
      if (issue.pull_request !== undefined && issue.pull_request !== null) {
        throw new Error(`Automation work item #${issueNumber} is a Pull Request`);
      }
      return {
        number: issue.number,
        state: issue.state,
        labels: issue.labels.map(({ name }) => name),
        baseRevision: baseRevisionOutput.trim(),
      };
    },
    async findReusableImplementation(request) {
      const [{ stdout: repositoryOutput }, { stdout: pullRequestsOutput }, { stdout: branchOutput }] = await Promise.all([
        execute("gh", ["repo", "view", "--json", "defaultBranchRef"], options.environment),
        execute("gh", [
          "pr", "list", "--head", request.branch, "--state", "all",
          "--json", "url,state,isDraft,baseRefName,headRefName,body", "--limit", "2",
        ], options.environment),
        execute("gh", ["api", `repos/{owner}/{repo}/git/matching-refs/heads/${request.branch}`], options.environment),
      ]);
      const repository = JSON.parse(repositoryOutput) as {
        readonly defaultBranchRef: { readonly name: string };
      };
      const pullRequests = JSON.parse(pullRequestsOutput) as readonly {
        readonly url: string;
        readonly state: string;
        readonly isDraft: boolean;
        readonly baseRefName: string;
        readonly headRefName: string;
        readonly body: string;
      }[];
      const branches = JSON.parse(branchOutput) as readonly { readonly ref: string }[];
      const branchExists = branches.some(({ ref }) => ref === `refs/heads/${request.branch}`);
      if (pullRequests.length === 0) {
        return branchExists ? { status: "branch" as const, branch: request.branch } : undefined;
      }
      if (pullRequests.length !== 1) {
        throw new Error(`Expected one Pull Request for ${request.branch}; found ${pullRequests.length}`);
      }
      const pullRequest = pullRequests[0]!;
      if (
        pullRequest.state.toUpperCase() !== "OPEN" ||
        !pullRequest.isDraft ||
        pullRequest.baseRefName !== repository.defaultBranchRef.name ||
        pullRequest.headRefName !== request.branch ||
        !new RegExp(`(?:^|\\s)closes\\s+#${request.issueNumber}(?=\\s|$|[.,;:!?])`, "i").test(pullRequest.body)
      ) {
        throw new Error(`Existing Pull Request for ${request.branch} is not an upstream-equivalent Draft`);
      }
      return { status: "pull-request", branch: request.branch, pullRequestUrl: pullRequest.url };
    },
    async publishExistingImplementation(request) {
      const { stdout } = await execute("gh", [
        "pr", "create", "--draft", "--head", request.branch,
        "--body", `Closes #${request.issueNumber}`,
        "--title", `Implement #${request.issueNumber}`,
      ], options.environment);
      return { branch: request.branch, pullRequestUrl: stdout.trim() };
    },
    async addIssueLabel(issueNumber, label) {
      await execute("gh", ["issue", "edit", String(issueNumber), "--add-label", label], options.environment);
    },
    async removeIssueLabel(issueNumber, label) {
      await execute("gh", ["issue", "edit", String(issueNumber), "--remove-label", label], options.environment);
    },
    async addRefusalDiagnostic(issueNumber, reason) {
      await execute("gh", ["issue", "comment", String(issueNumber), "--body", reason], options.environment);
    },
    async addImplementationBlockedDiagnostic(issueNumber, diagnostic) {
      await execute("gh", [
        "issue", "comment", String(issueNumber), "--body",
        `Automation implementation is blocked (${diagnostic.reason}; job ${diagnostic.jobId}; ${diagnostic.summary}). Local diagnostics are retained at .sandcastle/jobs/implementation-${diagnostic.jobId}. Remove agent:blocked, restore agent:implement, then retry.`,
      ], options.environment);
    },
    async readPullRequest(pullRequestNumber) {
      const { stdout } = await execute("gh", [
        "pr", "view", String(pullRequestNumber), "--json",
        "number,state,isDraft,baseRepository,headRepository,headRefName,headRefOid,labels",
      ], options.environment);
      const pullRequest = JSON.parse(stdout) as {
        readonly number: number;
        readonly state: string;
        readonly isDraft: boolean;
        readonly baseRepository: { readonly nameWithOwner: string } | null;
        readonly headRepository: { readonly nameWithOwner: string } | null;
        readonly headRefName: string;
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
        headRefName: pullRequest.headRefName,
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
    async addFeedbackBlockedDiagnostic(pullRequestNumber, diagnostic) {
      await execute("gh", [
        "pr", "comment", String(pullRequestNumber), "--body",
        `Automation feedback implementation is blocked (${diagnostic.reason}; job ${diagnostic.jobId}; ${diagnostic.summary}). Local diagnostics are retained at .sandcastle/jobs/feedback-${diagnostic.jobId}. Remove agent:blocked, restore agent:implement, then retry.`,
      ], options.environment);
    },
    async addBlockedDiagnostic(pullRequestNumber, diagnostic) {
      await execute("gh", [
        "pr", "comment", String(pullRequestNumber), "--body",
        `Automation review is blocked (${diagnostic.reason}; job ${diagnostic.jobId}). Remove agent:blocked, restore agent:review, then retry.`,
      ], options.environment);
    },
    async publish(request) {
      const { stdout: headOutput } = await execute("gh", [
        "pr", "view", String(request.pullRequestNumber), "--json", "headRefOid", "--jq", ".headRefOid",
      ], options.environment);
      if (headOutput.trim() !== request.revision) {
        throw new Error("Pull Request head changed before review publication");
      }
      const { stdout } = await execute("gh", [
        "api", `repos/{owner}/{repo}/pulls/${request.pullRequestNumber}/files`, "--method", "GET", "--paginate",
      ], options.environment);
      const files = JSON.parse(stdout) as readonly PullRequestFile[];
      const comments = inlineComments(request.review, diffLocations(files));
      await execute("gh", [
        "api", `repos/{owner}/{repo}/pulls/${request.pullRequestNumber}/reviews`, "--method", "POST",
        "-f", `commit_id=${request.revision}`,
        "-f", `event=${reviewEvent(request.review)}`,
        "-f", `body=${reviewBody(request.review)}`,
        ...comments.flatMap((comment, index) => [
          "-f", `comments[${index}][path]=${comment.path}`,
          "-f", `comments[${index}][line]=${comment.line}`,
          "-f", `comments[${index}][side]=${comment.side}`,
          "-f", `comments[${index}][body]=${comment.body}`,
        ]),
      ], options.environment);
    },
  };
}
