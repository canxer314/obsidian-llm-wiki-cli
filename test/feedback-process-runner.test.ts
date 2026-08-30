import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createProcessFeedbackImplementer } from "../.sandcastle/feedback-process-runner.js";

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


describe("feedback implementation process runner", () => {
  it("runs the feedback worker to completion and returns the reply intent", async () => {
    const process = child(530);
    const start = vi.fn().mockReturnValue(process);
    const runner = createProcessFeedbackImplementer({
      model: "implementer-model",
      start,    });
    const implemented = runner.implement({
      pullRequestNumber: 224,
      branch: "feature/feedback",
      revision,
      checkoutPath: "/jobs/feedback-224",
      rootCommentId: "PRRC_root",
    });
    process.stdout?.emit("data", `${JSON.stringify({
      status: "implemented",
      reply: { rootCommentId: "PRRC_root", body: "Fixed." },
    })}\n`);
    process.emit("close", 0);

    await expect(implemented).resolves.toEqual({
      reply: { rootCommentId: "PRRC_root", body: "Fixed." },
    });
    expect(start).toHaveBeenCalledWith([
      "224",
      "feature/feedback",
      revision,
      "/jobs/feedback-224",
      "PRRC_root",
      "implementer-model",
    ]);
  });

  it("fails with the worker diagnostics when the worker exits unsuccessfully", async () => {
    const process = child(532);
    const runner = createProcessFeedbackImplementer({
      model: "implementer-model",
      start: vi.fn().mockReturnValue(process),    });
    const implemented = runner.implement({
      pullRequestNumber: 224,
      branch: "feature/feedback",
      revision,
      checkoutPath: "/jobs/feedback-224",
      rootCommentId: "PRRC_root",
    });
    process.stderr?.emit("data", "Sandbox unavailable");
    process.emit("close", 1);

    await expect(implemented).rejects.toThrow(
      "Feedback implementation worker exited with 1: Sandbox unavailable",
    );
  });
});
