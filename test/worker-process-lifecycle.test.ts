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

async function realIgnoringGroup(): Promise<ChildProcess> {
  const script = String.raw`
    const { spawn } = require("node:child_process");
    process.on("SIGTERM", () => {});
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    descendant.once("spawn", () => process.stdout.write("ready\\n"));
    setInterval(() => {}, 1000);
  `;
  const childProcess = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.stdout!.once("data", () => resolve());
  });
  return childProcess;
}

function groupIsPresent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function expectRealGroupAbsent(process: ChildProcess): Promise<void> {
  const pid = process.pid!;
  try {
    expect(groupIsPresent(pid)).toBe(false);
  } finally {
    if (groupIsPresent(pid)) process.kill(-pid, "SIGKILL");
  }
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

  it("decodes UTF-8 code points split across two and three Buffer chunks on both streams", async () => {
    const process = child();
    const running = createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      launch: (admit) => admit(process),
    });
    const twoChunks = Buffer.from("你");
    const threeChunks = Buffer.from("好");
    for (const stream of [process.stdout, process.stderr]) {
      stream.emit("data", twoChunks.subarray(0, 1));
      stream.emit("data", twoChunks.subarray(1));
      stream.emit("data", threeChunks.subarray(0, 1));
      stream.emit("data", threeChunks.subarray(1, 2));
      stream.emit("data", threeChunks.subarray(2));
    }
    process.emit("close", 0);

    await expect(running).resolves.toMatchObject({
      stdout: "你好",
      stderr: "你好",
    });
  });

  it("preserves mixed string and Buffer order while delivering raw chunks to the sink", async () => {
    const process = child();
    const first = Buffer.from("你");
    const last = Buffer.from("好");
    const chunks: Array<readonly ["stdout" | "stderr", Buffer | string]> = [];
    const running = createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      outputSink: (stream, chunk) => chunks.push([stream, chunk]),
      launch: (admit) => admit(process),
    });
    process.stdout.emit("data", first.subarray(0, 1));
    process.stdout.emit("data", first.subarray(1));
    process.stdout.emit("data", " between ");
    process.stdout.emit("data", last);
    process.emit("close", 0);

    await expect(running).resolves.toMatchObject({ stdout: "你 between 好" });
    expect(chunks).toEqual([
      ["stdout", first.subarray(0, 1)],
      ["stdout", first.subarray(1)],
      ["stdout", " between "],
      ["stdout", last],
    ]);
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

  it.each(["child", "stdin", "stdout", "stderr"] as const)(
    "aborts startup delivery when %s listener registration fails",
    async (target) => {
      const process = child(432);
      const startup = vi.fn();
      process.stdin.end = startup;
      const emitter = target === "child" ? process : process[target];
      const registration = target === "stdout" || target === "stderr" ? "on" : "once";
      const original = emitter[registration];
      emitter[registration] = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
        const failingEvent = target === "child" ? "exit" : target === "stdin" ? "error" : "data";
        if (event === failingEvent) throw new Error(`${target} listener setup failed before startup`);
        return original.call(emitter, event, listener);
      }) as typeof original;
      let confirmGroupExit!: () => void;
      const groupExited = new Promise<void>((resolve) => { confirmGroupExit = resolve; });
      const signals: NodeJS.Signals[] = [];
      const running = createWorkerProcessLifecycle({
        groupExited: () => groupExited,
        kill: (_pid, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") confirmGroupExit();
        },
        wait: async () => {},
      }).run({
        role: "owner",
        timeoutMilliseconds: 1_000,
        graceMilliseconds: 0,
        startup: "trusted startup",
        launch: (admit) => admit(process),
      });

      await expect(running).rejects.toThrow(`${target} listener setup failed before startup`);
      expect(startup).not.toHaveBeenCalled();
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expectNoLifecycleListeners(process);
    },
  );

  it("rejects inherited listener setup without startup delivery or shared-group cleanup", async () => {
    globalThis.process.env[INHERITED_JOB_PROCESS_GROUP] = "1";
    const process = child(433);
    const startup = vi.fn();
    process.stdin.end = startup;
    const stderr = process.stderr;
    stderr.once = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "error") throw new Error("nested listener setup failed");
      return EventEmitter.prototype.once.call(stderr, event, listener);
    }) as typeof stderr.once;
    const kill = vi.fn();
    const probeGroup = vi.fn();

    await expect(createWorkerProcessLifecycle({ kill, probeGroup }).run({
      role: "nested",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      startup: "trusted startup",
      launch: (admit) => admit(process),
    })).rejects.toThrow("nested listener setup failed");

    expect(startup).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(probeGroup).not.toHaveBeenCalled();
    expectNoLifecycleListeners(process);
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

  it.each([
    ["stdin", (admit: (process: ChildProcess) => void, process: FakeChild) => {
      process.stdin.end = () => { throw new Error("stdin failed after admission"); };
      admit(process);
    }, "stdin failed after admission"],
    ["launch", (admit: (process: ChildProcess) => void, process: FakeChild) => {
      admit(process);
      throw new Error("launch failed after admission");
    }, "launch failed after admission"],
  ] as const)("cleans up an owned group before reporting a synchronous post-admission %s failure", async (
    _failure,
    launch,
    message,
  ) => {
    const process = child(425);
    let groupPresent = true;
    const signals: NodeJS.Signals[] = [];
    const lifecycle = createWorkerProcessLifecycle({
      probeGroup: () => {
        if (!groupPresent) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
      kill: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          groupPresent = false;
          process.emit("close", null);
        }
      },
      wait: async () => {},
    });

    await expect(lifecycle.run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 0,
      startup: "trusted input",
      launch: (admit) => launch(admit, process),
    })).rejects.toThrow(message);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(groupPresent).toBe(false);
    expectNoLifecycleListeners(process);
  });

  it("does not clean up the shared group after an inherited post-admission failure", async () => {
    globalThis.process.env[INHERITED_JOB_PROCESS_GROUP] = "1";
    const process = child(426);
    process.stdin.end = () => { throw new Error("nested stdin failed"); };
    const kill = vi.fn();
    const probeGroup = vi.fn();

    await expect(createWorkerProcessLifecycle({ kill, probeGroup }).run({
      role: "nested",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      startup: "trusted input",
      launch: (admit) => admit(process),
    })).rejects.toThrow("nested stdin failed");

    expect(kill).not.toHaveBeenCalled();
    expect(probeGroup).not.toHaveBeenCalled();
    expectNoLifecycleListeners(process);
  });

  it("confirms owned-group cleanup after synchronous observation construction fails", async () => {
    const process = child(431);
    const setupFailure = new Error("observation setup failed");
    let observationCount = 0;
    let confirmGroupExit!: () => void;
    const confirmation = new Promise<void>((resolve) => { confirmGroupExit = resolve; });
    const signals: NodeJS.Signals[] = [];
    const running = createWorkerProcessLifecycle({
      groupExited: () => {
        if (observationCount++ === 0) throw setupFailure;
        return confirmation;
      },
      kill: (_pid, signal) => { signals.push(signal); },
      wait: async () => {},
    }).run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 0,
      launch: (admit) => admit(process),
    });
    let settled = false;
    void running.finally(() => { settled = true; }).catch(() => undefined);

    await eventLoopTurn();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(observationCount).toBe(2);
    expect(settled).toBe(false);

    confirmGroupExit();
    await expect(running).rejects.toBe(setupFailure);
    expectNoLifecycleListeners(process);
  });

  it("renews failed group polling and confirms absence before reporting a child failure", async () => {
    vi.useFakeTimers();
    try {
      const process = child(430);
      const childFailure = new Error("child failed before polling failed");
      const probeFailure = Object.assign(new Error("probe denied during cleanup"), {
        code: "EPERM",
      });
      const signals: NodeJS.Signals[] = [];
      let probeCount = 0;
      let groupPresent = true;
      let releaseGrace!: () => void;
      const grace = new Promise<void>((resolve) => { releaseGrace = resolve; });
      const running = createWorkerProcessLifecycle({
        probeGroup: () => {
          probeCount += 1;
          if (probeCount === 2) throw probeFailure;
          if (!groupPresent) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        },
        kill: (_pid, signal) => { signals.push(signal); },
        wait: () => grace,
      }).run({
        role: "owner",
        timeoutMilliseconds: 1_000,
        graceMilliseconds: 100,
        launch: (admit) => admit(process),
      });
      let settled = false;
      const settlement = running.then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );

      process.emit("error", childFailure);
      await vi.advanceTimersByTimeAsync(0);
      expect(signals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(10);
      expect(probeCount).toBe(2);
      expect(settled).toBe(false);

      releaseGrace();
      await vi.advanceTimersByTimeAsync(0);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(probeCount).toBe(3);
      expect(settled).toBe(false);

      groupPresent = false;
      await vi.advanceTimersByTimeAsync(10);
      const failure = await settlement;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({ cause: childFailure });
      expect((failure as AggregateError).errors).toEqual([childFailure, probeFailure]);
      expectNoLifecycleListeners(process);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up an owned group before reporting a late probe failure after child completion", async () => {
    const process = child(428);
    let rejectInitialProbe!: (error: unknown) => void;
    const initialObservation = new Promise<void>((_resolve, reject) => {
      rejectInitialProbe = reject;
    });
    let groupPresent = true;
    let observationCount = 0;
    let confirmGroupExit!: () => void;
    const confirmation = new Promise<void>((resolve) => { confirmGroupExit = resolve; });
    const signals: NodeJS.Signals[] = [];
    const original = Object.assign(new Error("late probe denied"), { code: "EPERM" });
    let waitCount = 0;
    let releaseInitialGrace!: () => void;
    const initialGrace = new Promise<void>((resolve) => { releaseInitialGrace = resolve; });
    const running = createWorkerProcessLifecycle({
      groupExited: () => observationCount++ === 0 ? initialObservation : confirmation,
      kill: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          groupPresent = false;
          confirmGroupExit();
        }
      },
      wait: async () => {
        if (waitCount++ === 0) await initialGrace;
      },
    }).run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 0,
      launch: (admit) => admit(process),
    });
    process.emit("close", 0);
    await eventLoopTurn();
    rejectInitialProbe(original);
    await eventLoopTurn();
    expect(signals).toEqual([]);
    releaseInitialGrace();

    await expect(running).rejects.toBe(original);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(groupPresent).toBe(false);
    expect(observationCount).toBe(2);
    expectNoLifecycleListeners(process);
  });

  it("force-kills before failing closed when cleanup confirmation also rejects", async () => {
    const process = child(429);
    const original = Object.assign(new Error("probe denied"), { code: "EPERM" });
    const confirmation = Object.assign(new Error("confirmation denied"), { code: "EPERM" });
    let observationCount = 0;
    let groupPresent = true;
    const signals: NodeJS.Signals[] = [];
    const running = createWorkerProcessLifecycle({
      groupExited: () => Promise.reject(observationCount++ === 0 ? original : confirmation),
      kill: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") groupPresent = false;
      },
      wait: async () => {},
    }).run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 0,
      launch: (admit) => admit(process),
    });

    const failure = await running.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ cause: original });
    expect((failure as AggregateError).errors).toEqual([original, confirmation]);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(groupPresent).toBe(false);
  });

  it("fails closed with the original infrastructure error as cause when cleanup fails", async () => {
    const process = child(427);
    const original = Object.assign(new Error("probe denied"), { code: "EPERM" });
    const cleanup = Object.assign(new Error("signal denied"), { code: "EACCES" });

    const running = createWorkerProcessLifecycle({
      probeGroup: () => { throw original; },
      kill: () => { throw cleanup; },
      wait: async () => {},
    }).run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 0,
      launch: (admit) => admit(process),
    });

    const failure = await running.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ cause: original });
    const cleanupFailure = (failure as AggregateError).errors[1];
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    expect((cleanupFailure as AggregateError).errors).toEqual([original, cleanup]);
    expect(String(failure)).toContain("probe denied");
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

  it("records throw undefined as a present sink failure and stops later sink calls", async () => {
    const process = child();
    const sink = vi.fn(() => { throw undefined; });
    const running = createWorkerProcessLifecycle().run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 1,
      outputSink: sink,
      launch: (admit) => admit(process),
    });
    process.stdout.emit("data", "first");
    process.stderr.emit("data", "second");
    process.emit("close", 0);

    await expect(running).resolves.toEqual({
      status: "completed",
      stdout: "first",
      stderr: "second",
      code: 0,
      outputSinkError: undefined,
    });
    expect(sink).toHaveBeenCalledOnce();
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
    expect(dispositions).toEqual([{ role: "nested", detached: false, inherited: true }]);
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
    expect(dispositions).toEqual([{ role, detached: true, inherited: false }]);
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

  it("cleans up an owned group before reporting an early probe infrastructure failure", async () => {
    const process = child(413);
    let probeCount = 0;
    let groupPresent = true;
    const signals: NodeJS.Signals[] = [];
    const running = createWorkerProcessLifecycle({
      probeGroup: () => {
        probeCount += 1;
        if (probeCount === 1) {
          throw Object.assign(new Error("probe denied"), { code: "EPERM" });
        }
        if (!groupPresent) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
      kill: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          groupPresent = false;
          process.emit("close", null);
        }
      },
      wait: async () => {},
    }).run({
      role: "owner",
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 0,
      launch: (admit) => admit(process),
    });

    await expect(running).rejects.toThrow("probe denied");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(groupPresent).toBe(false);
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

  it("force-kills a real group before failing closed when every probe is denied", { timeout: 10_000 }, async () => {
    const childProcess = await realIgnoringGroup();
    const pid = childProcess.pid!;
    const denied = Object.assign(new Error("persistent probe denial"), { code: "EPERM" });
    try {
      const running = createWorkerProcessLifecycle({
        probeGroup: () => { throw denied; },
        wait: async () => {},
      }).run({
        role: "owner",
        timeoutMilliseconds: 5_000,
        graceMilliseconds: 0,
        launch: (admit) => admit(childProcess),
      });

      const failure = await running.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({ cause: denied });
      for (let attempt = 0; attempt < 100 && groupIsPresent(pid); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(groupIsPresent(pid)).toBe(false);
    } finally {
      if (groupIsPresent(pid)) process.kill(-pid, "SIGKILL");
    }
  });

  it.each(["probe", "stdin", "launch"] as const)(
    "removes a real SIGTERM-ignoring group before rejecting an owned post-admission %s failure",
    { timeout: 10_000 },
    async (failure) => {
      const childProcess = await realIgnoringGroup();
      const pid = childProcess.pid!;
      let firstProbe = true;
      let settled = false;
      if (failure === "stdin") {
        childProcess.stdin!.end = (() => {
          throw new Error("real stdin failure");
        }) as typeof childProcess.stdin.end;
      }
      const lifecycle = createWorkerProcessLifecycle({
        ...(failure === "probe" ? {
          probeGroup: (groupPid) => {
            if (firstProbe) {
              firstProbe = false;
              throw Object.assign(new Error("real probe denied"), { code: "EPERM" });
            }
            process.kill(-groupPid, 0);
          },
        } : {}),
        wait: async () => {
          expect(groupIsPresent(pid)).toBe(true);
          expect(settled).toBe(false);
        },
      });
      const running = lifecycle.run({
        role: "owner",
        timeoutMilliseconds: 5_000,
        graceMilliseconds: 1,
        startup: "trusted input",
        launch: (admit) => {
          admit(childProcess);
          if (failure === "launch") throw new Error("real launch failure");
        },
      }).finally(() => { settled = true; });

      try {
        await expect(running).rejects.toThrow(
          failure === "probe"
            ? "real probe denied"
            : failure === "stdin"
              ? "real stdin failure"
              : "real launch failure",
        );
        await expectRealGroupAbsent(childProcess);
      } finally {
        if (groupIsPresent(pid)) process.kill(-pid, "SIGKILL");
      }
    },
  );

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
