import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createProcessBranchUpdateConflictResolver } from "../.sandcastle/branch-update-conflict-process-runner.js";

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

const request = {
  pullRequestNumber: 219,
  branch: "feature/conflict-resolution",
  baseBranch: "master",
  revision: "0123456789abcdef0123456789abcdef01234567",
  checkoutPath: "/jobs/conflict-resolution-219",
  conflicts: ["notes/overview.md", "notes/plan.md"],
} as const;

describe("branch update conflict process runner", () => {
  it("loads the fixed worker from the authorized Target Checkout", async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), "authorized-conflict-worker-"));
    const workerDirectory = join(checkoutPath, ".sandcastle");
    mkdirSync(workerDirectory);
    writeFileSync(
      join(workerDirectory, "branch-update-conflict-worker.ts"),
      'process.stdout.write(JSON.stringify({ comment: "authorized-checkout" }));\n',
    );

    try {
      const resolver = createProcessBranchUpdateConflictResolver({
        startup: "startup",
        model: "merger-model",
      });
      await expect(resolver.resolve({ ...request, checkoutPath })).resolves.toEqual({
        comment: "authorized-checkout",
      });
    } finally {
      rmSync(checkoutPath, { recursive: true, force: true });
    }
  });

  it("uses the fixed worker protocol and parses its successful comment", async () => {
    const process = child(551);
    const start = vi.fn().mockReturnValue(process);
    const resolver = createProcessBranchUpdateConflictResolver({
      startup: "immutable startup payload",
      model: "merger-model",
      start,
    });
    const resolved = resolver.resolve(request);

    process.stdout?.emit("data", `${JSON.stringify({ comment: "Resolved both conflicts." })}\n`);
    process.emit("close", 0);

    await expect(resolved).resolves.toEqual({ comment: "Resolved both conflicts." });
    expect(start).toHaveBeenCalledWith([
      "219",
      "feature/conflict-resolution",
      "master",
      "0123456789abcdef0123456789abcdef01234567",
      "/jobs/conflict-resolution-219",
      "merger-model",
      JSON.stringify(["notes/overview.md", "notes/plan.md"]),
    ]);
    expect(process.stdin?.end).toHaveBeenCalledWith("immutable startup payload");
  });

  it.each([
    [1, "Sandbox unavailable", "Branch update conflict resolution worker exited with 1: Sandbox unavailable"],
    [null, "terminated", "Branch update conflict resolution worker exited with signal: terminated"],
  ] as const)("preserves the %s exit classification", async (code, diagnostics, message) => {
    const process = child(552);
    const resolver = createProcessBranchUpdateConflictResolver({
      startup: "startup",
      model: "merger-model",
      start: () => process,
    });
    const resolved = resolver.resolve(request);

    process.stderr?.emit("data", diagnostics);
    process.emit("close", code);

    await expect(resolved).rejects.toThrow(message);
  });

  it.each([
    ["missing", " \n ", "Branch update conflict resolution worker did not return a result"],
    ["malformed", '{"comment":', "Branch update conflict resolution worker returned invalid JSON"],
    ["missing comment", "{}", "Branch update conflict resolution worker returned invalid result"],
    ["empty comment", '{"comment":""}', "Branch update conflict resolution worker returned invalid result"],
  ] as const)("fails closed on %s worker output", async (_caseName, output, message) => {
    const process = child(553);
    const resolver = createProcessBranchUpdateConflictResolver({
      startup: "startup",
      model: "merger-model",
      start: () => process,
    });
    const resolved = resolver.resolve(request);

    process.stdout?.emit("data", output);
    process.emit("close", 0);

    await expect(resolved).rejects.toThrow(message);
  });

  it("maps lifecycle timeout to the conflict-resolution timeout error", async () => {
    const resolver = createProcessBranchUpdateConflictResolver({
      startup: "startup",
      model: "merger-model",
      timeoutMilliseconds: 0,
      graceMilliseconds: 0,
      start: () => child(554),
    });

    await expect(resolver.resolve(request)).rejects.toThrow("Branch update conflict resolution timed out");
  });
});
