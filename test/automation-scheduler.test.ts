import { describe, expect, it, vi } from "vitest";

import { createAutomationScheduler } from "../.sandcastle/automation-scheduler.js";

describe("Automation scheduler", () => {
  it("fast-forwards a clean trusted master after fetch", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: "master\n" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "0\t0\n" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });
    const scheduler = createAutomationScheduler({ execute, acquireLock: async () => ({ release: async () => {} }) });

    await expect(scheduler.prepare()).resolves.toBeUndefined();
    expect(execute.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
      ["branch", "--show-current"],
      ["status", "--porcelain", "--untracked-files=normal"],
      ["fetch", "origin", "master"],
      ["rev-list", "--left-right", "--count", "master...origin/master"],
      ["merge", "--ff-only", "origin/master"],
    ]);
  });

  it.each([
    ["feature\n", "", "0\t0\n", "must run on master"],
    ["master\n", "dirty\n", "0\t0\n", "must be clean"],
    ["master\n", "", "1\t0\n", "is ahead"],
    ["master\n", "", "1\t1\n", "has diverged"],
  ])("refuses unsafe local state", async (branch, status, divergence, message) => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: branch })
      .mockResolvedValueOnce({ stdout: status })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: divergence });
    const scheduler = createAutomationScheduler({ execute, acquireLock: async () => ({ release: async () => {} }) });
    await expect(scheduler.prepare()).rejects.toThrow(message);
    expect(execute).toHaveBeenCalledTimes(branch === "feature\n" ? 1 : status !== "" ? 2 : divergence === "0\t0\n" ? 5 : 4);
  });
});
