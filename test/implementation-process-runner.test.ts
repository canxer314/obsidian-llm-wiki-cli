import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createProcessImplementer } from "../.sandcastle/implementation-process-runner.js";

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


describe("implementation process runner", () => {
  it("runs the implementation worker and parses its published result", async () => {
    const process = child(510);
    const start = vi.fn().mockReturnValue(process);
    const runner = createProcessImplementer({
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      start,    });
    const implemented = runner.implement({
      issueNumber: 221,
      baseRevision: revision,
      checkoutPath: "/jobs/implementation-221",
    });
    process.stdout?.emit("data", `${JSON.stringify({
      branch: "sandcastle/issue-221",
      pullRequestUrl: "https://example.test/pull/9",
    })}\n`);
    process.emit("close", 0);

    await expect(implemented).resolves.toEqual({
      branch: "sandcastle/issue-221",
      pullRequestUrl: "https://example.test/pull/9",
    });
    expect(start).toHaveBeenCalledWith([
      "221",
      revision,
      "/jobs/implementation-221",
      "planner-model",
      "implementer-model",
    ]);
  });

  it("fails with the worker diagnostics when the worker exits unsuccessfully", async () => {
    const process = child(512);
    const runner = createProcessImplementer({
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      start: vi.fn().mockReturnValue(process),    });
    const implemented = runner.implement({
      issueNumber: 221,
      baseRevision: revision,
      checkoutPath: "/jobs/implementation-221",
    });
    process.stderr?.emit("data", "Sandbox unavailable");
    process.emit("close", 1);

    await expect(implemented).rejects.toThrow("Implementation worker exited with 1: Sandbox unavailable");
  });
});
