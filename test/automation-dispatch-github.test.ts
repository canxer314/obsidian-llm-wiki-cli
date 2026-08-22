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

  it("fails closed when the agent:queued label is missing and sets it up idempotently", async () => {
    const missing = vi.fn().mockResolvedValue({
      stdout: JSON.stringify(["agent:update-branch", "agent:implement", "agent:review", "agent:in-progress", "agent:blocked"].map((name) => ({ name }))),
      stderr: "",
    });
    await expect(createAutomationDispatchGithubPort({ execute: missing }).verifyLabels())
      .rejects.toThrow("Missing required Automation Command label: agent:queued");

    const baseLabels = ["agent:update-branch", "agent:implement", "agent:review", "agent:in-progress", "agent:blocked"];
    const setup = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify(baseLabels.map((name) => ({ name }))), stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: JSON.stringify([...baseLabels, "agent:queued"].map((name) => ({ name }))), stderr: "" });
    const port = createAutomationDispatchGithubPort({ execute: setup });
    await port.ensureLabels();
    expect(setup).toHaveBeenCalledWith("gh", ["label", "create", "agent:queued", "--color", "0E8A16"], undefined);
    await port.ensureLabels();
    expect(setup).toHaveBeenCalledTimes(3);
  });

  it("lists open queued Issues for promotion", async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        { number: 5, labels: [{ name: "agent:queued" }] },
        { number: 9, labels: [{ name: "agent:queued" }, { name: "agent:in-progress" }] },
      ]),
      stderr: "",
    });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.listQueuedIssues()).resolves.toEqual([
      { number: 5, labels: ["agent:queued"] },
      { number: 9, labels: ["agent:queued", "agent:in-progress"] },
    ]);
    expect(execute).toHaveBeenCalledWith(
      "gh", ["issue", "list", "--state", "open", "--label", "agent:queued", "--json", "number,labels", "--limit", "100"], undefined,
    );
  });

  it("reads current labels, parent, and native blocker state for a queued Issue", async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        labels: { nodes: [{ name: "agent:queued" }], pageInfo: { hasNextPage: false } },
        parent: { number: 12 },
        blockedBy: { nodes: [{ number: 7, state: "CLOSED" }, { number: 8, state: "OPEN" }], pageInfo: { hasNextPage: false } },
      }),
      stderr: "",
    });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.readPromotionState(5)).resolves.toEqual({
      labels: ["agent:queued"],
      parentNumber: 12,
      blockers: [{ number: 7, state: "CLOSED" }, { number: 8, state: "OPEN" }],
    });
    const [file, arguments_] = execute.mock.calls[0]!;
    expect(file).toBe("gh");
    expect(arguments_[0]).toBe("api");
    expect(arguments_[1]).toBe("graphql");
    expect(arguments_).toContain("-F");
    expect(arguments_).toContain("number=5");
  });

  it("reads a queued Issue without a parent and fails closed when the Issue is unreadable", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          labels: { nodes: [{ name: "agent:queued" }], pageInfo: { hasNextPage: false } },
          parent: null,
          blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "null", stderr: "" });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.readPromotionState(5)).resolves.toEqual({ labels: ["agent:queued"], blockers: [] });
    await expect(port.readPromotionState(404)).rejects.toThrow("dependency state is unreadable");
  });

  it("fails closed when blocker or label state is truncated", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          labels: { nodes: [{ name: "agent:queued" }], pageInfo: { hasNextPage: false } },
          parent: null,
          blockedBy: { nodes: [{ number: 7, state: "CLOSED" }], pageInfo: { hasNextPage: true } },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          labels: { nodes: [{ name: "agent:queued" }], pageInfo: { hasNextPage: true } },
          parent: null,
          blockedBy: { nodes: [], pageInfo: { hasNextPage: false } },
        }),
        stderr: "",
      });
    const port = createAutomationDispatchGithubPort({ execute });

    await expect(port.readPromotionState(5)).rejects.toThrow("dependency state is unreadable");
    await expect(port.readPromotionState(5)).rejects.toThrow("dependency state is unreadable");
  });
});
