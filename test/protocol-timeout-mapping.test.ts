import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lifecycleRun: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../.sandcastle/worker-process-lifecycle.js", () => ({
  createWorkerProcessLifecycle: () => ({ run: mocks.lifecycleRun }),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: mocks.spawn,
}));

import { createProcessArchitectureReviewRunner } from "../.sandcastle/architecture-review-process-runner.js";
import { createProcessBranchUpdateConflictResolver } from "../.sandcastle/branch-update-conflict-process-runner.js";
import { createProcessBranchUpdater } from "../.sandcastle/branch-update-process-runner.js";
import { createProcessReviewRunner } from "../.sandcastle/review-process-runner.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

function child(pid: number): ChildProcess {
  const process = new EventEmitter() as ChildProcess;
  Object.defineProperties(process, {
    pid: { value: pid },
    stdin: { value: { end: vi.fn() } },
    stdout: { value: new EventEmitter() },
    stderr: { value: new EventEmitter() },
  });
  return process;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lifecycleRun.mockImplementation(async (options: {
    readonly launch: (
      admit: (process: ChildProcess) => void,
      disposition: { readonly detached: boolean; readonly inherited: boolean },
    ) => void;
  }) => {
    options.launch(() => {}, { detached: true, inherited: false });
    return { status: "timed-out" };
  });
  mocks.spawn.mockReturnValue(child(500));
});

describe("protocol timeout mapping", () => {
  it("maps review timeout at the lifecycle seam without public timer controls", async () => {
    const start = vi.fn().mockReturnValue(child(501));
    const runner = createProcessReviewRunner({ startup: "trusted startup", start });

    await expect(runner.review({
      pullRequestNumber: 220,
      branch: "feature/review",
      revision,
      checkoutPath: "/jobs/review-220",
      reviewThreads: [],
      model: "reviewer-model",
      artifactDirectory: "/jobs/review-artifacts/job-220",
    })).rejects.toThrow("Reviewer execution timed out");

    expect(start).toHaveBeenCalledOnce();
    expect(mocks.lifecycleRun).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMilliseconds: 30 * 60 * 1_000,
      graceMilliseconds: 10 * 1_000,
    }));
  });

  it("maps architecture-review timeout with its fixed policy", async () => {
    const start = vi.fn().mockReturnValue(child(502));
    const runner = createProcessArchitectureReviewRunner({
      startup: "trusted startup",
      start,
      writeInput: () => {},
    });

    await expect(runner.review({
      revision,
      checkoutPath: "/jobs/architecture-review-228",
      priorProposals: [],
      model: "planner-model",
      artifactDirectory: "/jobs/review-artifacts/job-228",
    })).rejects.toThrow("Architecture review execution timed out");

    expect(start).toHaveBeenCalledOnce();
    expect(mocks.lifecycleRun).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMilliseconds: 21 * 60 * 1_000,
      graceMilliseconds: 10 * 1_000,
    }));
  });

  it("maps conflict-resolution timeout with the fixed Agent policy", async () => {
    const start = vi.fn().mockReturnValue(child(503));
    const resolver = createProcessBranchUpdateConflictResolver({
      startup: "trusted startup",
      model: "merger-model",
      start,
    });

    await expect(resolver.resolve({
      pullRequestNumber: 219,
      branch: "feature/conflict-resolution",
      baseBranch: "master",
      revision,
      checkoutPath: "/jobs/conflict-resolution-219",
      conflicts: ["notes/overview.md"],
    })).rejects.toThrow("Branch update conflict resolution timed out");

    expect(start).toHaveBeenCalledOnce();
    expect(mocks.lifecycleRun).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMilliseconds: 60 * 60 * 1_000,
      graceMilliseconds: 10 * 1_000,
    }));
  });

  it("maps fixed Git timeout after exercising the production launch path", async () => {
    const updater = createProcessBranchUpdater({
      environment: { PATH: "/trusted/bin", HOME: "/trusted/home" },
    });

    await expect(updater.update({
      pullRequestNumber: 225,
      branch: "sandcastle/issue-221",
      baseBranch: "master",
      revision,
      checkoutPath: "/safe/disposable-checkout",
    })).rejects.toThrow("git command timed out after 300000ms");

    expect(mocks.spawn).toHaveBeenCalledWith("git", [
      "-C", "/safe/disposable-checkout", "fetch", "--no-tags", "origin", "master",
    ], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/trusted/bin", HOME: "/trusted/home" },
    });
    expect(mocks.lifecycleRun).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMilliseconds: 5 * 60 * 1_000,
      graceMilliseconds: 10 * 1_000,
    }));
  });
});
