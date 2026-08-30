import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createProcessPrdSplitter } from "../.sandcastle/prd-split-process-runner.js";

function child(pid: number): ChildProcess & EventEmitter {
  const process = new EventEmitter() as ChildProcess & EventEmitter;
  Object.defineProperties(process, {
    pid: { value: pid },
    stdout: { value: new EventEmitter() },
    stderr: { value: new EventEmitter() },
  });
  return process;
}


const slices = [
  { title: "Slice one", whatToBuild: "First tracer bullet", acceptanceCriteria: ["it works"] },
];

describe("PRD split process runner", () => {
  it("runs the PRD split worker and parses its slices", async () => {
    const process = child(540);
    const start = vi.fn().mockReturnValue(process);
    const runner = createProcessPrdSplitter({
      model: "planner-model",
      start,    });
    const split = runner.split({
      prdNumber: 223,
      title: "Vault bridge PRD",
      checkoutPath: "/jobs/prd-split-223",
    });
    process.stdout?.emit("data", `${JSON.stringify({ slices })}\n`);
    process.emit("close", 0);

    await expect(split).resolves.toEqual(slices);
    expect(start).toHaveBeenCalledWith([
      "223",
      "Vault bridge PRD",
      "/jobs/prd-split-223",
      "planner-model",
    ]);
  });

  it("fails with the worker diagnostics when the worker exits unsuccessfully", async () => {
    const process = child(542);
    const runner = createProcessPrdSplitter({
      model: "planner-model",
      start: vi.fn().mockReturnValue(process),    });
    const split = runner.split({
      prdNumber: 223,
      title: "Vault bridge PRD",
      checkoutPath: "/jobs/prd-split-223",
    });
    process.stderr?.emit("data", "PRD splitter session must not create commits");
    process.emit("close", 1);

    await expect(split).rejects.toThrow(
      "PRD split worker exited with 1: PRD splitter session must not create commits",
    );
  });
});
