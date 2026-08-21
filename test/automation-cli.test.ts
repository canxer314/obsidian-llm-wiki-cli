import { describe, expect, it, vi } from "vitest";

import { AutomationCliError, runAutomationCli } from "../.sandcastle/automation-cli.js";

describe("automation command CLI", () => {
  it("dispatches only fixed review and implement operations", async () => {
    const runReview = vi.fn().mockResolvedValue({ status: "reviewed" });
    const runImplement = vi.fn().mockResolvedValue({ status: "implemented" });

    await expect(runAutomationCli(["run", "review", "220"], { runReview, runImplement })).resolves.toEqual({
      status: "reviewed",
    });
    await expect(runAutomationCli(["run", "implement", "221"], { runReview, runImplement })).resolves.toEqual({
      status: "implemented",
    });

    expect(runReview).toHaveBeenCalledWith(220);
    expect(runImplement).toHaveBeenCalledWith(221);
  });

  it.each([
    [[], "Expected: run review <pull-request-number> or run implement <issue-number>"],
    [["run", "anything", "220"], "Unknown automation operation: anything"],
    [["run", "review", "0"], "review requires a positive Pull Request number"],
    [["run", "implement", "0"], "implement requires a positive Issue number"],
    [["run", "implement", "220", "--model", "anything"], "Expected: run review <pull-request-number> or run implement <issue-number>"],
  ])("rejects arbitrary command shapes", async (argv, message) => {
    await expect(runAutomationCli(argv, { runReview: vi.fn(), runImplement: vi.fn() }))
      .rejects.toEqual(new AutomationCliError(message));
  });
});
