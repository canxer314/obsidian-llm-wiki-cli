import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runContainerCommand } from "../src/local-stage.js";

function fakeChild(): ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
    kill: ReturnType<typeof vi.fn>;
  };
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}

const command = {
  file: "docker" as const,
  args: ["run", "image"],
  stdin: "complete prompt",
  timeoutMs: 1_000,
  environment: {},
  redactedEnvironment: {},
};

describe("implementation container process adapter", () => {
  it("writes the prompt and captures complete stdout and stderr", async () => {
    const child = fakeChild();
    let received = "";
    child.stdin.on("data", (chunk) => { received += chunk.toString(); });
    const running = runContainerCommand(command, () => child);
    child.stdout.write("implementation narrative");
    child.stderr.write("diagnostic");
    child.emit("close", 0);

    await expect(running).resolves.toEqual({
      exitCode: 0,
      stdout: "implementation narrative",
      stderr: "diagnostic",
    });
    expect(received).toBe("complete prompt");
  });

  it("kills a process that exceeds the configured timeout", async () => {
    const child = fakeChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    });

    await expect(runContainerCommand({ ...command, timeoutMs: 1 }, () => child))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
