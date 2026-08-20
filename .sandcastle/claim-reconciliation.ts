export type KnownOrUnknown<T extends string> = T | "unknown";

export class ClaimIdentityError extends Error {
  constructor() {
    super("Invalid claim identity");
    this.name = "ClaimIdentityError";
  }
}

export interface ClaimReconciliationInput {
  readonly repository: string;
  readonly issueNumber: number;
  readonly branch: string;
  readonly comparisonBaseSha: string;
}

export interface ClaimIssueFact {
  readonly existence: "present" | "absent" | "unknown";
  readonly state: "open" | "closed" | "unknown";
  readonly eligible: boolean | "unknown";
}

export interface ClaimBranchFact {
  readonly state: "present" | "absent" | "unknown";
  readonly headSha?: string;
}

export interface ClaimPullRequestFact {
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly headSha: string;
  readonly closesIssue: boolean;
}

export interface ClaimReconciliationGithubPort {
  getIssue(input: ClaimReconciliationInput): Promise<ClaimIssueFact>;
  getBranch(input: ClaimReconciliationInput): Promise<ClaimBranchFact>;
  listPullRequests(input: ClaimReconciliationInput): Promise<readonly ClaimPullRequestFact[]>;
}

export interface ClaimReconciliationGitPort {
  compareCommits(input: ClaimReconciliationInput & {
    readonly branchHeadSha: string;
  }): Promise<"equal" | "ahead" | "behind" | "diverged" | "unknown">;
  countUniqueCommits(input: ClaimReconciliationInput & {
    readonly branchHeadSha: string;
  }): Promise<number | "unknown">;
  getWorktree(input: ClaimReconciliationInput): Promise<"absent" | "clean" | "dirty" | "unknown">;
}

export interface ClaimReconciliationDockerPort {
  getContainer(input: ClaimReconciliationInput): Promise<"absent" | "present" | "active" | "unknown">;
}

export interface ClaimReconciliationPorts {
  readonly github: ClaimReconciliationGithubPort;
  readonly git: ClaimReconciliationGitPort;
  readonly docker: ClaimReconciliationDockerPort;
}

export type ClaimClassification =
  | "no-claim"
  | "delivery-complete"
  | "active-or-preserved-work"
  | "empty-candidate"
  | "inconsistent"
  | "unknown";

export type ClaimRecommendedAction =
  | "no-action"
  | "release-empty-claim"
  | "preserve"
  | "manual-review";

export interface ClaimReconciliationSnapshot extends ClaimReconciliationInput {
  readonly issue: {
    readonly existence: ClaimIssueFact["existence"];
    readonly state: ClaimIssueFact["state"];
    readonly eligibility: "eligible" | "ineligible" | "unknown";
  };
  readonly claimBranch: ClaimBranchFact;
  readonly branchRelation: "equal" | "ahead" | "behind" | "diverged" | "unknown";
  readonly uniqueCommits:
    | { readonly state: "zero"; readonly count: 0 }
    | { readonly state: "positive"; readonly count: number }
    | { readonly state: "unknown" };
  readonly pullRequests: {
    readonly state: "none" | "open" | "closed" | "merged" | "multiple" | "unknown";
    readonly count: number | "unknown";
    readonly items: readonly ClaimPullRequestFact[];
  };
  readonly worktree: "absent" | "clean" | "dirty" | "unknown";
  readonly container: "absent" | "present" | "active" | "unknown";
  readonly inconsistent: boolean;
  readonly classification: ClaimClassification;
  readonly recommendedAction: ClaimRecommendedAction;
}

async function known<T>(promise: Promise<T>, unknown: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return unknown;
  }
}

function pullRequestSnapshot(
  pullRequests: readonly ClaimPullRequestFact[] | "unknown",
): ClaimReconciliationSnapshot["pullRequests"] {
  if (pullRequests === "unknown") {
    return { state: "unknown", count: "unknown", items: [] };
  }
  if (pullRequests.length === 0) return { state: "none", count: 0, items: [] };
  if (pullRequests.length > 1) {
    return { state: "multiple", count: pullRequests.length, items: pullRequests };
  }
  return {
    state: pullRequests[0]!.state,
    count: 1,
    items: pullRequests,
  };
}

function uniqueCommitSnapshot(
  count: number | "unknown",
): ClaimReconciliationSnapshot["uniqueCommits"] {
  if (count === "unknown" || !Number.isSafeInteger(count) || count < 0) {
    return { state: "unknown" };
  }
  return count === 0
    ? { state: "zero", count: 0 }
    : { state: "positive", count };
}

function hasUnknown(snapshot: Omit<ClaimReconciliationSnapshot, "classification" | "recommendedAction">): boolean {
  return snapshot.issue.existence === "unknown" ||
    snapshot.issue.state === "unknown" ||
    snapshot.issue.eligibility === "unknown" ||
    snapshot.claimBranch.state === "unknown" ||
    (snapshot.claimBranch.state === "present" && snapshot.branchRelation === "unknown") ||
    (snapshot.claimBranch.state === "present" && snapshot.uniqueCommits.state === "unknown") ||
    snapshot.pullRequests.state === "unknown" ||
    snapshot.worktree === "unknown" ||
    snapshot.container === "unknown";
}

function isInconsistent(snapshot: Omit<ClaimReconciliationSnapshot, "inconsistent" | "classification" | "recommendedAction">): boolean {
  const { claimBranch, branchRelation, uniqueCommits, pullRequests, worktree, container } = snapshot;
  if (pullRequests.state === "multiple") return true;
  if (claimBranch.state === "absent") {
    if (worktree !== "absent") return true;
    if (pullRequests.state === "open") return true;
  }
  if (claimBranch.state === "present") {
    if (claimBranch.headSha === undefined) return true;
    if (branchRelation === "equal" && uniqueCommits.state === "positive") return true;
    if ((branchRelation === "ahead" || branchRelation === "diverged") && uniqueCommits.state === "zero") return true;
    if (branchRelation === "behind" && uniqueCommits.state === "positive") return true;
  }
  if (pullRequests.state === "merged") {
    return branchRelation === "ahead" || branchRelation === "diverged" ||
      uniqueCommits.state === "positive" || worktree === "dirty" || container === "active";
  }
  return false;
}

function classify(
  snapshot: Omit<ClaimReconciliationSnapshot, "classification" | "recommendedAction">,
): Pick<ClaimReconciliationSnapshot, "classification" | "recommendedAction"> {
  if (snapshot.pullRequests.items.some((pullRequest) => pullRequest.state === "merged")) {
    return { classification: "delivery-complete", recommendedAction: "no-action" };
  }
  if (snapshot.inconsistent) {
    return { classification: "inconsistent", recommendedAction: "manual-review" };
  }
  if (
    snapshot.issue.existence !== "unknown" &&
    snapshot.claimBranch.state === "absent" &&
    snapshot.pullRequests.state === "none" &&
    snapshot.worktree === "absent" &&
    snapshot.container === "absent"
  ) {
    return { classification: "no-claim", recommendedAction: "no-action" };
  }
  if (hasUnknown(snapshot)) {
    return { classification: "unknown", recommendedAction: "manual-review" };
  }
  if (
    snapshot.claimBranch.state === "present" &&
    snapshot.branchRelation === "equal" &&
    snapshot.uniqueCommits.state === "zero" &&
    snapshot.pullRequests.state === "none" &&
    (snapshot.worktree === "absent" || snapshot.worktree === "clean") &&
    snapshot.container !== "active"
  ) {
    return { classification: "empty-candidate", recommendedAction: "release-empty-claim" };
  }
  return { classification: "active-or-preserved-work", recommendedAction: "preserve" };
}

export async function reconcileClaim(
  input: ClaimReconciliationInput,
  ports: ClaimReconciliationPorts,
): Promise<ClaimReconciliationSnapshot> {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository) ||
    !Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0 ||
    input.branch !== `sandcastle/issue-${input.issueNumber}` ||
    !/^[0-9a-f]{40}$/u.test(input.comparisonBaseSha)
  ) {
    throw new ClaimIdentityError();
  }
  const [issue, branch, pullRequests, worktree, container] = await Promise.all([
    known(ports.github.getIssue(input), {
      existence: "unknown",
      state: "unknown",
      eligible: "unknown",
    } as const),
    known(ports.github.getBranch(input), { state: "unknown" } as const),
    known<readonly ClaimPullRequestFact[] | "unknown">(
      ports.github.listPullRequests(input),
      "unknown",
    ),
    known(ports.git.getWorktree(input), "unknown" as const),
    known(ports.docker.getContainer(input), "unknown" as const),
  ]);

  const commitInput = branch.state === "present" && branch.headSha !== undefined
    ? { ...input, branchHeadSha: branch.headSha }
    : null;
  const [relation, uniqueCommitCount] = commitInput === null
    ? ["unknown" as const, "unknown" as const]
    : await Promise.all([
      known(ports.git.compareCommits(commitInput), "unknown" as const),
      known(ports.git.countUniqueCommits(commitInput), "unknown" as const),
    ]);

  const facts = {
    ...input,
    issue: {
      existence: issue.existence,
      state: issue.state,
      eligibility: issue.eligible === "unknown"
        ? "unknown" as const
        : issue.eligible ? "eligible" as const : "ineligible" as const,
    },
    claimBranch: branch,
    branchRelation: relation,
    uniqueCommits: uniqueCommitSnapshot(uniqueCommitCount),
    pullRequests: pullRequestSnapshot(pullRequests),
    worktree,
    container,
  };
  const inconsistent = isInconsistent(facts);
  const classifiedFacts = { ...facts, inconsistent };
  return { ...classifiedFacts, ...classify(classifiedFacts) };
}
