import { describe, expect, it, vi } from "vitest";

import { mergeConflict } from "../.sandcastle/conflict-merger.js";
import { createSandcastleMergerSession } from "../.sandcastle/merger-session.js";

const request = {
  pullRequest: {
    number: 321,
    url: "https://github.com/example/repo/pull/321",
    headSha: "a".repeat(40),
  },
  attempt: 1 as const,
  targetBranch: "master",
  targetSha: "b".repeat(40),
  summary: "Target master conflicts with the Issue branch",
};

describe("Sandcastle conflict Merger", () => {
  it("runs a dedicated bounded session that only pushes a normal merge", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      branch: "sandcastle/issue-111",
      commits: [{ sha: "c".repeat(40) }],
    });
    const evidence = { record: vi.fn() };
    const execution = { runId: "run-1", batchId: 1, issueNumber: 111 };
    const session = createSandcastleMergerSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-agent" }) as never,
      evidence: evidence as never,
      execution,
    });

    await session.run({
      model: "merger-model",
      branch: "sandcastle/issue-111",
      request,
    });

    const agentRequest = runAgent.mock.calls[0]![0];
    expect(agentRequest.name).toBe("merger-issue-111-attempt-1");
    expect(agentRequest.branchStrategy).toEqual({
      type: "branch",
      branch: "sandcastle/issue-111",
      baseBranch: "origin/sandcastle/issue-111",
    });
    expect(agentRequest.maxIterations).toBe(1);
    expect(agentRequest.prompt).toContain(request.pullRequest.headSha);
    expect(agentRequest.prompt).toContain(request.targetSha);
    expect(agentRequest.prompt).toContain(`git fetch origin ${request.targetBranch}`);
    expect(agentRequest.prompt).toContain(`confirm FETCH_HEAD is exactly ${request.targetSha}`);
    expect(agentRequest.prompt).toContain(`git merge ${request.targetSha}`);
    expect(agentRequest.prompt).toContain("Do not rebase or force-push");
    expect(agentRequest.prompt).not.toContain("gh pr create");
    expect(evidence.record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "session-started", ...execution, role: "merger", stage: "merger",
      attempt: 1, sessionName: agentRequest.name, pullRequestNumber: 321,
      revision: request.pullRequest.headSha, timestamp: expect.any(String),
    }));
    expect(evidence.record).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "session-finished", outcome: "completed", durationMs: expect.any(Number),
    }));
  });

  it("verifies the Merger pushed a new normal merge to the existing Pull Request", async () => {
    const merged = { ...request.pullRequest, headSha: "c".repeat(40) };
    const session = {
      run: vi.fn().mockResolvedValue({
        branch: "sandcastle/issue-111",
        commits: [{ sha: merged.headSha }],
      }),
    };
    const github = { verifyConflictMerge: vi.fn().mockResolvedValue(merged) };

    await expect(mergeConflict({
      issueNumber: 111,
      model: "merger-model",
      session,
      github,
      request,
    })).resolves.toEqual(merged);

    expect(github.verifyConflictMerge).toHaveBeenCalledWith({
      issueNumber: 111,
      pullRequest: request.pullRequest,
      expectedHeadSha: merged.headSha,
      targetBranch: "master",
      targetSha: request.targetSha,
    });
  });
});
