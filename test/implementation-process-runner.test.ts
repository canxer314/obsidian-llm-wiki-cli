import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function expectDescendantDead(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Descendant process ${pid} survived group termination`);
}

describe("implementation process runner", () => {
  it("kills a real descendant process tree after a graceful-then-forced group termination", async () => {
    const marker = join(tmpdir(), `implementation-descendant-${process.pid}.pid`);
    // The leader and its descendant both ignore SIGTERM, so the runner must
    // escalate to SIGKILL before the whole group can exit.
    const start = () => spawn("bash", ["-c", `trap '' TERM; sleep 30 & echo $! > ${marker}; wait`], {
      detached: true,
      stdio: "ignore",
    });
    const runner = createProcessImplementer({
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      timeoutMilliseconds: 100,
      graceMilliseconds: 100,
      start,
    });

    await expect(runner.implement({
      issueNumber: 221,
      baseRevision: revision,
      checkoutPath: "/jobs/implementation-221",
    })).rejects.toThrow("Implementation execution timed out");

    const descendant = Number(readFileSync(marker, "utf8"));
    rmSync(marker, { force: true });
    await expectDescendantDead(descendant);
  });

  it("runs the implementation worker and parses its published result", async () => {
    const process = child(510);
    const start = vi.fn().mockReturnValue(process);
    const runner = createProcessImplementer({
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      start,
      groupExited: async () => {},
    });
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

  it("terminates the worker process group, forces it after grace, and waits for close", async () => {
    const process = child(511);
    let groupExit!: () => void;
    const groupExited = new Promise<void>((resolve) => { groupExit = resolve; });
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        process.emit("close", null);
        groupExit();
      }
    });
    const runner = createProcessImplementer({
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      timeoutMilliseconds: 0,
      graceMilliseconds: 0,
      start: vi.fn().mockReturnValue(process),
      kill,
      groupExited: () => groupExited,
      wait: async () => {},
    });

    await expect(runner.implement({
      issueNumber: 221,
      baseRevision: revision,
      checkoutPath: "/jobs/implementation-221",
    })).rejects.toThrow("Implementation execution timed out");

    expect(kill).toHaveBeenNthCalledWith(1, -511, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, -511, "SIGKILL");
  });

  it("fails with the worker diagnostics when the worker exits unsuccessfully", async () => {
    const process = child(512);
    const runner = createProcessImplementer({
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      start: vi.fn().mockReturnValue(process),
      groupExited: async () => {},
    });
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
