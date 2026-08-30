import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkerProcessLifecycle,
  type WorkerProcessLifecycleOutcome,
} from "../.sandcastle/worker-process-lifecycle.js";
import { INHERITED_JOB_PROCESS_GROUP } from "../.sandcastle/worker-process.js";

interface FakeChild extends ChildProcess, EventEmitter {
  readonly stdin: EventEmitter & { end(input?: string): void };
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
}

function child(pid?: number): FakeChild {
  const actualPid = arguments.length === 0 ? 401 : pid;
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.end = () => {};
  const process = new EventEmitter() as FakeChild;
  Object.defineProperties(process, {
    pid: { configurable: true, value: actualPid },
    stdin: { configurable: true, value: stdin },
    stdout: { configurable: true, value: new EventEmitter() },
    stderr: { configurable: true, value: new EventEmitter() },
  });
  return process;
}

function completed(
  lifecycle: ReturnType<typeof createWorkerProcessLifecycle>,
  process: FakeChild,
  options: Omit<Parameters<ReturnType<typeof createWorkerProcessLifecycle>["run"]>[0], "launch">,
): Promise<WorkerProcessLifecycleOutcome> {
  const running = lifecycle.run({ ...options, launch: (admit) => admit(process) });
  process.emit("close", 0);
  return running;
}

function expectNoLifecycleListeners(process: FakeChild): void {
  expect(process.eventNames()).toEqual([]);
  expect(process.stdin.eventNames()).toEqual([]);
  expect(process.stdout.eventNames()).toEqual([]);
  expect(process.stderr.eventNames()).toEqual([]);
}

async function eventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const inheritedMarker = process.env[INHERITED_JOB_PROCESS_GROUP];

afterEach(() => {
  if (inheritedMarker === undefined) delete process.env[INHERITED_JOB_PROCESS_GROUP];
  else process.env[INHERITED_JOB_PROCESS_GROUP] = inheritedMarker;
});

describe("worker process lifecycle", () => {
  it("installs capture and completion listeners before delivering startup", async () => {
    const process = child();
    const order: string[] = [];
    process.stdin.end = (input) => {
      order.push(`stdin:${input}`);
      process.stdout.emit("data", "early output");
      process.stderr.emit("data", "early diagnostics");
      process.emit("close", 0);
    };

    const result = await createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      startup: "trusted startup",
      launch: (admit) => {
        order.push("launch");
        admit(process);
        order.push("admitted");
      },
    });

    expect(order).toEqual(["launch", "admitted", "stdin:trusted startup"]);
    expect(result).toEqual({
      status: "completed",
      stdout: "early output",
      stderr: "early diagnostics",
      code: 0,
    });
  });

  it("captures all stdout and stderr chunks without truncation", async () => {
    const process = child();
    const lifecycle = createWorkerProcessLifecycle();
    const running = lifecycle.run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(process),
    });
    process.stdout.emit("data", "first ");
    process.stderr.emit("data", Buffer.from("problem "));
    process.stdout.emit("data", Buffer.from("second"));
    process.stderr.emit("data", "details");
    process.emit("close", 3);

    await expect(running).resolves.toEqual({
      status: "completed",
      stdout: "first second",
      stderr: "problem details",
      code: 3,
    });
  });

  it.each([0, 9, null] as const)("returns the raw exit code %s", async (code) => {
    const process = child();
    const running = createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(process),
    });
    process.emit("close", code);

    await expect(running).resolves.toMatchObject({ status: "completed", code });
  });

  it("supports absent stdin without turning it into a startup failure", async () => {
    const process = child();
    Object.defineProperty(process, "stdin", { value: null });

    await expect(completed(createWorkerProcessLifecycle(), process, {
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      startup: "trusted startup",
    })).resolves.toMatchObject({ status: "completed", code: 0 });
  });

  it("rejects launch, PID, child event, stdin, and stream infrastructure failures", async () => {
    const lifecycle = createWorkerProcessLifecycle();
    await expect(lifecycle.run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: () => { throw new Error("launch failed"); },
    })).rejects.toThrow("launch failed");

    await expect(lifecycle.run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(child(undefined)),
    })).rejects.toThrow("Worker process did not expose a process ID");

    globalThis.process.env[INHERITED_JOB_PROCESS_GROUP] = "1";
    await expect(lifecycle.run({
      role: "nested",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(child(undefined)),
    })).rejects.toThrow("Worker process did not expose a process ID");

    const eventFailure = child();
    const eventRunning = lifecycle.run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(eventFailure),
    });
    eventFailure.emit("error", new Error("child failed"));
    await expect(eventRunning).rejects.toThrow("child failed");

    const stdinFailure = child();
    stdinFailure.stdin.end = () => { throw new Error("stdin failed"); };
    await expect(lifecycle.run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      startup: "input",
      launch: (admit) => admit(stdinFailure),
    })).rejects.toThrow("stdin failed");

    const streamFailure = child();
    Object.defineProperty(streamFailure, "stdout", { value: { on: () => { throw new Error("stream failed"); } } });
    await expect(lifecycle.run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(streamFailure),
    })).rejects.toThrow("stream failed");
  });

  it("settles output observation when launch fails after admitting a child", async () => {
    const process = child(undefined);

    await expect(createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => {
        admit(process);
        throw new Error("launch failed after admission");
      },
    })).rejects.toThrow("launch failed after admission");

    expectNoLifecycleListeners(process);
  });

  it("records the first output-sink failure while continuing output capture", async () => {
    const process = child();
    const sink = vi.fn((stream: "stdout" | "stderr", chunk: Buffer | string) => {
      if (stream === "stdout" && String(chunk) === "first") throw new Error("log unavailable");
    });
    const running = createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      outputSink: sink,
      launch: (admit) => admit(process),
    });
    process.stdout.emit("data", "first");
    process.stderr.emit("data", "second");
    process.stdout.emit("data", "third");
    process.emit("close", 0);

    await expect(running).resolves.toEqual({
      status: "completed",
      stdout: "firstthird",
      stderr: "second",
      code: 0,
      outputSinkError: expect.objectContaining({ message: "log unavailable" }),
    });
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("derives inherited nested behavior from the trusted environment", async () => {
    globalThis.process.env[INHERITED_JOB_PROCESS_GROUP] = "1";
    const childProcess = child(402);
    const probe = vi.fn();
    const kill = vi.fn();
    const dispositions: unknown[] = [];
    const running = createWorkerProcessLifecycle({ probeGroup: probe, kill }).run({
      role: "nested",
      timeoutMilliseconds: 0,
      graceMilliseconds: 0,
      launch: (admit, disposition) => {
        dispositions.push(disposition);
        admit(childProcess);
      },
    });
    childProcess.emit("close", 0);

    await expect(running).resolves.toMatchObject({ status: "completed", code: 0 });
    expect(dispositions).toEqual([{ detached: false, inherited: true }]);
    expect(probe).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(["owner", "nested"] as const)("creates a bounded group for standalone %s execution", async (role) => {
    delete globalThis.process.env[INHERITED_JOB_PROCESS_GROUP];
    const childProcess = child();
    const dispositions: unknown[] = [];
    const running = createWorkerProcessLifecycle().run({
      role,
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit, disposition) => {
        dispositions.push(disposition);
        admit(childProcess);
      },
    });
    childProcess.emit("close", 0);

    await expect(running).resolves.toMatchObject({ status: "completed", code: 0 });
    expect(dispositions).toEqual([{ detached: true, inherited: false }]);
  });

  it("waits for graceful group cleanup before reporting a timeout", async () => {
    const process = child(408);
    let exitGroup!: () => void;
    const groupExited = new Promise<void>((resolve) => { exitGroup = resolve; });
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        process.emit("close", null);
        exitGroup();
      }
    });
    const lifecycle = createWorkerProcessLifecycle({
      groupExited: () => groupExited,
      kill,
      wait: async () => {},
    });

    await expect(lifecycle.run({
      role: "owner",
      timeoutMilliseconds: 0,
      graceMilliseconds: 0,
      launch: (admit) => admit(process),
    })).resolves.toEqual({ status: "timed-out" });
    expect(kill).toHaveBeenCalledWith(-408, "SIGTERM");
  });

  it("forces a timed-out group and confirms exit before returning", async () => {
    const process = child(409);
    let exitGroup!: () => void;
    const groupExited = new Promise<void>((resolve) => { exitGroup = resolve; });
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        process.emit("close", null);
        exitGroup();
      }
    });
    const lifecycle = createWorkerProcessLifecycle({
      groupExited: () => groupExited,
      kill,
      wait: async () => {},
    });

    await expect(lifecycle.run({
      role: "owner",
      timeoutMilliseconds: 0,
      graceMilliseconds: 0,
      launch: (admit) => admit(process),
    })).resolves.toEqual({ status: "timed-out" });
    expect(kill).toHaveBeenNthCalledWith(1, -409, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, -409, "SIGKILL");
  });

  it("cleans up descendants after direct child completion before completing", async () => {
    const process = child(410);
    let exitGroup!: () => void;
    const groupExited = new Promise<void>((resolve) => { exitGroup = resolve; });
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") exitGroup();
    });
    const lifecycle = createWorkerProcessLifecycle({
      groupExited: () => groupExited,
      kill,
      wait: async () => {},
    });
    const running = lifecycle.run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 0,
      launch: (admit) => admit(process),
    });
    process.emit("close", 0);

    await expect(running).resolves.toMatchObject({ status: "completed", code: 0 });
    expect(kill).toHaveBeenNthCalledWith(1, -410, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, -410, "SIGKILL");
  });

  it("treats only ESRCH as a missing process group", async () => {
    const gone = child(411);
    await expect(completed(createWorkerProcessLifecycle({
      probeGroup: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    }), gone, {
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
    })).resolves.toMatchObject({ status: "completed", code: 0 });

    const denied = child(412);
    const running = createWorkerProcessLifecycle({
      probeGroup: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
    }).run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(denied),
    });
    denied.emit("close", 0);
    await expect(running).rejects.toThrow("denied");
  });

  it("observes an early EPERM group-probe failure while the child remains running", async () => {
    const process = child(413);
    const running = createWorkerProcessLifecycle({
      probeGroup: () => { throw Object.assign(new Error("probe denied"), { code: "EPERM" }); },
    }).run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(process),
    });
    const rejected = expect(running).rejects.toThrow("probe denied");

    await eventLoopTurn();

    await rejected;
    expectNoLifecycleListeners(process);
  });

  it("admits exactly one child and rejects launch completion without admission", async () => {
    const admitted = child(414);
    const duplicate = child(415);
    await expect(createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => {
        admit(admitted);
        admit(duplicate);
      },
    })).rejects.toThrow("Worker process was admitted more than once");
    expectNoLifecycleListeners(admitted);
    expectNoLifecycleListeners(duplicate);

    await expect(createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: () => {},
    })).rejects.toThrow("Worker process was not admitted");
  });

  it.each([
    ["exact payload", "exact payload"],
    ["no payload", undefined],
  ] as const)("closes stdin after delivering %s", async (_case, startup) => {
    const process = child(416);
    const end = vi.fn((input?: string) => process.emit("close", 0));
    process.stdin.end = end;

    await expect(createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      ...(startup === undefined ? {} : { startup }),
      launch: (admit) => admit(process),
    })).resolves.toMatchObject({ status: "completed", code: 0 });

    expect(end).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith(startup);
    expectNoLifecycleListeners(process);
  });

  it("removes every installed listener after exit then close and close-only completion", async () => {
    for (const events of [["exit", "close"], ["close"]] as const) {
      const process = child(417);
      const running = createWorkerProcessLifecycle().run({
        role: "owner",
        timeoutMilliseconds: 1_000,
        graceMilliseconds: 1,
        launch: (admit) => admit(process),
      });
      for (const event of events) process.emit(event, 0);

      await expect(running).resolves.toMatchObject({ status: "completed", code: 0 });
      expectNoLifecycleListeners(process);
    }
  });

  it("removes every installed listener on child, stdin, and stream failures", async () => {
    const childFailure = child(418);
    const childRunning = createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(childFailure),
    });
    childFailure.emit("error", new Error("child failed"));
    await expect(childRunning).rejects.toThrow("child failed");
    expectNoLifecycleListeners(childFailure);

    const stdinFailure = child(419);
    stdinFailure.stdin.end = () => { throw new Error("stdin failed"); };
    await expect(createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(stdinFailure),
    })).rejects.toThrow("stdin failed");
    expectNoLifecycleListeners(stdinFailure);

    for (const stream of ["stdin", "stdout", "stderr"] as const) {
      const streamFailure = child(420);
      const running = createWorkerProcessLifecycle().run({
        role: "owner",
        timeoutMilliseconds: 1_000,
        graceMilliseconds: 1,
        launch: (admit) => admit(streamFailure),
      });
      streamFailure[stream].emit("error", new Error(`${stream} failed`));
      await expect(running).rejects.toThrow(`${stream} failed`);
      expectNoLifecycleListeners(streamFailure);
    }
  });

  it("removes listeners after missing PID and synchronous stream setup failure", async () => {
    const missingPid = child(undefined);
    await expect(createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(missingPid),
    })).rejects.toThrow("Worker process did not expose a process ID");
    expectNoLifecycleListeners(missingPid);

    const streamFailure = child(421);
    Object.defineProperty(streamFailure, "stdout", {
      value: { on: () => { throw new Error("stream setup failed"); } },
    });
    await expect(createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(streamFailure),
    })).rejects.toThrow("stream setup failed");
    expect(streamFailure.eventNames()).toEqual([]);
    expect(streamFailure.stdin.eventNames()).toEqual([]);
    expect(streamFailure.stderr.eventNames()).toEqual([]);
  });

  it("settles competing child terminal events once and leaves no lifecycle work", async () => {
    const process = child(422);
    const running = createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(process),
    });
    process.emit("exit", 0);
    process.emit("close", 0);
    process.emit("close", 9);

    await expect(running).resolves.toMatchObject({ status: "completed", code: 0 });
    expectNoLifecycleListeners(process);
  });

  it("cancels deadline, grace, and group polling work after settlement", async () => {
    vi.useFakeTimers();
    try {
      const completedProcess = child(423);
      const cancelGrace = vi.fn();
      const completed = createWorkerProcessLifecycle({
        groupExited: () => Promise.resolve(),
        wait: () => ({ completed: new Promise<void>(() => {}), cancel: cancelGrace }),
      }).run({
        role: "owner",
        timeoutMilliseconds: 1_000,
        graceMilliseconds: 100,
        launch: (admit) => admit(completedProcess),
      });
      completedProcess.emit("close", 0);
      await expect(completed).resolves.toMatchObject({ status: "completed", code: 0 });
      expect(cancelGrace).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);

      vi.useRealTimers();
      const failedProcess = child(424);
      let groupPresent = true;
      const probe = vi.fn(() => {
        if (!groupPresent) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
      const failed = createWorkerProcessLifecycle({
        probeGroup: probe,
        kill: () => { groupPresent = false; },
        wait: async () => {},
      }).run({
        role: "owner",
        timeoutMilliseconds: 1_000,
        graceMilliseconds: 1,
        launch: (admit) => admit(failedProcess),
      });
      failedProcess.emit("error", new Error("child failed"));
      await expect(failed).rejects.toThrow("child failed");
      const probesAfterSettlement = probe.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(probe).toHaveBeenCalledTimes(probesAfterSettlement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for an ignoring POSIX descendant after its leader exits", async () => {
    const marker = join(tmpdir(), `worker-lifecycle-descendant-${process.pid}-${Date.now()}.pid`);
    const lifecycle = createWorkerProcessLifecycle({
      wait: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    try {
      const result = await lifecycle.run({
        role: "owner",
        timeoutMilliseconds: 5_000,
        graceMilliseconds: 50,
        launch: (admit, disposition) => admit(spawn("bash", ["-c", `trap '' TERM; sleep 30 & echo $! > ${marker}; exit 0`], {
          detached: disposition.detached,
          stdio: ["ignore", "pipe", "pipe"],
        })),
      });

      expect(result).toMatchObject({ status: "completed", code: 0 });
      const descendant = Number(readFileSync(marker, "utf8"));
      expect(() => process.kill(descendant, 0)).toThrow();
    } finally {
      rmSync(marker, { force: true });
    }
  });
});
