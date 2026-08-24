import { describe, expect, it, vi } from "vitest";

import { createBranchUpdateConflictResolverSession } from "../.sandcastle/branch-update-conflict-resolver.js";

const request = {
  model: "implementer-model",
  pullRequestNumber: 225,
  branch: "sandcastle/issue-221",
  baseBranch: "master",
  checkoutPath: "/safe/disposable-checkout",
  conflicts: ["src/index.ts"],
};

describe("branch update conflict resolver session", () => {
  it("runs the resolver in the acquired branch checkout and extracts its PR comment", async () => {
    const runAgent = vi.fn().mockResolvedValue({ output: { comment: "Resolved src/index.ts." } });
    const resolver = createBranchUpdateConflictResolverSession({
      sandbox: { kind: "fake-sandbox" } as never,
      hooks: { sandbox: { onSandboxReady: [] } },
      runAgent: runAgent as never,
      createAgent: vi.fn().mockReturnValue({ name: "fake-resolver" }) as never,
    });

    await expect(resolver.resolve(request)).resolves.toEqual({ comment: "Resolved src/index.ts." });

    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/safe/disposable-checkout",
      branchStrategy: { type: "branch", branch: "sandcastle/issue-221" },
      maxIterations: 1,
      name: "branch-update-pr-225",
      output: expect.objectContaining({ _tag: "object", tag: "output", maxRetries: 2 }),
    }));
    expect(runAgent.mock.calls[0]![0].prompt).toContain("src/index.ts");
    expect(runAgent.mock.calls[0]![0].prompt).toContain("Do not abort the merge");
  });
});
