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

  it("returns a completed job without signalling its process group", async () => {
    const kill = vi.fn();

    await expect(runJobWithTimeout({
      start: () => ({ pid: 420, exited: Promise.resolve() }),
      timeoutMilliseconds: 60_000,
      graceMilliseconds: 0,
      kill,
      wait: async () => {},
    })).resolves.toEqual({ status: "completed" });

    expect(kill).not.toHaveBeenCalled();
  });
});
