import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runAgentWorker } from "../.sandcastle/agent-process-runner.js";

async function expectProcessDead(pid: number): Promise<void> {
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

describe("agent process runner", () => {
  it("terminates a TERM-ignoring descendant after its successful leader exits", async () => {
    const marker = join(tmpdir(), `agent-successful-leader-descendant-${process.pid}.pid`);
    const script = [
      `bash -c 'trap "" TERM; sleep 30' </dev/null >/dev/null 2>&1 &`,
      `echo $! > "${marker}"`,
      "exit 0",
    ].join(" ");

    try {
      await expect(runAgentWorker({
        workerFile: "unused.ts",
        workerName: "test",
        arguments_: [],
        timeoutMessage: "Agent execution timed out",
        timeoutMilliseconds: 1_000,
        graceMilliseconds: 100,
        start: () => spawn("bash", ["-c", script], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      })).resolves.toMatchObject({ code: 0 });

      await expectProcessDead(Number(readFileSync(marker, "utf8")));
    } finally {
      try {
        process.kill(Number(readFileSync(marker, "utf8")), "SIGKILL");
      } catch {
        // The assertion path normally leaves no process to clean up.
      }
      rmSync(marker, { force: true });
    }
  });
});
