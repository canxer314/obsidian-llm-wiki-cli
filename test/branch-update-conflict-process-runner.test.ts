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
  it("loads the fixed worker from the trusted worker-code root", async () => {
    const workerRoot = mkdtempSync(join(tmpdir(), "trusted-conflict-worker-"));
    writeFileSync(
      join(workerRoot, "branch-update-conflict-worker.ts"),
      'process.stdout.write(JSON.stringify({ comment: "trusted-root" }));\n',
    );

    try {
      const resolver = createProcessBranchUpdateConflictResolver({
        startup: "startup",
        model: "merger-model",
        workerRoot,
      });
      await expect(resolver.resolve({ ...request, checkoutPath: "/delivered/checkout" })).resolves.toEqual({
        comment: "trusted-root",
      });
    } finally {
      rmSync(workerRoot, { recursive: true, force: true });
    }
  });

  it("uses the fixed resolve worker protocol and parses its successful comment", async () => {
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
      "resolve",
      "219",
      "feature/conflict-resolution",
      "master",
      "0123456789abcdef0123456789abcdef01234567",
      "/jobs/conflict-resolution-219",
      "merger-model",
      "initial",
      JSON.stringify(["notes/overview.md", "notes/plan.md"]),
    ]);
    expect(process.stdin?.end).toHaveBeenCalledWith("immutable startup payload");
  });

  it("marks a continued attempt with the recovery flag", async () => {
    const process = child(554);
    const start = vi.fn().mockReturnValue(process);
    const resolver = createProcessBranchUpdateConflictResolver({
      startup: "startup",
      model: "merger-model",
      start,
    });
    const resolved = resolver.resolve({ ...request, recovery: true });

    process.stdout?.emit("data", `${JSON.stringify({ comment: "Continued the merge." })}\n`);
    process.emit("close", 0);

    await expect(resolved).resolves.toEqual({ comment: "Continued the merge." });
    expect(start).toHaveBeenCalledWith([
      "resolve",
      "219",
      "feature/conflict-resolution",
      "master",
      "0123456789abcdef0123456789abcdef01234567",
      "/jobs/conflict-resolution-219",
      "merger-model",
      "recovery",
      JSON.stringify(["notes/overview.md", "notes/plan.md"]),
    ]);
  });

  it("uses the format worker protocol for an already completed merge", async () => {
    const process = child(555);
    const start = vi.fn().mockReturnValue(process);
    const resolver = createProcessBranchUpdateConflictResolver({
      startup: "startup",
      model: "merger-model",
      start,
    });
    const { conflicts: _conflicts, ...formatRequest } = request;
    const formatted = resolver.format(formatRequest);

    process.stdout?.emit("data", `${JSON.stringify({ comment: "Formatted the completed merge." })}\n`);
    process.emit("close", 0);

    await expect(formatted).resolves.toEqual({ comment: "Formatted the completed merge." });
    expect(start).toHaveBeenCalledWith([
      "format",
      "219",
      "feature/conflict-resolution",
      "master",
      "0123456789abcdef0123456789abcdef01234567",
      "/jobs/conflict-resolution-219",
      "merger-model",
      "initial",
      "[]",
    ]);
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

});
