import type { AuthorizedTargetOperationInvocation } from "./target-operation.ts";

export interface ManagedOperationInvocation {
  readonly operation?: AuthorizedTargetOperationInvocation["operation"];
  readonly revision: string;
  readonly jobId?: string;
  readonly acquired?: true;
  readonly pullRequest?: {
    readonly headSha: string;
    readonly headRefName: string;
    readonly baseRefName: string;
    readonly baseRepository: string;
    readonly headRepository: string;
  };
}

export function createManagedOperationGithub<TResult extends Record<string, unknown>>(
  github: TResult,
  operation: AuthorizedTargetOperationInvocation["operation"],
  number: number | undefined,
  invocation: ManagedOperationInvocation,
): TResult {
  if (operation === "architecture-review") {
    if (
      number !== undefined ||
      invocation.operation !== "architecture-review" ||
      invocation.acquired !== undefined ||
      invocation.pullRequest !== undefined
    ) {
      throw new Error("Scheduled architecture review invocation is invalid");
    }
    return { ...github, readBaseRevision: async () => invocation.revision } as TResult;
  }
  if (invocation.acquired !== true) return github;
  const trigger = operation === "split-prd"
    ? "agent:to-issues"
    : operation === "review"
      ? "agent:review"
      : operation === "update-branch"
        ? "agent:update-branch"
        : "agent:implement";
  let lifecycle: "before" | "acquiring" | "acquired" = "before";
  let blocked = false;
  const labelsFor = (labels: readonly string[]): readonly string[] => {
    const values = new Set(labels);
    values.delete("agent:in-progress");
    values.delete(trigger);
    values.delete("agent:blocked");
    if (lifecycle !== "acquired") values.add(trigger);
    if (lifecycle !== "before") values.add("agent:in-progress");
    if (blocked) values.add("agent:blocked");
    return [...values];
  };
  const base = github as Record<string, unknown>;
  const invoke = async (name: string, ...arguments_: readonly unknown[]): Promise<unknown> => {
    const method = base[name];
    if (typeof method !== "function") throw new Error(`Target operation GitHub method ${name} is unavailable`);
    return Reflect.apply(method, github, arguments_);
  };
  const readIssue = async (workItemNumber: number) => {
    const issue = await invoke("readIssue", workItemNumber) as Record<string, unknown>;
    return workItemNumber === number
      ? { ...issue, labels: labelsFor(issue.labels as readonly string[]), baseRevision: invocation.revision }
      : issue;
  };
  const readPrd = async (workItemNumber: number) => {
    const issue = await invoke("readPrd", workItemNumber) as Record<string, unknown>;
    return workItemNumber === number
      ? { ...issue, labels: labelsFor(issue.labels as readonly string[]), baseRevision: invocation.revision }
      : issue;
  };
  const readPullRequest = async (workItemNumber: number) => {
    const pullRequest = await invoke("readPullRequest", workItemNumber) as Record<string, unknown>;
    if (workItemNumber !== number) return pullRequest;
    const authorized = invocation.pullRequest;
    if (
      authorized === undefined ||
      (lifecycle !== "acquired" && pullRequest.headSha !== invocation.revision) ||
      pullRequest.headRefName !== authorized.headRefName ||
      pullRequest.baseRefName !== authorized.baseRefName ||
      pullRequest.baseRepository !== authorized.baseRepository ||
      pullRequest.headRepository !== authorized.headRepository
    ) {
      throw new Error(`Pull Request #${number} changed after acquisition`);
    }
    return { ...pullRequest, labels: labelsFor(pullRequest.labels as readonly string[]) };
  };
  const mutate = async (
    kind: "issue" | "pull-request",
    action: "add" | "remove",
    workItemNumber: number,
    label: string,
  ): Promise<void> => {
    if (workItemNumber === number && label === "agent:in-progress") {
      if (action === "add") lifecycle = "acquiring";
      return;
    }
    if (workItemNumber === number && label === trigger && action === "remove") {
      lifecycle = "acquired";
      return;
    }
    if (workItemNumber === number && label === "agent:blocked") {
      blocked = action === "add";
      return;
    }
    const method = `${action}${kind === "issue" ? "Issue" : "PullRequest"}Label`;
    await invoke(method, workItemNumber, label);
  };
  return {
    ...github,
    readIssue,
    readPrd,
    readPullRequest,
    addIssueLabel: (workItemNumber: number, label: string) => mutate("issue", "add", workItemNumber, label),
    removeIssueLabel: (workItemNumber: number, label: string) => mutate("issue", "remove", workItemNumber, label),
    addPullRequestLabel: (workItemNumber: number, label: string) => mutate("pull-request", "add", workItemNumber, label),
    removePullRequestLabel: (workItemNumber: number, label: string) => mutate("pull-request", "remove", workItemNumber, label),
  } as TResult;
}
