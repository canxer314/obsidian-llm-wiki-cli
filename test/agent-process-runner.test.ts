import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("loads the fixed worker from the authorized Target Checkout", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "authorized-worker-"));
    const workerDirectory = join(checkoutPath, ".sandcastle");
    mkdirSync(workerDirectory);
    writeFileSync(
      join(workerDirectory, "fixture-worker.ts"),
      'process.stdout.write(JSON.stringify({ source: "authorized-checkout" }));\n',
    );

    try {
      await expect(runAgentWorker({
        checkoutPath,
        workerFile: "fixture-worker.ts",
        workerName: "fixture",
        arguments_: [],
        timeoutMessage: "Fixture worker timed out",
      })).resolves.toMatchObject({
        code: 0,
        output: JSON.stringify({ source: "authorized-checkout" }),
      });
    } finally {
      rmSync(checkoutPath, { force: true, recursive: true });
    }
  });

  it("passes an immutable startup snapshot through worker stdin", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "snapshot-worker-"));
    const workerDirectory = join(checkoutPath, ".sandcastle");
    mkdirSync(workerDirectory);
    writeFileSync(
      join(workerDirectory, "fixture-worker.ts"),
      'let input = ""; for await (const chunk of process.stdin) input += chunk; process.stdout.write(input);\n',
    );

    try {
      await expect(runAgentWorker({
        checkoutPath,
        workerFile: "fixture-worker.ts",
        workerName: "fixture",
        arguments_: [],
        input: JSON.stringify({ snapshot: "round-one" }),
        timeoutMessage: "Fixture worker timed out",
      })).resolves.toMatchObject({
        code: 0,
        output: JSON.stringify({ snapshot: "round-one" }),
      });
    } finally {
      rmSync(checkoutPath, { force: true, recursive: true });
    }
  });

  it("terminates a TERM-ignoring descendant after its successful leader exits", async () => {
    const marker = join(tmpdir(), `agent-successful-leader-descendant-${process.pid}.pid`);
    const script = [
      `bash -c 'trap "" TERM; sleep 30' </dev/null >/dev/null 2>&1 &`,
      `echo $! > "${marker}"`,
      "exit 0",
    ].join(" ");

    try {
      await expect(runAgentWorker({
        checkoutPath: "unused",
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
