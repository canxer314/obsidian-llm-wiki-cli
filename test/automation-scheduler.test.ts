import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("exposes tracked local jobs to a separate inspection process", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "automation-scheduler-jobs-"));
    try {
      const dispatcher = createAutomationScheduler({ repositoryPath, execute: vi.fn() });
      const inspector = createAutomationScheduler({ repositoryPath, execute: vi.fn() });
      let release!: () => void;
      const tracking = dispatcher.track(
        "pull-request:10",
        () => new Promise<void>((resolve) => { release = resolve; }),
      );

      await vi.waitFor(async () => {
        expect(await inspector.activeJobs()).toEqual([
          { identity: "pull-request:10", jobId: expect.stringMatching(/^local-dispatch-/u) },
        ]);
      });

      release();
      await tracking;
      expect(await inspector.activeJobs()).toEqual([]);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not report job references left behind by dead processes or mid-write files", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "automation-scheduler-stale-jobs-"));
    try {
      const inspector = createAutomationScheduler({ repositoryPath, execute: vi.fn() });
      const jobsDirectory = join(repositoryPath, ".sandcastle", "dispatcher-jobs");
      await mkdir(jobsDirectory, { recursive: true });
      await writeFile(join(jobsDirectory, "local-dispatch-999999-1"), "pull-request:99");
      await writeFile(join(jobsDirectory, `local-dispatch-${process.pid}-2.writing`), "pull-request:98");

      expect(await inspector.activeJobs()).toEqual([]);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
