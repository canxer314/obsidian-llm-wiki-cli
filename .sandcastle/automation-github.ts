import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ARCHITECTURE_REVIEW_BACKLOG_LIMIT,
  type ArchitectureReviewAutomationPorts,
  type ArchitectureReviewProposal,
} from "./architecture-review-automation.ts";
import type { BranchUpdateAutomationPorts } from "./branch-update-automation.ts";
import type { FeedbackImplementationPorts } from "./feedback-implementation-automation.ts";
import type { ImplementationAutomationPorts } from "./implementation-automation.ts";
import type { PrdImplementationAutomationPorts } from "./prd-implementation-automation.ts";
import type { PrdSplitAutomationPorts } from "./prd-split-automation.ts";
import type { PrdSlice } from "./prd-split-extraction.ts";
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

function splitBody(prdNumber: number, slice: PrdSlice): string {
  return `## Parent PRD\n\n#${prdNumber}\n\n## What to build\n\n${slice.whatToBuild}\n\n## Acceptance criteria\n\n${slice.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`).join("\n")}\n`;
}

export function createAutomationDispatchGithubPort(options: {
  readonly execute?: Execute;
  readonly environment?: Readonly<Record<string, string>>;
}): {
  listCommands(): Promise<readonly import("./automation-command.ts").AutomationCommand[]>;
  verifyLabels(): Promise<void>;
  ensureLabels(): Promise<void>;
} {
  const execute = options.execute ?? (async (file, arguments_, environment) => {
    const result = await executeFile(file, [...arguments_], { env: environment });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  return {
    async verifyLabels() {
      const { stdout } = await execute("gh", ["label", "list", "--limit", "100", "--json", "name"], options.environment);
      const existing = new Set((JSON.parse(stdout) as readonly { readonly name: string }[]).map(({ name }) => name));
      for (const name of ["agent:update-branch", "agent:implement", "agent:review", "agent:in-progress", "agent:blocked"]) {
        if (!existing.has(name)) throw new Error(`Missing required Automation Command label: ${name}`);
      }
    },
    async ensureLabels() {
      const { stdout } = await execute("gh", ["label", "list", "--limit", "100", "--json", "name"], options.environment);
      const existing = new Set((JSON.parse(stdout) as readonly { readonly name: string }[]).map(({ name }) => name));
      await Promise.all(["agent:update-branch", "agent:implement", "agent:review", "agent:in-progress", "agent:blocked"]
        .filter((name) => !existing.has(name))
        .map((name) => execute("gh", ["label", "create", name, "--color", "0E8A16"], options.environment)));
    },
    async listCommands() {
      const responses = await Promise.all(["agent:update-branch", "agent:implement", "agent:review", "agent:in-progress", "agent:blocked"].map((label) => execute(
        "gh", ["pr", "list", "--state", "open", "--label", label, "--json", "number,labels", "--limit", "100"], options.environment,
      )));
      const pullRequests = new Map<number, { readonly number: number; readonly labels: readonly { readonly name: string }[] }>();
      for (const response of responses) {
        for (const pullRequest of JSON.parse(response.stdout) as readonly { readonly number: number; readonly labels: readonly { readonly name: string }[] }[]) {
          pullRequests.set(pullRequest.number, pullRequest);
        }
      }
      return [...pullRequests.values()].flatMap((pullRequest) => {
        const labels = pullRequest.labels.map(({ name }) => name);
        return (["update-branch", "implement", "review"] as const)
          .filter((operation) => labels.includes(`agent:${operation}`))
          .map((operation) => ({
            number: pullRequest.number,
            operation,
            identity: `pull-request:${pullRequest.number}`,
            labels,
          }));
      });
    },
  };
}

export function createAutomationGithubPort(options: {
  readonly execute?: Execute;
  readonly environment?: Readonly<Record<string, string>>;
}): ReviewAutomationPorts["github"] & ReviewAutomationPorts["publisher"] & ImplementationAutomationPorts["github"] & FeedbackImplementationPorts["github"] & BranchUpdateAutomationPorts["github"] & PrdSplitAutomationPorts["github"] & PrdSplitAutomationPorts["publisher"] & PrdImplementationAutomationPorts["github"] & PrdImplementationAutomationPorts["pullRequests"] & ArchitectureReviewAutomationPorts["github"] & ArchitectureReviewAutomationPorts["publisher"] {
  const execute = options.execute ?? (async (file, arguments_, environment) => {
    const result = await executeFile(file, [...arguments_], { env: environment });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  const readHeadSha = async () => {
    const { stdout } = await execute("gh", [
      "api", "repos/{owner}/{repo}/commits/HEAD", "--jq", ".sha",
    ], options.environment);
    return stdout.trim();
  };
  return {
    async countOpenArchitectureReviewProposals() {
      // The count only needs to saturate at the refusal threshold, so the
      // query limit is the backlog limit itself (as in the upstream guard).
      const { stdout } = await execute("gh", [
        "issue", "list", "--state", "open", "--label", "source:architecture-review",
        "--limit", String(ARCHITECTURE_REVIEW_BACKLOG_LIMIT), "--json", "number", "--jq", "length",
      ], options.environment);
      return Number(stdout.trim());
    },
    async listArchitectureReviewProposals() {
      // The upstream skill reads up to 200 prior proposals for the
      // loose-duplicate filter.
      const { stdout } = await execute("gh", [
        "issue", "list", "--state", "all", "--label", "source:architecture-review",
        "--limit", "200", "--json", "number,title,state,body",
      ], options.environment);
      return JSON.parse(stdout) as ArchitectureReviewProposal[];
    },
    async readBaseRevision() {
      return readHeadSha();
    },
    async publishArchitectureProposal(request) {
      // Idempotent provenance-label creation, as in the upstream publish step.
      await execute("gh", [
        "label", "create", "source:architecture-review", "--color", "5319E7",
        "--description", "PRDs proposed by the automated architecture-review workflow",
      ], options.environment).catch(() => undefined);
      const { stdout } = await execute("gh", [
        "issue", "create", "--title", request.title, "--body", request.body,
        "--label", "source:architecture-review",
      ], options.environment);
      const issueUrl = stdout.trim().split("\n").at(-1) ?? "";
      const match = /\/issues\/(\d+)\s*$/u.exec(issueUrl);
      if (match === null) throw new Error("Could not parse created architecture-review Issue number");
      return { issueNumber: Number(match[1]), issueUrl };
    },
    async readIssue(issueNumber) {
      const [{ stdout: issueOutput }, baseRevision] = await Promise.all([
        execute("gh", [
          "api", `repos/{owner}/{repo}/issues/${issueNumber}`,
          "--jq", "{number, state, labels, pull_request}",
        ], options.environment),
        readHeadSha(),
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
        state: issue.state.toUpperCase(),
        labels: issue.labels.map(({ name }) => name),
        baseRevision,
      };
    },
    async readPrd(issueNumber) {
      const [{ stdout: issueOutput }, baseRevision, { stdout: subIssuesOutput }, { stdout: parentOutput }] = await Promise.all([
        execute("gh", [
          "api", `repos/{owner}/{repo}/issues/${issueNumber}`,
          "--jq", "{number, title, state, labels, pull_request}",
        ], options.environment),
        readHeadSha(),
        execute("gh", ["api", `repos/{owner}/{repo}/issues/${issueNumber}/sub_issues`, "--jq", "length"], options.environment),
        execute("gh", [
          "api", "graphql", "-f",
          "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){parent{number}}}}",
          "-f", "owner={owner}", "-f", "repo={repo}", "-F", `number=${issueNumber}`, "--jq", ".data.repository.issue.parent.number // empty",
        ], options.environment),
      ]);
      const issue = JSON.parse(issueOutput) as {
        readonly number: number;
        readonly title: string;
        readonly state: string;
        readonly labels: readonly { readonly name: string }[];
        readonly pull_request?: unknown;
      };
      if (issue.pull_request !== undefined && issue.pull_request !== null) {
        throw new Error(`Automation work item #${issueNumber} is a Pull Request`);
      }
      const parentNumber = parentOutput.trim();
      return {
        number: issue.number,
        title: issue.title,
        state: issue.state.toUpperCase(),
        labels: issue.labels.map(({ name }) => name),
        baseRevision,
        subIssueCount: Number(subIssuesOutput.trim()),
        ...(parentNumber.length === 0 ? {} : { parentNumber: Number(parentNumber) }),
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
    async addSplitBlockedDiagnostic(issueNumber, diagnostic) {
      await execute("gh", [
        "issue", "comment", String(issueNumber), "--body",
        `Automation PRD splitting is blocked (job ${diagnostic.jobId}). Remove agent:blocked, restore agent:to-issues, then retry.`,
      ], options.environment);
    },
    async listChildren(prdNumber) {
      const { stdout } = await execute("gh", [
        "api", `repos/{owner}/{repo}/issues/${prdNumber}/sub_issues`, "--paginate",
        "--jq", ".[] | {number, title, state}",
      ], options.environment);
      const children = stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { readonly number: number; readonly title: string; readonly state: string });
      return Promise.all(children.map(async (childIssue) => {
        const { stdout: detailOutput } = await execute("gh", [
          "api", `repos/{owner}/{repo}/issues/${childIssue.number}`,
          "--jq", "{blockedBy: (.issue_dependencies_summary.blocked_by // 0), subIssues: (.sub_issues_summary.total // 0)}",
        ], options.environment);
        const detail = JSON.parse(detailOutput) as { readonly blockedBy: number; readonly subIssues: number };
        return {
          number: childIssue.number,
          title: childIssue.title,
          state: childIssue.state.toUpperCase(),
          openBlockerCount: detail.blockedBy,
          subIssueCount: detail.subIssues,
        };
      }));
    },
    async closeImplementedChild(request) {
      await execute("gh", [
        "issue", "close", String(request.childNumber), "--comment",
        `Implemented in ${request.revision}. Part of #${request.prdNumber}.`,
      ], options.environment);
    },
    async addPrdImplementationBlockedDiagnostic(issueNumber, diagnostic) {
      await execute("gh", [
        "issue", "comment", String(issueNumber), "--body",
        `Automation PRD implementation is blocked (${diagnostic.reason}; job ${diagnostic.jobId}; ${diagnostic.summary}) while implementing sub-issue #${diagnostic.childNumber}. Local diagnostics are retained at .sandcastle/jobs/prd-implementation-${diagnostic.jobId}. Remove agent:blocked, restore agent:implement, then retry.`,
      ], options.environment);
    },
    async addChildFailureDiagnostic(childNumber, diagnostic) {
      await execute("gh", [
        "issue", "comment", String(childNumber), "--body",
        `Implementation attempt failed (job ${diagnostic.jobId}). See PRD #${diagnostic.prdNumber} for status.`,
      ], options.environment);
    },
    async ensurePrdDraftPullRequest(request) {
      const [{ stdout: repositoryOutput }, { stdout: pullRequestsOutput }] = await Promise.all([
        execute("gh", ["repo", "view", "--json", "defaultBranchRef"], options.environment),
        execute("gh", [
          "pr", "list", "--head", request.branch, "--state", "open",
          "--json", "number,url,isDraft,baseRefName,headRefName,headRefOid", "--limit", "2",
        ], options.environment),
      ]);
      const repository = JSON.parse(repositoryOutput) as {
        readonly defaultBranchRef: { readonly name: string };
      };
      const pullRequests = JSON.parse(pullRequestsOutput) as readonly {
        readonly number: number;
        readonly url: string;
        readonly isDraft: boolean;
        readonly baseRefName: string;
        readonly headRefName: string;
        readonly headRefOid: string;
      }[];
      if (pullRequests.length > 1) {
        throw new Error(`Expected at most one open Pull Request for ${request.branch}; found ${pullRequests.length}`);
      }
      const existing = pullRequests[0];
      if (existing !== undefined) {
        if (
          !existing.isDraft ||
          existing.baseRefName !== repository.defaultBranchRef.name ||
          existing.headRefName !== request.branch
        ) {
          throw new Error(`Existing Pull Request for ${request.branch} is not an upstream-equivalent Draft`);
        }
        if (existing.headRefOid !== request.headSha) {
          throw new Error(`Pull Request #${existing.number} head does not match the Implementer commit`);
        }
        return { number: existing.number, url: existing.url };
      }
      const { stdout: createOutput } = await execute("gh", [
        "pr", "create", "--draft", "--head", request.branch,
        "--title", `Implement #${request.prdNumber}`,
        "--body", `Part of #${request.prdNumber}`,
      ], options.environment);
      const url = createOutput.trim();
      const match = /\/pull\/(\d+)$/u.exec(url);
      if (match === null) throw new Error("Could not parse created Pull Request number");
      const number = Number(match[1]);
      const { stdout: headOutput } = await execute("gh", [
        "pr", "view", String(number), "--json", "headRefOid", "--jq", ".headRefOid",
      ], options.environment);
      if (headOutput.trim() !== request.headSha) {
        throw new Error("Pull Request head changed before Pull Request publication");
      }
      return { number, url };
    },
    async publishPrdSplit(request) {
      const created: number[] = [];
      let previousIssueId: string | undefined;
      for (const slice of request.slices) {
        const { stdout: createOutput } = await execute("gh", [
          "issue", "create", "--title", slice.title, "--body", splitBody(request.prdNumber, slice),
        ], options.environment);
        const match = /\/issues\/(\d+)\s*$/u.exec(createOutput);
        if (match === null) throw new Error("Could not parse created child Issue number");
        const childIssueNumber = Number(match[1]);
        created.push(childIssueNumber);
        const { stdout: childIssueIdOutput } = await execute("gh", [
          "api", `repos/{owner}/{repo}/issues/${childIssueNumber}`, "--jq", ".id",
        ], options.environment);
        const childIssueId = childIssueIdOutput.trim();
        await execute("gh", [
          "api", "-X", "POST", `repos/{owner}/{repo}/issues/${request.prdNumber}/sub_issues`,
          "-F", `sub_issue_id=${childIssueId}`,
        ], options.environment);
        if (previousIssueId !== undefined) {
          await execute("gh", [
            "api", "-X", "POST", `repos/{owner}/{repo}/issues/${childIssueNumber}/dependencies/blocked_by`,
            "-F", `issue_id=${previousIssueId}`,
          ], options.environment);
        }
        previousIssueId = childIssueId;
      }
      return created;
    },
    async readPullRequest(pullRequestNumber) {
      const { stdout } = await execute("gh", [
        "pr", "view", String(pullRequestNumber), "--json",
        "number,state,isDraft,baseRepository,headRepository,baseRefName,headRefName,headRefOid,labels",
      ], options.environment);
      const pullRequest = JSON.parse(stdout) as {
        readonly number: number;
        readonly state: string;
        readonly isDraft: boolean;
        readonly baseRepository: { readonly nameWithOwner: string } | null;
        readonly headRepository: { readonly nameWithOwner: string } | null;
        readonly baseRefName: string;
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
        baseRefName: pullRequest.baseRefName,
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
    async addBranchUpdateBlockedDiagnostic(pullRequestNumber, diagnostic) {
      await execute("gh", [
        "pr", "comment", String(pullRequestNumber), "--body",
        `Automation branch update is blocked (${diagnostic.reason}; job ${diagnostic.jobId}; ${diagnostic.summary}). Local diagnostics are retained at .sandcastle/jobs/branch-update-${diagnostic.jobId}. Remove agent:blocked, restore agent:update-branch, then retry.`,
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
