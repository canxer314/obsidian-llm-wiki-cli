import { describe, expect, it, vi } from "vitest";

import { createSandcastleReviewerSession } from "../.sandcastle/reviewer-session.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

describe("Sandcastle Reviewer session adapter", () => {
  it("runs a fresh read-only session pinned to the reviewed revision", async () => {
    const output = {
      verdict: "Approved" as const,
      summary: "The implementation matches the Issue.",
      findings: [],
    };
    const runAgent = vi.fn().mockResolvedValue({
      branch: "sandcastle/review-321-0123456789ab-session-a",
      commits: [],
      output,
    });
    const createAgent = vi.fn().mockReturnValue({ name: "fake-reviewer" });
    const sandbox = { kind: "fake-sandbox" };
    const hooks = { sandbox: { onSandboxReady: [] } };
    const evidence = { record: vi.fn() };
    const execution = { runId: "run-1", batchId: 1, issueNumber: 103 };
    const session = createSandcastleReviewerSession({
      sandbox: sandbox as never,
      hooks,
      runAgent: runAgent as never,
      createAgent: createAgent as never,
      createSessionId: () => "session-a",
      evidence: evidence as never,
      execution,
    });

    await expect(session.run({
      pullRequestNumber: 321,
      revision,
      model: "reviewer-model",
    })).resolves.toEqual(output);

    expect(createAgent).toHaveBeenCalledWith("reviewer-model");
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      sandbox,
      hooks,
      branchStrategy: {
        type: "branch",
        branch: "sandcastle/review-321-0123456789ab-session-a",
        baseBranch: revision,
      },
      maxIterations: 1,
      name: "reviewer-pr-321-0123456789ab-attempt-1",
    }));
    const request = runAgent.mock.calls[0]![0];
    expect(request.prompt).toContain(`Pull Request #321 at exact revision ${revision}`);
    expect(request.prompt).toContain("Do not modify files, commit, push, or publish GitHub feedback");
    expect(request.prompt).toContain("Approved or Changes requested");
    expect(request.prompt).toContain("<review>");
    expect(request.output).toMatchObject({ _tag: "object", tag: "review" });
    expect(evidence.record).toHaveBeenCalledWith({
      kind: "session-started",
      ...execution,
      role: "reviewer",
      attempt: 1,
      sessionName: request.name,
      pullRequestNumber: 321,
      revision,
    });
  });

  it.each([
    { verdict: "Maybe", summary: "Looks fine.", findings: [] },
    { verdict: "Approved", summary: "", findings: [] },
    { verdict: "Changes requested", summary: "Needs work.", findings: [] },
    {
      verdict: "Approved",
      summary: "Looks fine.",
      findings: [],
      unexpected: true,
    },
  ])("rejects invalid structured Reviewer output %#", async (invalidOutput) => {
    const runAgent = vi.fn(async (request: {
      output: {
        schema: {
          "~standard": {
            validate(value: unknown): unknown | Promise<unknown>;
          };
        };
      };
    }) => {
      const validation = await request.output.schema["~standard"].validate(invalidOutput);
      if (typeof validation === "object" && validation !== null && "issues" in validation) {
        throw new Error("Reviewer structured output is invalid");
      }
      return {
        branch: "sandcastle/review-321-0123456789ab-session-a",
        commits: [],
        output: invalidOutput,
      };
    });
    const session = createSandcastleReviewerSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
      createSessionId: () => "session-a",
    });

    await expect(session.run({
      pullRequestNumber: 321,
      revision,
      model: "reviewer-model",
    })).rejects.toThrow("Reviewer structured output is invalid");
  });

  it("rejects a Reviewer session that changes the revision", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      branch: "sandcastle/review-321-0123456789ab-session-a",
      commits: [{ sha: "unexpected" }],
      output: {
        verdict: "Approved",
        summary: "Looks good.",
        findings: [],
      },
    });
    const session = createSandcastleReviewerSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-reviewer" }) as never,
    });

    await expect(session.run({
      pullRequestNumber: 321,
      revision,
      model: "reviewer-model",
    })).rejects.toThrow("Reviewer session must not create commits");
  });
});
