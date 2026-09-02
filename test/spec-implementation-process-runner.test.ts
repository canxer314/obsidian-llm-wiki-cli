import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createProcessSpecImplementer } from "../.sandcastle/spec-implementation-process-runner.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function child(pid: number): ChildProcess & EventEmitter {
  const process = new EventEmitter() as ChildProcess & EventEmitter;
  Object.defineProperties(process, {
    pid: { value: pid },
    stdout: { value: new EventEmitter() },
    stderr: { value: new EventEmitter() },
  });
  return process;
}


describe("Spec implementation process runner", () => {
  it("runs the Spec implementation worker and parses its committed result", async () => {
    const process = child(520);
    const start = vi.fn().mockReturnValue(process);
    const runner = createProcessSpecImplementer({
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      start,    });
    const implemented = runner.implement({
      specNumber: 226,
      child: { number: 301, title: "Slice one" },
      branch: "sandcastle/spec-226",
      baseRevision: revision,
      checkoutPath: "/jobs/spec-implementation-226",
    });
    process.stdout?.emit("data", `${JSON.stringify({ branch: "sandcastle/spec-226", headSha })}\n`);
    process.emit("close", 0);

    await expect(implemented).resolves.toEqual({ branch: "sandcastle/spec-226", headSha });
    expect(start).toHaveBeenCalledWith([
      "226",
      "301",
      "sandcastle/spec-226",
      revision,
      "/jobs/spec-implementation-226",
      "planner-model",
      "implementer-model",
    ]);
  });

  it("fails with the worker diagnostics when the worker exits unsuccessfully", async () => {
    const process = child(522);
    const runner = createProcessSpecImplementer({
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      start: vi.fn().mockReturnValue(process),    });
    const implemented = runner.implement({
      specNumber: 226,
      child: { number: 301, title: "Slice one" },
      branch: "sandcastle/spec-226",
      baseRevision: revision,
      checkoutPath: "/jobs/spec-implementation-226",
    });
    process.stderr?.emit("data", "Planner did not return a valid structured plan");
    process.emit("close", 1);

    await expect(implemented).rejects.toThrow(
      "Spec implementation worker exited with 1: Planner did not return a valid structured plan",
    );
  });
});
