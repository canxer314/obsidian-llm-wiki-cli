import { describe, expect, it, vi } from "vitest";

import { createFeedbackImplementerSession } from "../.sandcastle/feedback-implementer-session.js";

describe("feedback Implementer session adapter", () => {
  it("limits the agent to committing feedback locally for controlled publication", async () => {
    const runAgent = vi.fn().mockResolvedValue({ branch: "feature/feedback", commits: [] });
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
    expect(request.cwd).toBe("/checkout");
    expect(request.branchStrategy).toEqual({ type: "branch", branch: "feature/feedback" });
    expect(request.prompt).toContain("Pull Request #224");
    expect(request.prompt).toContain("Do not create an Issue, branch, or Pull Request");
    expect(request.prompt).toContain("Do not run gh auth setup-git, git push, rebase, or force-push");
    expect(request.prompt).toContain("controlled publisher");
    expect(request.prompt).not.toContain("git push origin feature/feedback");
  });
});
