import { describe, expect, it, vi } from "vitest";

import { AutomationCliError, runAutomationCli } from "../.sandcastle/automation-cli.js";

describe("automation command CLI", () => {
  it("dispatches one bounded round and reads inspection without allowing arbitrary operations", async () => {
    const dispatch = vi.fn().mockResolvedValue({ status: "dispatched" });
    const inspect = vi.fn().mockResolvedValue({ commands: [] });
    const setupLabels = vi.fn().mockResolvedValue({ status: "labels-ready" });
    await expect(runAutomationCli(["dispatch", "--concurrency", "3"], {
      runReview: vi.fn(), runImplement: vi.fn(), runFeedback: vi.fn(), runSplit: vi.fn(), dispatch, inspect, setupLabels,
    })).resolves.toEqual({ status: "dispatched" });
    await expect(runAutomationCli(["setup-labels"], {
      runReview: vi.fn(), runImplement: vi.fn(), runFeedback: vi.fn(), runSplit: vi.fn(), dispatch, inspect, setupLabels,
    })).resolves.toEqual({ status: "labels-ready" });
    await expect(runAutomationCli(["inspect"], {
      runReview: vi.fn(), runImplement: vi.fn(), runFeedback: vi.fn(), runSplit: vi.fn(), dispatch, inspect, setupLabels,
    })).resolves.toEqual({ commands: [] });
    expect(dispatch).toHaveBeenCalledWith(3);
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("runs the fixed trusted architecture-review command without a Work Item number", async () => {
    const architectureReview = vi.fn().mockResolvedValue({ status: "skipped" });
    await expect(runAutomationCli(["architecture-review"], {
      runReview: vi.fn(), runImplement: vi.fn(), runFeedback: vi.fn(), runSplit: vi.fn(), architectureReview,
    })).resolves.toEqual({ status: "skipped" });
    expect(architectureReview).toHaveBeenCalledOnce();
  });

  it.each([[["architecture-review", "7"]], [["architecture-review", "--force"]]])(
    "rejects architecture-review requests with arbitrary arguments", async (argv) => {
      await expect(runAutomationCli(argv, {
        runReview: vi.fn(), runImplement: vi.fn(), architectureReview: vi.fn(),
      })).rejects.toEqual(new AutomationCliError("Expected: architecture-review"));
    },
  );

  it.each([["dispatch", "--concurrency", "0"], ["dispatch", "--other"], ["inspect", "--concurrency", "2"]])(
    "rejects unsafe dispatcher CLI options", async (argv) => {
      await expect(runAutomationCli(argv, { runReview: vi.fn(), runImplement: vi.fn(), dispatch: vi.fn(), inspect: vi.fn() }))
        .rejects.toBeInstanceOf(AutomationCliError);
    },
  );
});
