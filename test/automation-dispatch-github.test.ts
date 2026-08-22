import { describe, expect, it, vi } from "vitest";

import { createAutomationDispatchGithubPort } from "../.sandcastle/automation-github.js";

describe("Automation Command GitHub discovery", () => {
  it("discovers trusted Pull Request trigger and state labels with one shared identity", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 19, labels: [{ name: "agent:update-branch" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 20, labels: [{ name: "agent:implement" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 20, labels: [{ name: "agent:implement" }, { name: "agent:review" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 21, labels: [{ name: "agent:in-progress" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 19, labels: [{ name: "agent:update-branch" }, { name: "agent:blocked" }] }]), stderr: "" });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.listCommands()).resolves.toEqual([
      { number: 19, operation: "update-branch", identity: "pull-request:19", labels: ["agent:update-branch", "agent:blocked"] },
      { number: 20, operation: "implement", identity: "pull-request:20", labels: ["agent:implement", "agent:review"] },
      { number: 20, operation: "review", identity: "pull-request:20", labels: ["agent:implement", "agent:review"] },
    ]);
    expect(execute).toHaveBeenCalledTimes(5);
    expect(execute).toHaveBeenNthCalledWith(1, "gh", ["pr", "list", "--state", "open", "--label", "agent:update-branch", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", ["pr", "list", "--state", "open", "--label", "agent:implement", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(3, "gh", ["pr", "list", "--state", "open", "--label", "agent:review", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(4, "gh", ["pr", "list", "--state", "open", "--label", "agent:in-progress", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(5, "gh", ["pr", "list", "--state", "open", "--label", "agent:blocked", "--json", "number,labels", "--limit", "100"], undefined);
  });
});
