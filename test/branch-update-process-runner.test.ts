import { describe, expect, it, vi } from "vitest";

import { createProcessBranchUpdater } from "../.sandcastle/branch-update-process-runner.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const updatedRevision = "fedcba9876543210fedcba9876543210fedcba98";

describe("process branch updater", () => {
  it("merges the upstream base and pushes with an explicit revision lease", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${updatedRevision}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const updater = createProcessBranchUpdater({ execute });

    await expect(updater.update({
      branch: "sandcastle/issue-221",
      baseBranch: "master",
      revision,
      checkoutPath: "/safe/disposable-checkout",
    })).resolves.toEqual({ revision: updatedRevision });

    expect(execute).toHaveBeenLastCalledWith("git", [
      "-C", "/safe/disposable-checkout",
      "push", "--force-with-lease=refs/heads/sandcastle/issue-221:0123456789abcdef0123456789abcdef01234567",
      "origin", "HEAD:refs/heads/sandcastle/issue-221",
    ]);
  });
});
