import { describe, expect, it, vi } from "vitest";

import { AutomationCliError, runAutomationCli } from "../.sandcastle/automation-cli.js";

describe("automation command CLI", () => {
  it("dispatches only fixed review, implement, and split operations", async () => {
    const runReview = vi.fn().mockResolvedValue({ status: "reviewed" });
    const runImplement = vi.fn().mockResolvedValue({ status: "implemented" });
    const runSplit = vi.fn().mockResolvedValue({ status: "split" });

    await expect(runAutomationCli(["run", "review", "220"], { runReview, runImplement, runSplit })).resolves.toEqual({
      status: "reviewed",
    });
    await expect(runAutomationCli(["run", "implement", "221"], { runReview, runImplement, runSplit })).resolves.toEqual({
      status: "implemented",
    });
    await expect(runAutomationCli(["run", "split", "222"], { runReview, runImplement, runSplit })).resolves.toEqual({
      status: "split",
    });

    expect(runReview).toHaveBeenCalledWith(220);
    expect(runImplement).toHaveBeenCalledWith(221);
    expect(runSplit).toHaveBeenCalledWith(222);
  });

  it.each([
    [[], "Expected: run review <pull-request-number>, run implement <issue-number>, or run split <issue-number>"],
    [["run", "anything", "220"], "Unknown automation operation: anything"],
    [["run", "review", "0"], "review requires a positive Pull Request number"],
    [["run", "implement", "0"], "implement requires a positive Issue number"],
    [["run", "implement", "220", "--model", "anything"], "Expected: run review <pull-request-number>, run implement <issue-number>, or run split <issue-number>"],
  ])("rejects arbitrary command shapes", async (argv, message) => {
    await expect(runAutomationCli(argv, { runReview: vi.fn(), runImplement: vi.fn(), runSplit: vi.fn() }))
      .rejects.toEqual(new AutomationCliError(message));
  });
});
