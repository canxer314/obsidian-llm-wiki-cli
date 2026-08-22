import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const slices = [
  { title: "Slice one", whatToBuild: "First tracer bullet", acceptanceCriteria: ["it works"] },
];

describe("PRD split process runner", () => {
  it("kills a real descendant process tree after a graceful-then-forced group termination", async () => {
    const marker = join(tmpdir(), `prd-split-descendant-${process.pid}.pid`);
    // The leader and its descendant both ignore SIGTERM, so the runner must
    // escalate to SIGKILL before the whole group can exit.
    const start = () => spawn("bash", ["-c", `trap '' TERM; sleep 30 & echo $! > ${marker}; wait`], {
      detached: true,
      stdio: "ignore",
    });
    const runner = createProcessPrdSplitter({
      model: "planner-model",
      timeoutMilliseconds: 100,
      graceMilliseconds: 100,
      start,
    });

    await expect(runner.split({
      prdNumber: 223,
      title: "Vault bridge PRD",
      checkoutPath: "/jobs/prd-split-223",
    })).rejects.toThrow("PRD split execution timed out");

    const descendant = Number(readFileSync(marker, "utf8"));
    rmSync(marker, { force: true });
    await expectDescendantDead(descendant);
  });

  it("runs the PRD split worker and parses its slices", async () => {
    const process = child(540);
    const start = vi.fn().mockReturnValue(process);
    const runner = createProcessPrdSplitter({
      model: "planner-model",
      start,
      groupExited: async () => {},
    });
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

  it("terminates the worker process group, forces it after grace, and waits for close", async () => {
    const process = child(541);
    let groupExit!: () => void;
    const groupExited = new Promise<void>((resolve) => { groupExit = resolve; });
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        process.emit("close", null);
        groupExit();
      }
    });
    const runner = createProcessPrdSplitter({
      model: "planner-model",
      timeoutMilliseconds: 0,
      graceMilliseconds: 0,
      start: vi.fn().mockReturnValue(process),
      kill,
      groupExited: () => groupExited,
      wait: async () => {},
    });

    await expect(runner.split({
      prdNumber: 223,
      title: "Vault bridge PRD",
      checkoutPath: "/jobs/prd-split-223",
    })).rejects.toThrow("PRD split execution timed out");

    expect(kill).toHaveBeenNthCalledWith(1, -541, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, -541, "SIGKILL");
  });

  it("fails with the worker diagnostics when the worker exits unsuccessfully", async () => {
    const process = child(542);
    const runner = createProcessPrdSplitter({
      model: "planner-model",
      start: vi.fn().mockReturnValue(process),
      groupExited: async () => {},
    });
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
