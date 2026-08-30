import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runAgentWorker, workerJson } from "../.sandcastle/agent-process-runner.js";

function child(pid: number): ChildProcess & EventEmitter {
  const process = new EventEmitter() as ChildProcess & EventEmitter;
  Object.defineProperties(process, {
    pid: { value: pid },
    stdin: { value: { end: vi.fn() } },
    stdout: { value: new EventEmitter() },
    stderr: { value: new EventEmitter() },
  });
  return process;
}

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
  describe("worker JSON protocol", () => {
    it("rejects malformed trailing worker output without exposing it", () => {
      const secret = "issue-359-secret-marker";

      try {
        workerJson<{ readonly accepted: boolean }>({
          code: 0,
          output: `${JSON.stringify({ accepted: true })}\n{\"token\":\"${secret}`,
          diagnostics: "",
        }, "fixture");
        throw new Error("Expected malformed worker output to be rejected");
      } catch (error) {
        expect(error).toHaveProperty("message", "fixture worker returned invalid JSON");
        expect(String(error)).not.toContain(secret);
      }
    });

    it("parses only the last stdout line for valid worker output", () => {
      expect(workerJson<{ readonly accepted: boolean }>({
        code: 0,
        output: "worker progress\n" + JSON.stringify({ accepted: true }),
        diagnostics: "",
      }, "fixture")).toEqual({ accepted: true });
    });

    it("keeps established missing-result and worker-exit failures", () => {
      expect(() => workerJson({
        code: 0,
        output: " \n ",
        diagnostics: "",
      }, "fixture")).toThrow("fixture worker did not return a result");
      expect(() => workerJson({
        code: 3,
        output: "ignored",
        diagnostics: "worker failure",
      }, "fixture")).toThrow("fixture worker exited with 3: worker failure");
      expect(() => workerJson({
        code: null,
        output: "ignored",
        diagnostics: "terminated",
      }, "fixture")).toThrow("fixture worker exited with signal: terminated");
    });

    it("carries a trusted public summary alongside untrusted exit diagnostics", () => {
      const encoded = "ZmFrZS1zZWNyZXQtZm9yLWlzc3VlLTM1OQ==";

      try {
        workerJson({
          code: 3,
          output: "ignored",
          diagnostics: `setup failed ${encoded}`,
        }, "fixture");
        throw new Error("Expected worker exit to be rejected");
      } catch (error) {
        expect(error).toHaveProperty(
          "message",
          `fixture worker exited with 3: setup failed ${encoded}`,
        );
        expect(error).toHaveProperty("publicSummary", "fixture worker exited with 3");
      }

      try {
        workerJson({ code: null, output: "ignored", diagnostics: "terminated" }, "fixture");
        throw new Error("Expected worker exit to be rejected");
      } catch (error) {
        expect(error).toHaveProperty("message", "fixture worker exited with signal: terminated");
        expect(error).toHaveProperty("publicSummary", "fixture worker exited with signal");
      }
    });
  });

  it("rejects a whole job through the normal lifecycle when log appending fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-log-append-failure-"));
    const logDirectory = join(root, "stdout.log");
    mkdirSync(logDirectory);
    const process = child(601);
    const running = runAgentWorker({
      checkoutPath: "unused",
      workerFile: "unused.ts",
      workerName: "fixture",
      arguments_: [],
      timeoutMessage: "Fixture worker timed out",
      start: () => process,
      processGroupOwner: true,
      inheritedEnvironment: {
        SANDCASTLE_JOB_STDOUT_LOG: logDirectory,
      },
      groupExited: async () => {},
    });

    try {
      expect(() => process.stdout?.emit("data", "worker output\n")).not.toThrow();
      process.emit("close", 1);
      await expect(running).rejects.toMatchObject({ code: "EISDIR" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it("attaches a nested worker to its inherited whole-job process group", async () => {
    const previous = process.env.SANDCASTLE_INHERITED_JOB_PROCESS_GROUP;
    process.env.SANDCASTLE_INHERITED_JOB_PROCESS_GROUP = "1";
    const checkoutPath = mkdtempSync(join(tmpdir(), "nested-worker-"));
    const workerDirectory = join(checkoutPath, ".sandcastle");
    mkdirSync(workerDirectory);
    writeFileSync(join(workerDirectory, "fixture-worker.ts"), 'process.stdout.write("nested");\n');
    const kill = vi.fn();

    try {
      await expect(runAgentWorker({
        checkoutPath,
        workerFile: "fixture-worker.ts",
        workerName: "fixture",
        arguments_: [],
        timeoutMessage: "Fixture worker timed out",
        timeoutMilliseconds: 1,
        kill,
      })).resolves.toMatchObject({ code: 0, output: "nested" });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.SANDCASTLE_INHERITED_JOB_PROCESS_GROUP;
      else process.env.SANDCASTLE_INHERITED_JOB_PROCESS_GROUP = previous;
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
