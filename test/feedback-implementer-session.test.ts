import { describe, expect, it, vi } from "vitest";

import { createFeedbackImplementerSession } from "../.sandcastle/feedback-implementer-session.js";

describe("feedback Implementer session adapter", () => {
  it("uses the prepared Target Checkout directly so its commit remains available to the controlled publisher", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      branch: "feature/feedback",
      commits: [{ sha: "b".repeat(40) }],
      output: { rootCommentId: "PRRC_root", body: "Fixed." },
    });
    const session = createFeedbackImplementerSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-agent" }) as never,
    });

    await expect(session.run({
      model: "implementer-model",
      pullRequestNumber: 224,
      branch: "feature/feedback",
      revision: "a".repeat(40),
      checkoutPath: "/checkout",
    })).resolves.toEqual({ rootCommentId: "PRRC_root", body: "Fixed." });

    const request = runAgent.mock.calls[0]![0];
    expect(request.cwd).toBe("/checkout");
    expect(request.branchStrategy).toEqual({ type: "head" });
    expect(request.prompt).toContain("Pull Request #224");
    expect(request.prompt).toContain("Do not create an Issue, branch, or Pull Request");
    expect(request.prompt).toContain("Do not run gh auth setup-git, git push, rebase, or force-push");
    expect(request.prompt).toContain("controlled publisher");
    expect(request.prompt).not.toContain("git push origin feature/feedback");
  });

  it("returns the feedback reply intent as structured output without direct GitHub writes", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      branch: "feature/feedback",
      commits: [{ sha: "b".repeat(40) }],
      output: { rootCommentId: "PRRC_root", body: "Fixed." },
    });
    const session = createFeedbackImplementerSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-agent" }) as never,
    });

    await session.run({
      model: "implementer-model",
      pullRequestNumber: 224,
      branch: "feature/feedback",
      revision: "a".repeat(40),
      checkoutPath: "/checkout",
    });

    const request = runAgent.mock.calls[0]![0];
    expect(request.output).toBeDefined();
    expect(request.prompt).toContain("feedback-reply");
    expect(request.prompt).toContain("rootCommentId");
    expect(request.prompt).toMatch(/do not .* any github review comment or thread/i);
    expect(request.prompt).toMatch(/do not run any gh write command/i);
  });
});
