import { describe, expect, it, vi } from "vitest";

import {
  inspectClaim,
  renderClaimInspectionHuman,
  renderClaimInspectionJson,
} from "../.sandcastle/claim-inspector.js";
import type {
  ClaimReconciliationPorts,
  ClaimReconciliationSnapshot,
} from "../.sandcastle/claim-reconciliation.js";

const SHA = "a".repeat(40);

function snapshot(): ClaimReconciliationSnapshot {
  return {
    repository: "owner/repository",
    issueNumber: 206,
    branch: "sandcastle/issue-206",
    comparisonBaseSha: SHA,
    issue: { existence: "present", state: "open", eligibility: "eligible" },
    claimBranch: { state: "present", headSha: SHA },
    branchRelation: "equal",
    uniqueCommits: { state: "zero", count: 0 },
    pullRequests: { state: "none", count: 0, items: [] },
    worktree: "clean",
    container: "present",
    inconsistent: false,
    classification: "empty-candidate",
    recommendedAction: "release-empty-claim",
  };
}

function ports(overrides: Partial<ClaimReconciliationPorts> = {}): ClaimReconciliationPorts {
  return {
    github: {
      getIssue: vi.fn().mockResolvedValue({ existence: "present", state: "open", eligible: true }),
      getBranch: vi.fn().mockResolvedValue({ state: "absent" }),
      listPullRequests: vi.fn().mockResolvedValue([]),
    },
    git: {
      compareCommits: vi.fn(),
      countUniqueCommits: vi.fn(),
      getWorktree: vi.fn().mockResolvedValue("absent"),
    },
    docker: { getContainer: vi.fn().mockResolvedValue("absent") },
    ...overrides,
  };
}

describe("Sandcastle claim inspector", () => {
  it("renders a fixed complete human projection without host details or commands", () => {
    const rendered = renderClaimInspectionHuman(snapshot());

    expect(rendered).toContain("repository=owner/repository");
    expect(rendered).toContain("issue.number=206");
    expect(rendered).toContain("claim-branch.relation=equal");
    expect(rendered).toContain("pull-requests.state=none");
    expect(rendered).toContain("worktree=clean");
    expect(rendered).toContain("container=present");
    expect(rendered).toContain("classification=empty-candidate");
    expect(rendered).toContain("recommended-action=release-empty-claim");
    expect(rendered).not.toMatch(/(?:\/home\/|cleanup|delete|docker rm|git branch)/u);
  });

  it("renders a versioned JSON projection of the canonical snapshot", () => {
    expect(JSON.parse(renderClaimInspectionJson(snapshot()))).toEqual({
      sandcastleClaimInspection: { version: 1, ...snapshot() },
    });
  });

  it("preserves read failures as unknown and recommends manual review", async () => {
    const lines: string[] = [];
    const failingPorts = ports({
      git: {
        compareCommits: vi.fn(),
        countUniqueCommits: vi.fn(),
        getWorktree: vi.fn().mockRejectedValue(new Error("secret /home/user/repository")),
      },
    });

    const result = await inspectClaim({
      repository: "owner/repository",
      issueNumber: 206,
      comparisonBaseSha: SHA,
      ports: failingPorts,
      format: "json",
      sink: (line) => lines.push(line),
    });

    expect(result.worktree).toBe("unknown");
    expect(result.classification).toBe("inconsistent");
    expect(result.recommendedAction).toBe("manual-review");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("/home/user/repository");
  });
});
