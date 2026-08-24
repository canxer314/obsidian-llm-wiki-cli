import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createProcessReviewRunner } from "../.sandcastle/review-process-runner.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

function child(pid: number): ChildProcess & EventEmitter {
  const process = new EventEmitter() as ChildProcess & EventEmitter;
  Object.defineProperties(process, {
    pid: { value: pid },
    stdout: { value: new EventEmitter() },
    stderr: { value: new EventEmitter() },
  });
  return process;
}

describe("reviewer process runner", () => {
  it("terminates the reviewer process group, forces it after grace, and waits for close", async () => {
    const process = child(420);
    let groupExit!: () => void;
    const groupExited = new Promise<void>((resolve) => { groupExit = resolve; });
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        process.emit("close", null);
        groupExit();
      }
    });
    const runner = createProcessReviewRunner({
      timeoutMilliseconds: 0,
      graceMilliseconds: 0,
      start: vi.fn().mockReturnValue(process),
      kill,
      groupExited: () => groupExited,
      wait: async () => {},
    });

    await expect(runner.review({
      pullRequestNumber: 220,
      branch: "feature/review",
      revision,
      checkoutPath: "/jobs/review-220",
      reviewThreads: [],
      model: "reviewer-model",
      artifactDirectory: "/jobs/review-artifacts/job-220",
    })).rejects.toThrow("Reviewer execution timed out");

    expect(kill).toHaveBeenNthCalledWith(1, -420, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, -420, "SIGKILL");
  });

  it("parses a successful worker review after the process exits", async () => {
    const process = child(421);
    const runner = createProcessReviewRunner({
      start: vi.fn().mockReturnValue(process),
      groupExited: async () => {},
    });
    const review = runner.review({
      pullRequestNumber: 220,
      branch: "feature/review",
      revision,
      checkoutPath: "/jobs/review-220",
      reviewThreads: [],
      model: "reviewer-model",
      artifactDirectory: "/jobs/review-artifacts/job-220",
    });
    process.stdout?.emit("data", `${JSON.stringify({ summary: "Looks good.", inlineComments: [], replies: [] })}\n`);
    process.emit("close", 0);

    await expect(review).resolves.toEqual({ summary: "Looks good.", inlineComments: [], replies: [] });
  });
});
