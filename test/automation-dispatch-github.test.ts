import { describe, expect, it, vi } from "vitest";

import { createAutomationDispatchGithubPort } from "../.sandcastle/automation-github.js";

describe("Automation Command GitHub discovery", () => {
  it("discovers only fixed trusted review and implementation trigger labels", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 20, labels: [{ name: "agent:review" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 21, labels: [{ name: "agent:in-progress" }] }]), stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 20, labels: [{ name: "agent:review" }, { name: "agent:blocked" }] }]), stderr: "" });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.listCommands()).resolves.toEqual([
      { number: 20, operation: "review", identity: "pull-request:20", labels: ["agent:review", "agent:blocked"] },
      { number: 21, operation: "review", identity: "pull-request:21", labels: ["agent:in-progress"] },
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenNthCalledWith(1, "gh", ["pr", "list", "--state", "open", "--label", "agent:review", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "gh", ["pr", "list", "--state", "open", "--label", "agent:in-progress", "--json", "number,labels", "--limit", "100"], undefined);
    expect(execute).toHaveBeenNthCalledWith(3, "gh", ["pr", "list", "--state", "open", "--label", "agent:blocked", "--json", "number,labels", "--limit", "100"], undefined);
  });
});
