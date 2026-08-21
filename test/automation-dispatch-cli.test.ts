import { describe, expect, it, vi } from "vitest";

import { AutomationCliError, runAutomationCli } from "../.sandcastle/automation-cli.js";

describe("automation command CLI", () => {
  it("dispatches one bounded round and reads inspection without allowing arbitrary operations", async () => {
    const dispatch = vi.fn().mockResolvedValue({ status: "dispatched" });
    const inspect = vi.fn().mockResolvedValue({ commands: [] });
    await expect(runAutomationCli(["dispatch", "--concurrency", "3"], {
      runReview: vi.fn(), runImplement: vi.fn(), dispatch, inspect,
    })).resolves.toEqual({ status: "dispatched" });
    await expect(runAutomationCli(["inspect"], {
      runReview: vi.fn(), runImplement: vi.fn(), dispatch, inspect,
    })).resolves.toEqual({ commands: [] });
    expect(dispatch).toHaveBeenCalledWith(3);
    expect(inspect).toHaveBeenCalledOnce();
  });

  it.each([["dispatch", "--concurrency", "0"], ["dispatch", "--other"], ["inspect", "--concurrency", "2"]])(
    "rejects unsafe dispatcher CLI options", async (argv) => {
      await expect(runAutomationCli(argv, { runReview: vi.fn(), runImplement: vi.fn(), dispatch: vi.fn(), inspect: vi.fn() }))
        .rejects.toBeInstanceOf(AutomationCliError);
    },
  );
});
