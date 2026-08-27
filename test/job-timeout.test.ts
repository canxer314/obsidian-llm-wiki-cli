import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("terminates descendants left behind by a successfully exited leader", async () => {
    const events: string[] = [];
    let completeGroup!: () => void;
    const groupExited = new Promise<void>((resolve) => { completeGroup = resolve; });
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
      events.push(`kill:${pid}:${signal}`);
      if (signal === "SIGKILL") completeGroup();
    });

    await expect(runJobWithTimeout({
      start: () => ({ pid: 420, exited: Promise.resolve(), groupExited }),
      timeoutMilliseconds: 60_000,
      graceMilliseconds: 0,
      kill,
      wait: async () => {},
    })).resolves.toEqual({ status: "completed" });

    expect(events).toEqual(["kill:-420:SIGTERM", "kill:-420:SIGKILL"]);
  });

  it("kills a real descendant before successful completion returns", async () => {
    const marker = join(tmpdir(), `job-timeout-success-descendant-${process.pid}.pid`);
    const start = () => {
      const child = spawn("bash", ["-c", `trap '' TERM; sleep 30 & echo $! > ${marker}; exit 0`], {
        detached: true,
        stdio: "ignore",
      });
      if (child.pid === undefined) throw new Error("test child lacks PID");
      const exited = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => resolve());
      });
      const groupExited = new Promise<void>((resolve) => {
        const check = () => {
          try {
            process.kill(-child.pid!, 0);
            setTimeout(check, 10);
          } catch {
            resolve();
          }
        };
        check();
      });
      return { pid: child.pid, exited, groupExited };
    };

    await expect(runJobWithTimeout({
      start,
      timeoutMilliseconds: 1_000,
      graceMilliseconds: 10,
      kill: process.kill,
      wait: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    })).resolves.toEqual({ status: "completed" });

    const descendant = Number(readFileSync(marker, "utf8"));
    rmSync(marker, { force: true });
    expect(() => process.kill(descendant, 0)).toThrow();
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
