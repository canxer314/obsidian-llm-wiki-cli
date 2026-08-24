import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("records the holder PID in the dispatcher lock and excludes concurrent holders", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "automation-scheduler-lock-"));
    try {
      const first = createAutomationScheduler({ repositoryPath, execute: vi.fn() });
      const second = createAutomationScheduler({ repositoryPath, execute: vi.fn() });
      await mkdir(join(repositoryPath, ".sandcastle"), { recursive: true });
      const lock = await first.acquire();
      expect(lock).toBeDefined();
      expect(
        await readFile(join(repositoryPath, ".sandcastle", "dispatcher.lock"), "utf8"),
      ).toBe(`${process.pid}\n`);
      expect(await second.acquire()).toBeUndefined();
      await lock!.release();
      expect(await second.acquire()).toBeDefined();
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("reclaims a dispatcher lock whose recorded holder PID is dead", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "automation-scheduler-stale-lock-"));
    try {
      const lockPath = join(repositoryPath, ".sandcastle", "dispatcher.lock");
      await mkdir(join(repositoryPath, ".sandcastle"), { recursive: true });
      await writeFile(lockPath, "999999\n");
      const scheduler = createAutomationScheduler({ repositoryPath, execute: vi.fn() });

      const lock = await scheduler.acquire();
      expect(lock).toBeDefined();
      expect(await readFile(lockPath, "utf8")).toBe(`${process.pid}\n`);
      await lock!.release();
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("never reclaims a dispatcher lock without a readable holder PID", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "automation-scheduler-manual-lock-"));
    try {
      const lockPath = join(repositoryPath, ".sandcastle", "dispatcher.lock");
      await mkdir(join(repositoryPath, ".sandcastle"), { recursive: true });
      await writeFile(lockPath, "");
      const scheduler = createAutomationScheduler({ repositoryPath, execute: vi.fn() });

      expect(await scheduler.acquire()).toBeUndefined();
      expect(await readFile(lockPath, "utf8")).toBe("");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("spawns git through the purpose-specific environment instead of inheriting the parent", async () => {
    const scheduler = createAutomationScheduler({
      environment: { PATH: "/definitely-not-on-this-host", HOME: "/tmp" },
    });

    await expect(scheduler.prepare()).rejects.toThrow(/spawn git ENOENT/u);
  });
});
