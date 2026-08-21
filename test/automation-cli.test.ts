import { describe, expect, it, vi } from "vitest";

import { AutomationCliError, runAutomationCli } from "../.sandcastle/automation-cli.js";

describe("automation command CLI", () => {
  it("dispatches only the fixed review operation", async () => {
    const runReview = vi.fn().mockResolvedValue({ status: "reviewed" });

    await expect(runAutomationCli(["run", "review", "220"], { runReview })).resolves.toEqual({
      status: "reviewed",
    });

    expect(runReview).toHaveBeenCalledWith(220);
  });

  it.each([
    [[], "Expected: run review <pull-request-number>"],
    [["run", "implement", "220"], "Unknown automation operation: implement"],
    [["run", "review", "0"], "review requires a positive Pull Request number"],
    [["run", "review", "220", "--model", "anything"], "Expected: run review <pull-request-number>"],
  ])("rejects arbitrary command shapes", async (argv, message) => {
    await expect(runAutomationCli(argv, { runReview: vi.fn() }))
      .rejects.toEqual(new AutomationCliError(message));
  });
});
