import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createProcessSpecSplitter } from "../.sandcastle/spec-split-process-runner.js";

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

describe("Spec split process runner", () => {
  it("runs the Spec split worker and parses its slices", async () => {
    const process = child(540);
    const start = vi.fn().mockReturnValue(process);
    const runner = createProcessSpecSplitter({
      model: "planner-model",
      start,    });
    const split = runner.split({
      specNumber: 223,
      title: "Vault bridge Spec",
      checkoutPath: "/jobs/spec-split-223",
    });
    process.stdout?.emit("data", `${JSON.stringify({ slices })}\n`);
    process.emit("close", 0);

    await expect(split).resolves.toEqual(slices);
    expect(start).toHaveBeenCalledWith([
      "223",
      "Vault bridge Spec",
      "/jobs/spec-split-223",
      "planner-model",
    ]);
  });

  it("fails with the worker diagnostics when the worker exits unsuccessfully", async () => {
    const process = child(542);
    const runner = createProcessSpecSplitter({
      model: "planner-model",
      start: vi.fn().mockReturnValue(process),    });
    const split = runner.split({
      specNumber: 223,
      title: "Vault bridge Spec",
      checkoutPath: "/jobs/spec-split-223",
    });
    process.stderr?.emit("data", "Spec splitter session must not create commits");
    process.emit("close", 1);

    await expect(split).rejects.toThrow(
      "Spec split worker exited with 1: Spec splitter session must not create commits",
    );
  });
});
