import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createProcessArchitectureReviewRunner } from "../.sandcastle/architecture-review-process-runner.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

const priorProposals = [
  { number: 101, title: "Deepen the vault index", state: "CLOSED", body: "Prior body" },
];

function child(pid: number): ChildProcess & EventEmitter {
  const process = new EventEmitter() as ChildProcess & EventEmitter;
  Object.defineProperties(process, {
    pid: { value: pid },
    stdout: { value: new EventEmitter() },
    stderr: { value: new EventEmitter() },
  });
  return process;
}

describe("architecture review process runner", () => {
  it("hands the prior proposals to the worker through the job artifact directory", async () => {
    const process = child(419);
    const start = vi.fn().mockReturnValue(process);
    const writeInput = vi.fn(() => {});
    const runner = createProcessArchitectureReviewRunner({
      start,
      writeInput,
      groupExited: async () => {},
    });
    const review = runner.review({
      revision,
      checkoutPath: "/jobs/architecture-review-228",
      priorProposals,
      model: "planner-model",
      artifactDirectory: "/jobs/review-artifacts/job-228",
    });
    process.stdout?.emit("data", `${JSON.stringify({ status: "skipped", reason: "covered" })}\n`);
    process.emit("close", 0);

    await expect(review).resolves.toEqual({ status: "skipped", reason: "covered" });
    expect(writeInput).toHaveBeenCalledWith(
      "/jobs/review-artifacts/job-228/architecture-review-input.json",
      priorProposals,
    );
    expect(start).toHaveBeenCalledWith([
      revision,
      "/jobs/architecture-review-228",
      "planner-model",
      "/jobs/review-artifacts/job-228",
    ]);
  });

  it("parses a successful worker outcome after the process exits", async () => {
    const process = child(421);
    const runner = createProcessArchitectureReviewRunner({
      start: vi.fn().mockReturnValue(process),
      writeInput: () => {},
      groupExited: async () => {},
    });
    const review = runner.review({
      revision,
      checkoutPath: "/jobs/architecture-review-228",
      priorProposals,
      model: "planner-model",
      artifactDirectory: "/jobs/review-artifacts/job-228",
    });
    process.stdout?.emit("data", `${JSON.stringify({
      status: "proposed",
      title: "Deepen the search indexer",
      body: "body",
      oneLineSummary: "summary",
      candidatesConsidered: ["indexer"],
    })}\n`);
    process.emit("close", 0);

    await expect(review).resolves.toEqual({
      status: "proposed",
      title: "Deepen the search indexer",
      body: "body",
      oneLineSummary: "summary",
      candidatesConsidered: ["indexer"],
    });
  });

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
    const runner = createProcessArchitectureReviewRunner({
      timeoutMilliseconds: 0,
      graceMilliseconds: 0,
      start: vi.fn().mockReturnValue(process),
      writeInput: () => {},
      kill,
      groupExited: () => groupExited,
      wait: async () => {},
    });

    await expect(runner.review({
      revision,
      checkoutPath: "/jobs/architecture-review-228",
      priorProposals,
      model: "planner-model",
      artifactDirectory: "/jobs/review-artifacts/job-228",
    })).rejects.toThrow("Architecture review execution timed out");

    expect(kill).toHaveBeenNthCalledWith(1, -420, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, -420, "SIGKILL");
  });

  it("fails with the worker diagnostics when the worker exits unsuccessfully", async () => {
    const process = child(422);
    const runner = createProcessArchitectureReviewRunner({
      start: vi.fn().mockReturnValue(process),
      writeInput: () => {},
      groupExited: async () => {},
    });
    const review = runner.review({
      revision,
      checkoutPath: "/jobs/architecture-review-228",
      priorProposals,
      model: "planner-model",
      artifactDirectory: "/jobs/review-artifacts/job-228",
    });
    process.stderr?.emit("data", "Sandbox unavailable");
    process.emit("close", 1);

    await expect(review).rejects.toThrow("Architecture review worker exited with 1: Sandbox unavailable");
  });
});
