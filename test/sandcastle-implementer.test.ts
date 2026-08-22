import { describe, expect, it, vi } from "vitest";

import {
  ImplementerResultError,
  implementIssue,
  type ImplementerGithubPort,
} from "../.sandcastle/implementer.js";
import type { ImplementerAgentSession } from "../.sandcastle/implementer-session.js";

const plan = {
  status: "ready" as const,
  implementationSummary: "Implement the requested behavior.",
  blockingReason: null,
  allowsAutomationChanges: false,
  issue: {
    number: 103,
    title: "Implementer",
    body: "Implement this Issue.",
    labels: ["Sandcastle"],
    comments: [],
  },
};

function session(result: {
  readonly branch: string;
  readonly commits: readonly { readonly sha: string }[];
}): ImplementerAgentSession {
  return { run: vi.fn().mockResolvedValue(result) };
}

function github(): ImplementerGithubPort {
  return {
    verifyImplementation: vi.fn().mockResolvedValue({
      number: 321,
      headSha: "abc123",
      url: "https://github.com/example/repo/pull/321",
    }),
  };
}

describe("Sandcastle Implementer", () => {
  it("hands the complete plan to an independent session and verifies its pushed Draft PR", async () => {
    const agentSession = session({
      branch: "sandcastle/issue-103",
      commits: [{ sha: "abc123" }],
    });
    const githubPort = github();

    await expect(implementIssue({
      plan,
      model: "implementer-model",
      session: agentSession,
      github: githubPort,
    })).resolves.toEqual({
      number: 321,
      headSha: "abc123",
      url: "https://github.com/example/repo/pull/321",
    });

    expect(agentSession.run).toHaveBeenCalledWith({
      model: "implementer-model",
      branch: "sandcastle/issue-103",
      plan,
    });
    expect(githubPort.verifyImplementation).toHaveBeenCalledWith({
      issueNumber: 103,
      branch: "sandcastle/issue-103",
      expectedHeadSha: "abc123",
      allowsAutomationChanges: false,
    });
  });

  it.each([
    {
      name: "wrong branch",
      result: { branch: "other", commits: [{ sha: "abc123" }] },
    },
    {
      name: "missing commit",
      result: { branch: "sandcastle/issue-103", commits: [] },
    },
  ])("fails closed for $name before trusting GitHub state", async ({ result }) => {
    const githubPort = github();

    await expect(implementIssue({
      plan,
      model: "implementer-model",
      session: session(result),
      github: githubPort,
    })).rejects.toBeInstanceOf(ImplementerResultError);

    expect(githubPort.verifyImplementation).not.toHaveBeenCalled();
  });

  it("propagates an Implementer interruption during push or Pull Request creation", async () => {
    const interruption = new Error("Implementer session interrupted");
    const agentSession: ImplementerAgentSession = {
      run: vi.fn().mockRejectedValue(interruption),
    };
    const githubPort = github();

    await expect(implementIssue({
      plan,
      model: "implementer-model",
      session: agentSession,
      github: githubPort,
    })).rejects.toBe(interruption);

    expect(githubPort.verifyImplementation).not.toHaveBeenCalled();
  });

  it("propagates push or Pull Request verification failures", async () => {
    const failure = new Error("Draft Pull Request head does not match the Implementer commit");
    const githubPort = github();
    vi.mocked(githubPort.verifyImplementation).mockRejectedValue(failure);

    await expect(implementIssue({
      plan,
      model: "implementer-model",
      session: session({
        branch: "sandcastle/issue-103",
        commits: [{ sha: "abc123" }],
      }),
      github: githubPort,
    })).rejects.toBe(failure);
  });
});
