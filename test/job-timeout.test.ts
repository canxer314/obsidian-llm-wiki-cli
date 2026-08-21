import { describe, expect, it, vi } from "vitest";

import { runJobWithTimeout } from "../.sandcastle/job-timeout.js";

describe("job process-group timeout", () => {
  it("gracefully terminates the group, forces it after the grace interval, and waits for exit", async () => {
    const events: string[] = [];
    let exit!: () => void;
    const process = {
      pid: 420,
      exited: new Promise<void>((resolve) => {
        exit = () => {
          events.push("exited");
          resolve();
        };
      }),
      groupExited: new Promise<void>((resolve) => {
        const complete = exit;
        exit = () => {
          complete();
          resolve();
        };
      }),
    };
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
      events.push(`kill:${pid}:${signal}`);
      if (signal === "SIGKILL") exit();
    });

    await expect(runJobWithTimeout({
      start: () => process,
      timeoutMilliseconds: 0,
      graceMilliseconds: 0,
      kill,
      wait: async () => {},
    })).resolves.toEqual({ status: "timed-out" });

    expect(events).toEqual(["kill:-420:SIGTERM", "kill:-420:SIGKILL", "exited"]);
  });

  it("forces the group when its leader exits but descendants remain after termination", async () => {
    const events: string[] = [];
    let completeGroup!: () => void;
    const groupExited = new Promise<void>((resolve) => { completeGroup = resolve; });
    let completeLeader!: () => void;
    const exited = new Promise<void>((resolve) => { completeLeader = resolve; });
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
      events.push(`kill:${pid}:${signal}`);
      if (signal === "SIGTERM") completeLeader();
      if (signal === "SIGKILL") completeGroup();
    });

    await expect(runJobWithTimeout({
      start: () => ({ pid: 420, exited, groupExited }),
      timeoutMilliseconds: 0,
      graceMilliseconds: 0,
      kill,
      wait: async () => {},
    })).resolves.toEqual({ status: "timed-out" });

    expect(events).toEqual(["kill:-420:SIGTERM", "kill:-420:SIGKILL"]);
  });

  it("returns a completed job without signalling its process group", async () => {
    const kill = vi.fn();

    await expect(runJobWithTimeout({
      start: () => ({ pid: 420, exited: Promise.resolve(), groupExited: Promise.resolve() }),
      timeoutMilliseconds: 60_000,
      graceMilliseconds: 0,
      kill,
      wait: async () => {},
    })).resolves.toEqual({ status: "completed" });

    expect(kill).not.toHaveBeenCalled();
  });
});
