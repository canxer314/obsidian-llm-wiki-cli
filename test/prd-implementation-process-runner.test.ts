import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createProcessPrdImplementer } from "../.sandcastle/prd-implementation-process-runner.js";

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

describe("PRD implementation process runner", () => {
  it("kills a real descendant process tree after a graceful-then-forced group termination", async () => {
    const marker = join(tmpdir(), `prd-implementation-descendant-${process.pid}.pid`);
    // The leader and its descendant both ignore SIGTERM, so the runner must
    // escalate to SIGKILL before the whole group can exit.
    const start = () => spawn("bash", ["-c", `trap '' TERM; sleep 30 & echo $! > ${marker}; wait`], {
      detached: true,
      stdio: "ignore",
    });
    const runner = createProcessPrdImplementer({
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      timeoutMilliseconds: 100,
      graceMilliseconds: 100,
      start,
    });

    await expect(runner.implement({
      prdNumber: 226,
      child: { number: 301, title: "Slice one" },
      branch: "sandcastle/prd-226",
      baseRevision: revision,
      checkoutPath: "/jobs/prd-implementation-226",
    })).rejects.toThrow("PRD implementation execution timed out");

    const descendant = Number(readFileSync(marker, "utf8"));
    rmSync(marker, { force: true });
    await expectDescendantDead(descendant);
  });

  it("runs the PRD implementation worker and parses its committed result", async () => {
    const process = child(520);
    const start = vi.fn().mockReturnValue(process);
    const runner = createProcessPrdImplementer({
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      start,    });
    const implemented = runner.implement({
      prdNumber: 226,
      child: { number: 301, title: "Slice one" },
      branch: "sandcastle/prd-226",
      baseRevision: revision,
      checkoutPath: "/jobs/prd-implementation-226",
    });
    process.stdout?.emit("data", `${JSON.stringify({ branch: "sandcastle/prd-226", headSha })}\n`);
    process.emit("close", 0);

    await expect(implemented).resolves.toEqual({ branch: "sandcastle/prd-226", headSha });
    expect(start).toHaveBeenCalledWith([
      "226",
      "301",
      "sandcastle/prd-226",
      revision,
      "/jobs/prd-implementation-226",
      "planner-model",
      "implementer-model",
    ]);
  });

  it("fails with the worker diagnostics when the worker exits unsuccessfully", async () => {
    const process = child(522);
    const runner = createProcessPrdImplementer({
      plannerModel: "planner-model",
      implementerModel: "implementer-model",
      start: vi.fn().mockReturnValue(process),    });
    const implemented = runner.implement({
      prdNumber: 226,
      child: { number: 301, title: "Slice one" },
      branch: "sandcastle/prd-226",
      baseRevision: revision,
      checkoutPath: "/jobs/prd-implementation-226",
    });
    process.stderr?.emit("data", "Planner did not return a valid structured plan");
    process.emit("close", 1);

    await expect(implemented).rejects.toThrow(
      "PRD implementation worker exited with 1: Planner did not return a valid structured plan",
    );
  });
});
