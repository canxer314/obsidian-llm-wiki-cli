import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createProcessReviewRunner } from "../.sandcastle/review-process-runner.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

function child(pid: number): ChildProcess & EventEmitter {
  const stdin = new EventEmitter() as EventEmitter & { end(input?: string): void };
  stdin.end = () => {};
  const process = new EventEmitter() as ChildProcess & EventEmitter;
  Object.defineProperties(process, {
    pid: { value: pid },
    stdin: { value: stdin },
    stdout: { value: new EventEmitter() },
    stderr: { value: new EventEmitter() },
  });
  return process;
}

const reviewRequest = {
  pullRequestNumber: 220,
  branch: "feature/review",
  revision,
  checkoutPath: "/jobs/review-220",
  reviewThreads: [],
  model: "reviewer-model",
  artifactDirectory: "/jobs/review-artifacts/job-220",
};

let nextPid = 500;
async function runReviewOutput(output: unknown): Promise<unknown> {
  const process = child(nextPid++);
  const runner = createProcessReviewRunner({ start: vi.fn().mockReturnValue(process) });
  const review = runner.review(reviewRequest);
  process.stdout?.emit("data", JSON.stringify(output));
  process.emit("close", 0);
  return review;
}

describe("reviewer process runner", () => {
  it("registers output listeners before writing trusted startup and preserves the review argv protocol", async () => {
    const process = child(420);
    const start = vi.fn().mockReturnValue(process);
    const order: string[] = [];
    process.stdin!.end = (startup?: string) => {
      order.push(`stdin:${startup}`);
      process.stdout?.emit("data", "reviewer log\n");
      process.stdout?.emit("data", `${JSON.stringify({ summary: "Looks good.", inlineComments: [], replies: [] })}\n`);
      process.emit("close", 0);
    };
    const runner = createProcessReviewRunner({ start, startup: "trusted startup" });

    await expect(runner.review(reviewRequest)).resolves.toEqual({ summary: "Looks good.", inlineComments: [], replies: [] });

    expect(order).toEqual(["stdin:trusted startup"]);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![0]).toEqual([
      "220",
      "feature/review",
      revision,
      "/jobs/review-220",
      "[]",
      "reviewer-model",
      "/jobs/review-artifacts/job-220",
    ]);
  });

  it("parses a successful worker review after the process exits", async () => {
    const process = child(421);
    const runner = createProcessReviewRunner({
      start: vi.fn().mockReturnValue(process),
    });
    const review = runner.review(reviewRequest);
    process.stdout?.emit("data", `${JSON.stringify({ summary: "Looks good.", inlineComments: [], replies: [] })}\n`);
    process.emit("close", 0);

    await expect(review).resolves.toEqual({ summary: "Looks good.", inlineComments: [], replies: [] });
  });

  it.each([
    [1, "Sandbox unavailable", "Reviewer worker exited with 1: Sandbox unavailable"],
    [null, "terminated", "Reviewer worker exited with signal: terminated"],
  ])("fails closed for exit code %s", async (code, diagnostics, message) => {
    const process = child(422);
    const runner = createProcessReviewRunner({ start: vi.fn().mockReturnValue(process) });
    const review = runner.review(reviewRequest);
    process.stderr?.emit("data", diagnostics);
    process.emit("close", code);

    await expect(review).rejects.toThrow(message);
  });

  it.each([
    ["empty object", {}],
    ["null", null],
    ["missing arrays", { summary: "review" }],
    ["wrong comments type", { summary: "review", inlineComments: {}, replies: [] }],
    ["wrong replies type", { summary: "review", inlineComments: [], replies: "none" }],
    ["invalid nested comment", {
      summary: "review",
      inlineComments: [{ path: "../secret", line: 1, body: "problem" }],
      replies: [],
    }],
    ["invalid nested reply", {
      summary: "review",
      inlineComments: [],
      replies: [{ commentId: 2, body: "fixed" }],
    }],
    ["unsafe absolute path", {
      summary: "review",
      inlineComments: [{ path: "/secret", line: 1, body: "problem" }],
      replies: [],
    }],
    ["invalid line number", {
      summary: "review",
      inlineComments: [{ path: "src/file.ts", line: 0, body: "problem" }],
      replies: [],
    }],
    ["extra field", { summary: "review", inlineComments: [], replies: [], secret: "do-not-publish" }],
  ])("rejects schema-invalid successful output: %s", async (_case, output) => {
    const failure = await runReviewOutput(output).catch((error: unknown) => error);

    expect(failure).toHaveProperty("message", "Reviewer worker returned an invalid review");
    expect(String(failure)).not.toContain(JSON.stringify(output));
    expect(String(failure)).not.toContain("do-not-publish");
  });

  it.each([
    ["", "Unexpected end of JSON input"],
    ["not json", "Unexpected token 'o', \"not json\" is not valid JSON"],
  ])("rejects invalid successful output %j", async (output, message) => {
    const process = child(423);
    const runner = createProcessReviewRunner({ start: vi.fn().mockReturnValue(process) });
    const review = runner.review(reviewRequest);
    process.stdout?.emit("data", output);
    process.emit("close", 0);

    await expect(review).rejects.toThrow(message);
  });
});
