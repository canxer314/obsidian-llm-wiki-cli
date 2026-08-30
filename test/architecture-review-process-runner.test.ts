import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const architectureReviewRequest = {
  revision,
  checkoutPath: "/jobs/architecture-review-228",
  priorProposals,
  model: "planner-model",
  artifactDirectory: "/jobs/review-artifacts/job-228",
};

let nextPid = 600;
async function runArchitectureOutput(output: unknown): Promise<unknown> {
  const process = child(nextPid++);
  const runner = createProcessArchitectureReviewRunner({
    start: vi.fn().mockReturnValue(process),
    writeInput: () => {},
  });
  const review = runner.review(architectureReviewRequest);
  process.stdout?.emit("data", JSON.stringify(output));
  process.emit("close", 0);
  return review;
}

describe("architecture review process runner", () => {
  it("hands the prior proposals to the worker through the job artifact directory", async () => {
    const process = child(419);
    const start = vi.fn().mockReturnValue(process);
    const writeInput = vi.fn(() => {});
    const runner = createProcessArchitectureReviewRunner({
      start,
      writeInput,
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

  it("writes serialized prior proposals to a private artifact before launch", async () => {
    const artifactDirectory = mkdtempSync(join(tmpdir(), "architecture-review-"));
    const process = child(418);
    const start = vi.fn().mockReturnValue(process);
    const runner = createProcessArchitectureReviewRunner({ start });
    try {
      const review = runner.review({
        revision,
        checkoutPath: "/jobs/architecture-review-228",
        priorProposals,
        model: "planner-model",
        artifactDirectory,
      });
      process.stdout?.emit("data", `${JSON.stringify({ status: "skipped", reason: "covered" })}\n`);
      process.emit("close", 0);

      await expect(review).resolves.toEqual({ status: "skipped", reason: "covered" });
      const input = join(artifactDirectory, "architecture-review-input.json");
      expect(readFileSync(input, "utf8")).toBe(JSON.stringify(priorProposals));
      expect(statSync(input).mode & 0o777).toBe(0o600);
      expect(start).toHaveBeenCalledOnce();
    } finally {
      rmSync(artifactDirectory, { recursive: true, force: true });
    }
  });

  it("does not launch the worker when writing prior proposals fails", async () => {
    const start = vi.fn();
    const runner = createProcessArchitectureReviewRunner({
      start,
      writeInput: () => { throw new Error("artifact unavailable"); },
    });

    await expect(runner.review({
      revision,
      checkoutPath: "/jobs/architecture-review-228",
      priorProposals,
      model: "planner-model",
      artifactDirectory: "/jobs/review-artifacts/job-228",
    })).rejects.toThrow("artifact unavailable");

    expect(start).not.toHaveBeenCalled();
  });

  it("parses a successful worker outcome after the process exits", async () => {
    const process = child(421);
    const runner = createProcessArchitectureReviewRunner({
      start: vi.fn().mockReturnValue(process),
      writeInput: () => {},
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

  it("attaches output listeners before delivering startup and closing stdin", async () => {
    const process = child(420);
    const events: string[] = [];
    Object.defineProperty(process, "stdin", {
      value: Object.assign(new EventEmitter(), {
        end: (startup: string) => {
          events.push(`startup:${startup}`);
          process.stdout?.emit("data", `${JSON.stringify({ status: "skipped", reason: "covered" })}\n`);
          process.emit("close", 0);
        },
      }),
    });
    const runner = createProcessArchitectureReviewRunner({
      startup: "trusted-startup",
      start: vi.fn((arguments_: readonly string[]) => {
        events.push(`launch:${arguments_.join(",")}`);
        return process;
      }),
      writeInput: () => {},
    });

    await expect(runner.review({
      revision,
      checkoutPath: "/jobs/architecture-review-228",
      priorProposals,
      model: "planner-model",
      artifactDirectory: "/jobs/review-artifacts/job-228",
    })).resolves.toEqual({ status: "skipped", reason: "covered" });

    expect(events).toEqual([
      `launch:${revision},/jobs/architecture-review-228,planner-model,/jobs/review-artifacts/job-228`,
      "startup:trusted-startup",
    ]);
  });

  it.each([
    [null, "terminated", "Architecture review worker exited with signal: terminated"],
    [0, "", "Architecture review worker did not return an outcome"],
  ] as const)("fails closed for code %s and output absence", async (code, diagnostics, message) => {
    const process = child(423);
    const runner = createProcessArchitectureReviewRunner({
      start: vi.fn().mockReturnValue(process),
      writeInput: () => {},
    });
    const review = runner.review({
      revision,
      checkoutPath: "/jobs/architecture-review-228",
      priorProposals,
      model: "planner-model",
      artifactDirectory: "/jobs/review-artifacts/job-228",
    });
    process.stderr?.emit("data", diagnostics);
    process.emit("close", code);

    await expect(review).rejects.toThrow(message);
  });

  it.each([
    ["empty object", {}],
    ["null", null],
    ["unknown status", { status: "unknown" }],
    ["incomplete skipped", { status: "skipped" }],
    ["incomplete proposed", { status: "proposed", title: "title" }],
    ["invalid candidates", {
      status: "proposed",
      title: "title",
      body: "body",
      oneLineSummary: "summary",
      candidatesConsidered: [],
    }],
    ["overlong title", {
      status: "proposed",
      title: "x".repeat(257),
      body: "body",
      oneLineSummary: "summary",
      candidatesConsidered: ["candidate"],
    }],
    ["wrong field type", { status: "skipped", reason: 1 }],
    ["extra field", { status: "skipped", reason: "covered", secret: "do-not-publish" }],
  ])("rejects schema-invalid architecture-review output: %s", async (_case, output) => {
    const failure = await runArchitectureOutput(output).catch((error: unknown) => error);

    expect(failure).toHaveProperty(
      "message",
      "Architecture review worker returned an invalid outcome",
    );
    expect(String(failure)).not.toContain(JSON.stringify(output));
    expect(String(failure)).not.toContain("do-not-publish");
  });

  it("rejects malformed architecture-review output", async () => {
    const process = child(424);
    const runner = createProcessArchitectureReviewRunner({
      start: vi.fn().mockReturnValue(process),
      writeInput: () => {},
    });
    const review = runner.review({
      revision,
      checkoutPath: "/jobs/architecture-review-228",
      priorProposals,
      model: "planner-model",
      artifactDirectory: "/jobs/review-artifacts/job-228",
    });
    process.stdout?.emit("data", "not json");
    process.emit("close", 0);

    await expect(review).rejects.toThrow(/JSON/u);
  });

  it("fails with the worker diagnostics when the worker exits unsuccessfully", async () => {
    const process = child(422);
    const runner = createProcessArchitectureReviewRunner({
      start: vi.fn().mockReturnValue(process),
      writeInput: () => {},
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
