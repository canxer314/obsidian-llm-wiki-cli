import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  canonicalAutomationTriggerLabels,
  commandRoutesForReceiver,
  resolveAutomationCommandRoute,
} from "./automation-command-route.ts";
import {
  ARCHITECTURE_REVIEW_BACKLOG_LIMIT,
  type ArchitectureReviewAutomationPorts,
  type ArchitectureReviewProposal,
} from "./architecture-review-automation.ts";
import type { BranchUpdateAutomationPorts } from "./branch-update-automation.ts";
import type { FeedbackImplementationResources } from "./feedback-implementation-automation.ts";
import type { FeedbackThreadReply, FeedbackReviewState } from "./feedback-reconciliation.ts";
import type { ImplementationAutomationPorts } from "./implementation-automation.ts";
import type { PrdImplementationAutomationPorts } from "./prd-implementation-automation.ts";
import type { PrdSplitAutomationPorts } from "./prd-split-automation.ts";
import type { PrdSlice } from "./prd-split-extraction.ts";
import type { QueuePromotionPorts } from "./queue-promotion-automation.ts";
import type {
  PublishedReview,
  ReviewAutomationPorts,
} from "./review-automation.ts";

const executeFile = promisify(execFile);

type Execute = (
  file: string,
  arguments_: readonly string[],
  environment?: Readonly<Record<string, string>>,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

function missingLabel(error: unknown): boolean {
  const details = [
    error instanceof Error ? error.message : "",
    typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "",
  ].join("\n");
  return /label does not exist/iu.test(details) && /\bHTTP 404\b/iu.test(details);
}

function createLabelMutations(
  execute: Execute,
  environment?: Readonly<Record<string, string>>,
) {
  return {
    async add(workItemNumber: number, label: string): Promise<void> {
      await execute("gh", [
        "api", "--method", "POST", `repos/{owner}/{repo}/issues/${workItemNumber}/labels`,
        "-f", `labels[]=${label}`,
      ], environment);
    },
    async remove(workItemNumber: number, label: string): Promise<void> {
      try {
        await execute("gh", [
          "api", "--method", "DELETE",
          `repos/{owner}/{repo}/issues/${workItemNumber}/labels/${encodeURIComponent(label)}`,
        ], environment);
      } catch (error) {
        if (!missingLabel(error)) throw error;
      }
    },
  };
}

function reviewBody(review: PublishedReview): string {
  return review.summary;
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
  return review.inlineComments.flatMap((comment) => {
    const { path, line, body } = comment;
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      body.length === 0
    ) {
      throw new Error("Review inline comment location is invalid");
    }
    return locations.get(path)?.RIGHT.has(line) === true
      ? [{ path, line, side: "RIGHT", body }]
      : [];
  });
}

function splitBody(prdNumber: number, slice: PrdSlice): string {
  return `## Parent PRD\n\n#${prdNumber}\n\n## What to build\n\n${slice.whatToBuild}\n\n## Acceptance criteria\n\n${slice.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`).join("\n")}\n`;
}

const lifecycleLabels = ["agent:in-progress", "agent:blocked"] as const;
const queueOnlyLabels = ["agent:queued"] as const;
const automationLabels = [
  ...canonicalAutomationTriggerLabels(),
  ...lifecycleLabels,
  ...queueOnlyLabels,
] as const;

interface ListedWorkItem {
  readonly number: number;
  readonly labels: readonly { readonly name: string }[];
}

interface IssueCommandShape {
  readonly parent: { readonly number: number } | null;
  readonly subIssues: { readonly totalCount: number };
}

export function createAutomationDispatchGithubPort(options: {
  readonly execute?: Execute;
  readonly environment?: Readonly<Record<string, string>>;
}): QueuePromotionPorts["github"] & {
  listCommands(): Promise<readonly import("./automation-command.ts").AutomationCommand[]>;
  verifyLabels(): Promise<void>;
  ensureLabels(): Promise<void>;
} {
  const execute = options.execute ?? (async (file, arguments_, environment) => {
    const result = await executeFile(file, [...arguments_], { env: environment });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  const labels = createLabelMutations(execute, options.environment);
  const listOpenByLabel = async (kind: "pr" | "issue", label: string): Promise<readonly ListedWorkItem[]> => {
    const { stdout } = await execute(
      "gh", [kind, "list", "--state", "open", "--label", label, "--json", "number,labels", "--limit", "100"], options.environment,
    );
    return JSON.parse(stdout) as readonly ListedWorkItem[];
  };
  const readIssueShape = async (issueNumber: number): Promise<IssueCommandShape> => {
    const { stdout } = await execute("gh", [
      "api", "graphql", "-f",
      "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){parent{number} subIssues(first:1){totalCount}}}}",
      "-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${issueNumber}`,
      "--jq", ".data.repository.issue",
    ], options.environment);
    const shape = JSON.parse(stdout) as IssueCommandShape | null;
    if (shape === null) throw new Error(`Issue #${issueNumber} shape is unreadable`);
    return shape;
  };
  return {
    async verifyLabels() {
      const { stdout } = await execute("gh", ["label", "list", "--limit", "100", "--json", "name"], options.environment);
      const existing = new Set((JSON.parse(stdout) as readonly { readonly name: string }[]).map(({ name }) => name));
      for (const name of automationLabels) {
        if (!existing.has(name)) throw new Error(`Missing required Automation Command label: ${name}`);
      }
    },
    async ensureLabels() {
      const { stdout } = await execute("gh", ["label", "list", "--limit", "100", "--json", "name"], options.environment);
      const existing = new Set((JSON.parse(stdout) as readonly { readonly name: string }[]).map(({ name }) => name));
      await Promise.all(automationLabels
        .filter((name) => !existing.has(name))
        .map((name) => execute("gh", ["label", "create", name, "--color", "0E8A16"], options.environment)));
    },
    async listQueuedIssues() {
      const { stdout } = await execute(
        "gh", ["issue", "list", "--state", "open", "--label", "agent:queued", "--json", "number,labels", "--limit", "100"], options.environment,
      );
      return (JSON.parse(stdout) as readonly { readonly number: number; readonly labels: readonly { readonly name: string }[] }[])
        .map((issue) => ({ number: issue.number, labels: issue.labels.map(({ name }) => name) }));
    },
    async readPromotionState(issueNumber) {
      const { stdout } = await execute("gh", [
        "api", "graphql", "-f",
        "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){labels(first:50){nodes{name} pageInfo{hasNextPage}} parent{number} blockedBy(first:100){nodes{number state} pageInfo{hasNextPage}}}}}",
        "-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${issueNumber}`,
        "--jq", ".data.repository.issue",
      ], options.environment);
      const issue = JSON.parse(stdout) as {
        readonly labels: { readonly nodes: readonly { readonly name: string }[]; readonly pageInfo: { readonly hasNextPage: boolean } };
        readonly parent: { readonly number: number } | null;
        readonly blockedBy: { readonly nodes: readonly { readonly number: number; readonly state: string }[]; readonly pageInfo: { readonly hasNextPage: boolean } };
      } | null;
      if (issue === null || issue.labels.pageInfo.hasNextPage || issue.blockedBy.pageInfo.hasNextPage) {
        throw new Error(`Issue #${issueNumber} dependency state is unreadable`);
      }
      return {
        labels: issue.labels.nodes.map(({ name }) => name),
        ...(issue.parent === null ? {} : { parentNumber: issue.parent.number }),
        blockers: issue.blockedBy.nodes.map(({ number, state }) => ({ number, state })),
      };
    },
    async addIssueLabel(issueNumber, label) {
      await labels.add(issueNumber, label);
    },
    async removeIssueLabel(issueNumber, label) {
      await labels.remove(issueNumber, label);
    },
    async addPromotionDiagnostic(issueNumber) {
      await execute("gh", [
        "issue", "comment", String(issueNumber), "--body",
        "All blockers are closed — promoting from `agent:queued` to `agent:implement`.",
      ], options.environment);
    },
    async addPromotionBlockedDiagnostic(issueNumber, diagnostic) {
      await execute("gh", [
        "issue", "comment", String(issueNumber), "--body",
        `Queue promotion is blocked (job ${diagnostic.jobId}): ${diagnostic.summary}`,
      ], options.environment);
    },
    async addSubIssueRefusalDiagnostic(issueNumber, parentNumber) {
      await execute("gh", [
        "issue", "comment", String(issueNumber), "--body",
        `Refused to promote: this is a sub-issue of #${parentNumber}. \`agent:queued\` is not meaningful on sub-issues — label the parent PRD instead. Cleared \`agent:queued\`.`,
      ], options.environment);
    },
    async listCommands() {
      const pullRequestCommandLabels = [
        ...new Set([
          ...commandRoutesForReceiver("pull-request", 1).map((route) => route.trigger),
          ...lifecycleLabels,
        ]),
      ];
      const issueCommandLabels = [
        ...new Set([
          ...commandRoutesForReceiver("issue", 1).map((route) => route.trigger),
          ...lifecycleLabels,
        ]),
      ];
      const responses = await Promise.all([
        ...pullRequestCommandLabels.map((label) => listOpenByLabel("pr", label)),
        ...issueCommandLabels.map((label) => listOpenByLabel("issue", label)),
      ]);
      const pullRequests = new Map<number, ListedWorkItem>();
      for (const response of responses.slice(0, pullRequestCommandLabels.length)) {
        for (const pullRequest of response) {
          pullRequests.set(pullRequest.number, pullRequest);
        }
      }
      const issues = new Map<number, ListedWorkItem>();
      for (const response of responses.slice(pullRequestCommandLabels.length)) {
        for (const issue of response) {
          issues.set(issue.number, issue);
        }
      }
      const pullRequestCommands = [...pullRequests.values()].flatMap((pullRequest) => {
        const labels = pullRequest.labels.map(({ name }) => name);
        const routes = commandRoutesForReceiver("pull-request", pullRequest.number)
          .filter((route) => labels.includes(route.trigger));
        // Progress labels outlive their trigger once acquisition begins. Keep a
        // single canonical PR command for inspection when no trigger remains;
        // its eligibility is necessarily non-runnable.
        const commands = routes.length > 0
          ? routes
          : labels.some((label) => label === "agent:in-progress" || label === "agent:blocked")
            ? [undefined]
            : [];
        return commands.map((route) => route === undefined
          ? {
              number: pullRequest.number,
              operation: "unknown" as const,
              identity: commandRoutesForReceiver("pull-request", pullRequest.number)[0]!.identity,
              labels,
            }
          : {
              number: route.number,
              operation: route.operation,
              identity: route.identity,
              labels,
            });
      });
      // Issue-side triggers are only meaningful on top-level Work Items, so
      // shape reads happen before routing: sub-issues are driven by their
      // parent PRD and never become dispatch commands themselves. State-only
      // Work Items are retained for read-only inspection, but remain
      // ineligible for dispatch.
      const relevantLabels = (labels: readonly string[]) =>
        labels.includes("agent:in-progress") ||
        labels.includes("agent:blocked") ||
        commandRoutesForReceiver("issue", 1).some((route) => labels.includes(route.trigger));
      const candidates = await Promise.all([...issues.values()]
        .filter((issue) => relevantLabels(issue.labels.map(({ name }) => name)))
        .sort((left, right) => left.number - right.number)
        .map(async (issue) => {
          const labels = issue.labels.map(({ name }) => name);
          const shape = await readIssueShape(issue.number);
          // A plain Issue that already has an open implementation Pull Request
          // is owned by the Pull Request command families, not by Issue
          // implementation.
          let hasOpenImplementationPullRequest = false;
          if (shape.parent === null && shape.subIssues.totalCount === 0 && labels.includes("agent:implement")) {
            const { stdout } = await execute(
              "gh", ["pr", "list", "--head", `sandcastle/issue-${issue.number}`, "--state", "open", "--json", "number", "--limit", "1"], options.environment,
            );
            hasOpenImplementationPullRequest = (JSON.parse(stdout) as readonly unknown[]).length > 0;
          }
          return { number: issue.number, labels, shape, hasOpenImplementationPullRequest };
        }));
      const issueCommands = candidates.flatMap((candidate) => {
        const { number, labels, shape } = candidate;
        if (shape.parent !== null) return [];
        const commands: import("./automation-command.ts").AutomationCommand[] = [];
        if (labels.includes("agent:implement")) {
          if (shape.subIssues.totalCount > 0) {
            const route = resolveAutomationCommandRoute("implement-prd", number);
            commands.push({ number, operation: route.operation, identity: route.identity, labels });
          } else if (!candidate.hasOpenImplementationPullRequest) {
            const route = resolveAutomationCommandRoute("implement-issue", number);
            commands.push({ number, operation: route.operation, identity: route.identity, labels });
          }
        }
        // When both triggers are present, only the higher-priority
        // implementation command runs (#219); the split trigger stays for a
        // later round so one Work Item never runs two operations at once.
        const splitRoute = resolveAutomationCommandRoute("split-prd", number);
        if (labels.includes(splitRoute.trigger) && !labels.includes("agent:implement")) {
          commands.push({ number, operation: splitRoute.operation, identity: splitRoute.identity, labels });
        }
        // A state-only Work Item has already consumed its trigger. Its
        // originating operation cannot be reconstructed safely, so preserve
        // only its Work Item identity for read-only inspection.
        if (commands.length === 0 && (labels.includes("agent:in-progress") || labels.includes("agent:blocked"))) {
          commands.push({
            number,
            operation: "unknown",
            identity: commandRoutesForReceiver("issue", number)
              .find((route) => route.operation === "implement-issue")!.identity,
            labels,
          });
        }
        return commands;
      });
      return [...pullRequestCommands, ...issueCommands];
    },
  };
}

export function createAutomationGithubPort(options: {
  readonly execute?: Execute;
  readonly environment?: Readonly<Record<string, string>>;
}): ReviewAutomationPorts["github"] & ImplementationAutomationPorts["github"] & FeedbackImplementationResources["github"] & BranchUpdateAutomationPorts["github"] & PrdSplitAutomationPorts["github"] & PrdSplitAutomationPorts["publisher"] & PrdImplementationAutomationPorts["github"] & PrdImplementationAutomationPorts["pullRequests"] & ArchitectureReviewAutomationPorts["github"] & ArchitectureReviewAutomationPorts["publisher"] {
  const execute = options.execute ?? (async (file, arguments_, environment) => {
    const result = await executeFile(file, [...arguments_], { env: environment });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  const labels = createLabelMutations(execute, options.environment);
  const readHeadSha = async () => {
    const { stdout } = await execute("gh", [
      "api", "repos/{owner}/{repo}/commits/HEAD", "--jq", ".sha",
    ], options.environment);
    return stdout.trim();
  };
  const readFeedbackThreadReplies = async (pullRequestNumber: number): Promise<{
    readonly threads: readonly {
      readonly isResolved: boolean;
      readonly rootCommentId: string;
      readonly replies: readonly FeedbackThreadReply[];
    }[];
  }> => {
    const { stdout } = await execute("gh", [
      "api", "graphql", "-f",
      "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved comments(first:100){pageInfo{hasNextPage} nodes{id replyTo{id} body createdAt}}}}}}}",
      "-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${pullRequestNumber}`,
      "--jq", ".data.repository.pullRequest.reviewThreads",
    ], options.environment);
    const reviewThreads = JSON.parse(stdout) as {
      readonly pageInfo: { readonly hasNextPage: boolean };
      readonly nodes: readonly {
        readonly isResolved: boolean;
        readonly comments: {
          readonly pageInfo: { readonly hasNextPage: boolean };
          readonly nodes: readonly {
            readonly id: string;
            readonly replyTo: { readonly id: string } | null;
            readonly body: string;
            readonly createdAt: string;
          }[];
        };
      }[];
    };
    if (reviewThreads.pageInfo.hasNextPage || reviewThreads.nodes.some(({ comments }) => comments.pageInfo.hasNextPage)) {
      throw new Error(`Pull Request #${pullRequestNumber} feedback evidence is truncated`);
    }
    return {
      threads: reviewThreads.nodes.map((thread) => {
        const comments = new Map(thread.comments.nodes.map((comment) => [comment.id, comment]));
        const roots = thread.comments.nodes.filter((comment) => comment.replyTo === null);
        if (roots.length !== 1) throw new Error(`Pull Request #${pullRequestNumber} feedback thread root is unreadable`);
        const root = roots[0]!;
        const rootOf = (comment: typeof root): string => {
          const visited = new Set<string>();
          let current = comment;
          while (current.replyTo !== null) {
            if (visited.has(current.id)) throw new Error(`Pull Request #${pullRequestNumber} feedback reply chain is cyclic`);
            visited.add(current.id);
            const parent = comments.get(current.replyTo.id);
            if (parent === undefined) throw new Error(`Pull Request #${pullRequestNumber} feedback reply chain is unreadable`);
            current = parent;
          }
          return current.id;
        };
        return {
          isResolved: thread.isResolved,
          rootCommentId: root.id,
          replies: thread.comments.nodes
            .filter((comment) => comment.id !== root.id)
            .map((comment) => {
              if (rootOf(comment) !== root.id) throw new Error(`Pull Request #${pullRequestNumber} feedback reply belongs to another root`);
              return { rootCommentId: root.id, replyCommentId: comment.id, body: comment.body, createdAt: comment.createdAt };
            })
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.replyCommentId.localeCompare(right.replyCommentId))
            .map(({ createdAt: _createdAt, ...reply }) => reply),
        };
      }),
    };
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
        execute("gh", [
          "api", `repos/{owner}/{repo}/issues/${issueNumber}/sub_issues`, "--paginate", "--jq", ".[] | 1",
        ], options.environment),
        execute("gh", [
          "api", "graphql", "-f",
          "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){parent{number}}}}",
          "-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${issueNumber}`, "--jq", ".data.repository.issue.parent.number // empty",
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
        subIssueCount: subIssuesOutput.split("\n").filter((line) => line.trim().length > 0).length,
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
      await labels.add(issueNumber, label);
    },
    async removeIssueLabel(issueNumber, label) {
      await labels.remove(issueNumber, label);
    },
    async addRefusalDiagnostic(issueNumber, reason) {
      // The issues comments endpoint carries both Issue and Pull Request
      // conversation comments, so one diagnostic port serves every
      // operation's business refusal (#219 story 17).
      await execute("gh", [
        "api", `repos/{owner}/{repo}/issues/${issueNumber}/comments`,
        "-f", `body=${reason}`,
      ], options.environment);
    },
    async addImplementationBlockedDiagnostic(issueNumber, diagnostic) {
      await execute("gh", [
        "issue", "comment", String(issueNumber), "--body",
        `Automation implementation is blocked (${diagnostic.reason}; job ${diagnostic.jobId}). Remove agent:blocked, restore agent:implement, then retry.`,
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
        `Automation PRD implementation is blocked (${diagnostic.reason}; job ${diagnostic.jobId}) while implementing sub-issue #${diagnostic.childNumber}. Remove agent:blocked, restore agent:implement, then retry.`,
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
        "api", `repos/{owner}/{repo}/pulls/${pullRequestNumber}`,
      ], options.environment);
      const pullRequest = JSON.parse(stdout) as {
        readonly number: number;
        readonly state: string;
        readonly draft: boolean;
        readonly base: {
          readonly ref: string;
          readonly repo: { readonly full_name: string } | null;
        };
        readonly head: {
          readonly ref: string;
          readonly sha: string;
          readonly repo: { readonly full_name: string } | null;
        };
        readonly labels: readonly { readonly name: string }[];
      };
      if (pullRequest.base.repo === null || pullRequest.head.repo === null) {
        throw new Error(`Pull Request #${pullRequestNumber} repository identity is unavailable`);
      }
      return {
        number: pullRequest.number,
        state: pullRequest.state.toUpperCase(),
        isDraft: pullRequest.draft,
        baseRepository: pullRequest.base.repo.full_name,
        headRepository: pullRequest.head.repo.full_name,
        baseRefName: pullRequest.base.ref,
        headRefName: pullRequest.head.ref,
        headSha: pullRequest.head.sha,
        labels: pullRequest.labels.map(({ name }) => name),
      };
    },
    async readUnresolvedReviewThreads(pullRequestNumber) {
      const { stdout } = await execute("gh", [
        "api", "graphql", "-f",
        "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved comments(first:100){pageInfo{hasNextPage} nodes{id path line originalLine body author{login}}}}}}}}",
        "-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${pullRequestNumber}`,
        "--jq", ".data.repository.pullRequest.reviewThreads",
      ], options.environment);
      const reviewThreads = JSON.parse(stdout) as {
        readonly pageInfo: { readonly hasNextPage: boolean };
        readonly nodes: readonly {
          readonly isResolved: boolean;
          readonly comments: {
            readonly pageInfo: { readonly hasNextPage: boolean };
            readonly nodes: readonly {
              readonly id: string;
              readonly path: string | null;
              readonly line: number | null;
              readonly originalLine: number | null;
              readonly body: string;
              readonly author: { readonly login: string } | null;
            }[];
          };
        }[];
      };
      if (reviewThreads.pageInfo.hasNextPage || reviewThreads.nodes.some(({ comments }) => comments.pageInfo.hasNextPage)) {
        throw new Error(`Pull Request #${pullRequestNumber} review thread evidence is truncated`);
      }
      return reviewThreads.nodes.filter(({ isResolved }) => !isResolved).flatMap(({ comments }) => comments.nodes.map((comment) => ({
        commentId: comment.id,
        ...(comment.path === null ? {} : { path: comment.path }),
        ...(comment.line === null && comment.originalLine === null ? {} : { line: comment.line ?? comment.originalLine! }),
        author: comment.author?.login ?? "unknown",
        body: comment.body,
      })));
    },
    async addPullRequestLabel(pullRequestNumber, label) {
      await labels.add(pullRequestNumber, label);
    },
    async removePullRequestLabel(pullRequestNumber, label) {
      await labels.remove(pullRequestNumber, label);
    },
    async addFeedbackBlockedDiagnostic(pullRequestNumber, diagnostic) {
      await execute("gh", [
        "pr", "comment", String(pullRequestNumber), "--body",
        `Automation feedback implementation is blocked (${diagnostic.reason}; job ${diagnostic.jobId}). Remove agent:blocked, restore agent:implement, then retry.`,
      ], options.environment);
    },
    async addBlockedDiagnostic(pullRequestNumber, diagnostic) {
      await execute("gh", [
        "pr", "comment", String(pullRequestNumber), "--body",
        `Automation review is blocked (${diagnostic.reason}; job ${diagnostic.jobId}). Remove agent:blocked, restore agent:review, then retry.`,
      ], options.environment);
    },
    async addBranchUpdateComment(pullRequestNumber, body) {
      await execute("gh", [
        "pr", "comment", String(pullRequestNumber), "--body", body,
      ], options.environment);
    },
    async addBranchUpdateBlockedDiagnostic(pullRequestNumber, diagnostic) {
      await execute("gh", [
        "pr", "comment", String(pullRequestNumber), "--body",
        `Automation branch update is blocked (${diagnostic.reason}; job ${diagnostic.jobId}). Remove agent:blocked, restore agent:update-branch, then retry.`,
      ], options.environment);
    },
    async publishReview(request) {
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
        "-f", "event=COMMENT",
        "-f", `body=${reviewBody(request.review)}`,
        ...comments.flatMap((comment, index) => [
          "-f", `comments[${index}][path]=${comment.path}`,
          "-f", `comments[${index}][line]=${comment.line}`,
          "-f", `comments[${index}][side]=${comment.side}`,
          "-f", `comments[${index}][body]=${comment.body}`,
        ]),
      ], options.environment);
    },
    async markPullRequestReady(pullRequestNumber) {
      await execute("gh", ["pr", "ready", String(pullRequestNumber)], options.environment);
    },
    async replyToReviewThread(request) {
      const { stdout } = await execute("gh", [
        "api", "graphql",
        "-f", "query=query($id:ID!){node(id:$id){... on PullRequestReviewComment{databaseId}}}",
        "-F", `id=${request.reply.commentId}`,
        "--jq", ".data.node.databaseId",
      ], options.environment);
      const commentId = stdout.trim();
      if (!/^\d+$/u.test(commentId)) return;
      await execute("gh", [
        "api", `repos/{owner}/{repo}/pulls/${request.pullRequestNumber}/comments/${commentId}/replies`,
        "--method", "POST", "-f", `body=${request.reply.body}`,
      ], options.environment);
    },
    async readCurrentUnresolvedFeedback(pullRequestNumber): Promise<FeedbackReviewState> {
      const all = await readFeedbackThreadReplies(pullRequestNumber);
      return {
        unresolvedRootCommentIds: all.threads.filter((thread) => !thread.isResolved).map((thread) => thread.rootCommentId),
        replies: all.threads.filter((thread) => !thread.isResolved).flatMap((thread) => thread.replies),
      };
    },
    async readFeedbackReplies(pullRequestNumber) {
      return (await readFeedbackThreadReplies(pullRequestNumber)).threads.flatMap((thread) => thread.replies);
    },
    async readCommitParent(sha) {
      const { stdout } = await execute("gh", [
        "api", `repos/{owner}/{repo}/commits/${sha}`, "--jq", ".parents[0].sha // empty",
      ], options.environment);
      const parent = stdout.trim();
      return parent.length === 0 ? undefined : parent;
    },
  };
}
