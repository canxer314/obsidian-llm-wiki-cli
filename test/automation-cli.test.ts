import { describe, expect, it, vi } from "vitest";

import { AutomationCliError, runAutomationCli } from "../.sandcastle/automation-cli.js";

const usage = "Expected: run review <pull-request-number>, run feedback <pull-request-number>, run implement <issue-number>, or run split <issue-number>";

describe("automation command CLI", () => {
  it("dispatches only fixed review, feedback, implement, and split operations", async () => {
    const runReview = vi.fn().mockResolvedValue({ status: "reviewed" });
    const runFeedback = vi.fn().mockResolvedValue({ status: "implemented-feedback" });
    const runImplement = vi.fn().mockResolvedValue({ status: "implemented" });
    const runSplit = vi.fn().mockResolvedValue({ status: "split" });
    const dependencies = { runReview, runFeedback, runImplement, runSplit };

    await expect(runAutomationCli(["run", "review", "220"], dependencies)).resolves.toEqual({ status: "reviewed" });
    await expect(runAutomationCli(["run", "feedback", "221"], dependencies)).resolves.toEqual({ status: "implemented-feedback" });
    await expect(runAutomationCli(["run", "implement", "222"], dependencies)).resolves.toEqual({ status: "implemented" });
    await expect(runAutomationCli(["run", "split", "223"], dependencies)).resolves.toEqual({ status: "split" });

    expect(runReview).toHaveBeenCalledWith(220);
    expect(runFeedback).toHaveBeenCalledWith(221);
    expect(runImplement).toHaveBeenCalledWith(222);
    expect(runSplit).toHaveBeenCalledWith(223);
  });

  it.each([
    [[], usage],
    [["run", "anything", "220"], "Unknown automation operation: anything"],
    [["run", "review", "0"], "review requires a positive Pull Request number"],
    [["run", "feedback", "0"], "feedback requires a positive Pull Request number"],
    [["run", "implement", "0"], "implement requires a positive Issue number"],
    [["run", "split", "0"], "split requires a positive Issue number"],
    [["run", "implement", "220", "--model", "anything"], usage],
  ])("rejects arbitrary command shapes", async (argv, message) => {
    await expect(runAutomationCli(argv, {
      runReview: vi.fn(),
      runFeedback: vi.fn(),
      runImplement: vi.fn(),
      runSplit: vi.fn(),
    })).rejects.toEqual(new AutomationCliError(message));
  });
});
