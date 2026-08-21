import { describe, expect, it, vi } from "vitest";

import { AutomationCliError, runAutomationCli } from "../.sandcastle/automation-cli.js";

describe("automation command CLI", () => {
  it("dispatches only fixed review, feedback, and implement operations", async () => {
    const runReview = vi.fn().mockResolvedValue({ status: "reviewed" });
    const runFeedback = vi.fn().mockResolvedValue({ status: "implemented-feedback" });
    const runImplement = vi.fn().mockResolvedValue({ status: "implemented" });
    const dependencies = { runReview, runFeedback, runImplement };

    await expect(runAutomationCli(["run", "review", "220"], dependencies)).resolves.toEqual({
      status: "reviewed",
    });
    await expect(runAutomationCli(["run", "feedback", "221"], dependencies)).resolves.toEqual({
      status: "implemented-feedback",
    });
    await expect(runAutomationCli(["run", "implement", "222"], dependencies)).resolves.toEqual({
      status: "implemented",
    });

    expect(runReview).toHaveBeenCalledWith(220);
    expect(runFeedback).toHaveBeenCalledWith(221);
    expect(runImplement).toHaveBeenCalledWith(222);
  });

  it.each([
    [[], "Expected: run review <pull-request-number>, run feedback <pull-request-number>, or run implement <issue-number>"],
    [["run", "anything", "220"], "Unknown automation operation: anything"],
    [["run", "review", "0"], "review requires a positive Pull Request number"],
    [["run", "feedback", "0"], "feedback requires a positive Pull Request number"],
    [["run", "implement", "0"], "implement requires a positive Issue number"],
    [["run", "implement", "220", "--model", "anything"], "Expected: run review <pull-request-number>, run feedback <pull-request-number>, or run implement <issue-number>"],
  ])("rejects arbitrary command shapes", async (argv, message) => {
    await expect(runAutomationCli(argv, {
      runReview: vi.fn(),
      runFeedback: vi.fn(),
      runImplement: vi.fn(),
    })).rejects.toEqual(new AutomationCliError(message));
  });
});
