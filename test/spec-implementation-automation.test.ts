import { describe, expect, it, vi } from "vitest";

import { runSpecImplementationAutomationCommand } from "../.sandcastle/spec-implementation-automation.js";

const revision = "0123456789abcdef0123456789abcdef01234567";
const childRevision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function spec(overrides = {}) {
  return {
    number: 226,
    title: "Continue Spec implementation",
    state: "OPEN",
    labels: ["agent:implement"],
    baseRevision: revision,
    subIssueCount: 3,
    ...overrides,
  };
}

function child(number: number, overrides = {}) {
  return {
    number,
    title: `Child ${number}`,
    state: "OPEN",
    openBlockerCount: 0,
    subIssueCount: 0,
    ...overrides,
  };
}

function portsFor(overrides: {
  readonly github?: Record<string, unknown>;
  readonly pullRequests?: Record<string, unknown>;
  readonly checkout?: Record<string, unknown>;
  readonly implementer?: Record<string, unknown>;
  readonly lease?: Record<string, unknown>;
  readonly createJobId?: () => string;
} = {}) {
  const events: string[] = [];
  const labels = new Set(["agent:implement"]);
  const github = {
    readSpec: vi.fn(async () => spec({ labels: [...labels] })),
    listChildren: vi.fn(),
    addIssueLabel: vi.fn(async (number: number, label: string) => {
      labels.add(label);
      events.push(`add:${number}:${label}`);
    }),
    removeIssueLabel: vi.fn(async (number: number, label: string) => {
      labels.delete(label);
      events.push(`remove:${number}:${label}`);
    }),
    addRefusalDiagnostic: vi.fn(async (number: number, reason: string) => events.push(`refusal:${number}:${reason}`)),
    closeImplementedChild: vi.fn(async (request: { childNumber: number; revision: string }) => events.push(`close:${request.childNumber}:${request.revision}`)),
    addSpecImplementationBlockedDiagnostic: vi.fn(async (number: number, diagnostic: { jobId: string }) => events.push(`blocked:${number}:${diagnostic.jobId}`)),
    addChildFailureDiagnostic: vi.fn(async (number: number) => events.push(`child-failure:${number}`)),
    ...overrides.github,
  };
  const pullRequests = {
    ensureSpecDraftPullRequest: vi.fn(async (request: { branch: string }) => {
      events.push(`ensure-pr:${request.branch}`);
      return { number: 401, url: "https://example.test/pr/401" };
    }),
    addPullRequestLabel: vi.fn(async (number: number, label: string) => events.push(`pr-add:${number}:${label}`)),
    ...overrides.pullRequests,
  };
  const checkout = {
    withCheckout: vi.fn(async (request: { revision: string }, action: (path: string) => Promise<unknown>) => {
      events.push(`checkout:${request.revision}`);
      return action("/safe/disposable-checkout");
    }),
    ...overrides.checkout,
  };
  const implementer = {
    implement: vi.fn(async (request: { child: { number: number }; branch: string; checkoutPath: string }) => {
      events.push(`implement:${request.child.number}:${request.branch}`);
      expect(request.checkoutPath).toBe("/safe/disposable-checkout");
      return { branch: request.branch, headSha: childRevision };
    }),
    ...overrides.implementer,
  };
  const lease = {
    acquire: vi.fn(async () => ({ release: async () => {} })),
    ...overrides.lease,
  };
  return { events, github, pullRequests, checkout, implementer, lease, createJobId: overrides.createJobId };
}

describe("Spec implementation automation command", () => {
  it("implements the first open child on the accumulating Spec branch and requests the next child", async () => {
    const ports = portsFor();
    ports.github.listChildren
      .mockResolvedValueOnce([child(301), child(302), child(303)])
      .mockResolvedValueOnce([child(301, { state: "CLOSED" }), child(302), child(303)]);

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "implemented",
      childNumber: 301,
      branch: "sandcastle/spec-226",
      pullRequestUrl: "https://example.test/pr/401",
      continuation: "next-child",
    });

    expect(ports.implementer.implement).toHaveBeenCalledWith(expect.objectContaining({
      specNumber: 226,
      child: { number: 301, title: "Child 301" },
      branch: "sandcastle/spec-226",
      baseRevision: revision,
    }));
    expect(ports.pullRequests.ensureSpecDraftPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      specNumber: 226,
      branch: "sandcastle/spec-226",
      headSha: childRevision,
    }));
    expect(ports.github.closeImplementedChild).toHaveBeenCalledWith({
      specNumber: 226,
      childNumber: 301,
      revision: childRevision,
    });
    expect(ports.events).toEqual([
      "add:226:agent:in-progress",
      "remove:226:agent:implement",
      `checkout:${revision}`,
      "implement:301:sandcastle/spec-226",
      `close:301:${childRevision}`,
      "ensure-pr:sandcastle/spec-226",
      "add:226:agent:implement",
      "remove:226:agent:in-progress",
    ]);
    expect(ports.github.addIssueLabel).not.toHaveBeenCalledWith(226, "agent:blocked");
    expect(ports.pullRequests.addPullRequestLabel).not.toHaveBeenCalled();
  });

  it("refuses when the cross-process lease is unavailable before selecting a child", async () => {
    const ports = portsFor({ lease: { acquire: vi.fn(async () => undefined) } });

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "refused",
      reason: "Spec #226 is already being implemented",
    });

    expect(ports.github.listChildren).not.toHaveBeenCalled();
    expect(ports.checkout.withCheckout).not.toHaveBeenCalled();
    expect(ports.implementer.implement).not.toHaveBeenCalled();
  });

  it("blocks when the Spec target changes while implementation is being acquired", async () => {
    const ports = portsFor({ createJobId: () => "job-226" });
    const initialRead = ports.github.readSpec;
    let reads = 0;
    ports.github.readSpec = vi.fn(async () => {
      reads += 1;
      return reads === 1
        ? initialRead()
        : spec({
          labels: ["agent:in-progress"],
          baseRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });
    });
    ports.github.listChildren.mockResolvedValue([child(301), child(302), child(303)]);

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "blocked",
      reason: "spec-implementation-execution",
      jobId: "job-226",
    });

    expect(ports.implementer.implement).not.toHaveBeenCalled();
    expect(ports.checkout.withCheckout).not.toHaveBeenCalled();
    expect(ports.github.addIssueLabel).toHaveBeenCalledWith(226, "agent:blocked");
    expect(ports.github.removeIssueLabel).toHaveBeenCalledWith(226, "agent:in-progress");
  });

  it("skips completed children and implements the first still-open intermediate child", async () => {
    const ports = portsFor();
    ports.github.listChildren
      .mockResolvedValueOnce([child(301, { state: "CLOSED" }), child(302), child(303)])
      .mockResolvedValueOnce([child(301, { state: "CLOSED" }), child(302, { state: "CLOSED" }), child(303)]);

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual(
      expect.objectContaining({ status: "implemented", childNumber: 302, continuation: "next-child" }),
    );

    expect(ports.implementer.implement).toHaveBeenCalledWith(expect.objectContaining({
      child: { number: 302, title: "Child 302" },
    }));
    expect(ports.github.closeImplementedChild).toHaveBeenCalledWith({
      specNumber: 226,
      childNumber: 302,
      revision: childRevision,
    });
  });

  it("requests review of the resulting Pull Request when the final child completes", async () => {
    const ports = portsFor();
    ports.github.listChildren
      .mockResolvedValueOnce([child(301, { state: "CLOSED" }), child(302, { state: "CLOSED" }), child(303)])
      .mockResolvedValueOnce([child(301, { state: "CLOSED" }), child(302, { state: "CLOSED" }), child(303, { state: "CLOSED" })]);

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "implemented",
      childNumber: 303,
      branch: "sandcastle/spec-226",
      pullRequestUrl: "https://example.test/pr/401",
      continuation: "final-review",
    });

    expect(ports.pullRequests.addPullRequestLabel).toHaveBeenCalledWith(401, "agent:review");
    expect(ports.github.addIssueLabel).not.toHaveBeenCalledWith(226, "agent:implement");
    expect(ports.events.at(-1)).toBe("remove:226:agent:in-progress");
  });

  it("refuses to start a child whose blockers remain open instead of selecting a later child", async () => {
    const ports = portsFor();
    ports.github.listChildren.mockResolvedValue([
      child(301, { state: "CLOSED" }),
      child(302, { openBlockerCount: 2 }),
      child(303),
    ]);

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "refused",
      reason: "Sub-issue #302 cannot start while 2 blocker(s) remain open",
    });

    expect(ports.implementer.implement).not.toHaveBeenCalled();
    expect(ports.github.removeIssueLabel).toHaveBeenCalledWith(226, "agent:implement");
    expect(ports.github.addRefusalDiagnostic).toHaveBeenCalledWith(226, "Sub-issue #302 cannot start while 2 blocker(s) remain open");
    expect(ports.github.addIssueLabel).not.toHaveBeenCalled();
  });

  it("refuses a Spec whose children are all closed without blocking it", async () => {
    const ports = portsFor({
      github: { readSpec: vi.fn().mockResolvedValue(spec({ subIssueCount: 2 })) },
    });
    ports.github.listChildren.mockResolvedValue([child(301, { state: "CLOSED" }), child(302, { state: "CLOSED" })]);

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "refused",
      reason: "Issue #226 has no open sub-issues to implement",
    });

    expect(ports.implementer.implement).not.toHaveBeenCalled();
    expect(ports.github.removeIssueLabel).toHaveBeenCalledWith(226, "agent:implement");
    expect(ports.github.addIssueLabel).not.toHaveBeenCalled();
  });

  it("refuses an Issue without sub-issues as not a Spec", async () => {
    const ports = portsFor({
      github: { readSpec: vi.fn().mockResolvedValue(spec({ subIssueCount: 0 })) },
    });

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "refused",
      reason: "Issue #226 has no sub-issues and is not a Spec",
    });

    expect(ports.github.listChildren).not.toHaveBeenCalled();
    expect(ports.github.removeIssueLabel).toHaveBeenCalledWith(226, "agent:implement");
    expect(ports.github.addIssueLabel).not.toHaveBeenCalled();
  });

  it("refuses a nested Spec without blocking it", async () => {
    const ports = portsFor({
      github: { readSpec: vi.fn().mockResolvedValue(spec({ parentNumber: 219 })) },
    });

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "refused",
      reason: "Issue #226 has sub-issues but is itself a sub-issue of #219; nested Specs are not supported",
    });

    expect(ports.github.listChildren).not.toHaveBeenCalled();
    expect(ports.github.addIssueLabel).not.toHaveBeenCalled();
  });

  it("refuses a Spec whose child has its own sub-issues without blocking it", async () => {
    const ports = portsFor();
    ports.github.listChildren.mockResolvedValue([child(301, { subIssueCount: 1 }), child(302)]);

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "refused",
      reason: "Sub-issue #301 itself has sub-issues; nested sub-issues are not supported",
    });

    expect(ports.implementer.implement).not.toHaveBeenCalled();
    expect(ports.github.addIssueLabel).not.toHaveBeenCalled();
  });

  it("blocks execution failures without requesting a continuation", async () => {
    const ports = portsFor({
      implementer: { implement: vi.fn().mockRejectedValue(new Error("push failed")) },
      createJobId: () => "job-226",
    });
    ports.github.listChildren.mockResolvedValue([child(301), child(302)]);

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "blocked",
      reason: "spec-implementation-execution",
      jobId: "job-226",
    });

    expect(ports.github.addSpecImplementationBlockedDiagnostic).toHaveBeenCalledWith(226, {
      reason: "spec-implementation-execution",
      jobId: "job-226",
      summary: "push failed",
      childNumber: 301,
    });
    expect(ports.github.addChildFailureDiagnostic).toHaveBeenCalledWith(301, expect.objectContaining({ specNumber: 226 }));
    expect(ports.events).toEqual([
      "add:226:agent:in-progress",
      "remove:226:agent:implement",
      `checkout:${revision}`,
      "add:226:agent:blocked",
      "blocked:226:job-226",
      "child-failure:301",
      "remove:226:agent:in-progress",
    ]);
    expect(ports.github.addIssueLabel).not.toHaveBeenCalledWith(226, "agent:implement");
    expect(ports.pullRequests.addPullRequestLabel).not.toHaveBeenCalled();
  });

  it("blocks the Spec and retains the local job diagnostic when the child implementation job times out", async () => {
    const ports = portsFor({
      implementer: { implement: vi.fn().mockRejectedValue(new Error("Spec implementation execution timed out")) },
      createJobId: () => "job-226",
    });
    ports.github.listChildren.mockResolvedValue([child(301), child(302)]);

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "blocked",
      reason: "spec-implementation-execution",
      jobId: "job-226",
    });

    expect(ports.github.addSpecImplementationBlockedDiagnostic).toHaveBeenCalledWith(226, {
      reason: "spec-implementation-execution",
      jobId: "job-226",
      summary: "Spec implementation execution timed out",
      childNumber: 301,
    });
    expect(ports.events).toEqual([
      "add:226:agent:in-progress",
      "remove:226:agent:implement",
      `checkout:${revision}`,
      "add:226:agent:blocked",
      "blocked:226:job-226",
      "child-failure:301",
      "remove:226:agent:in-progress",
    ]);
  });

  it("turns a continuation-publication failure into Blocked Automation without repeating the child", async () => {
    const ports = portsFor({
      createJobId: () => "job-226",
    });
    ports.github.listChildren
      .mockResolvedValueOnce([child(301), child(302)])
      .mockResolvedValueOnce([child(301, { state: "CLOSED" }), child(302)]);
    const statefulAddIssueLabel = ports.github.addIssueLabel;
    ports.github.addIssueLabel = vi.fn(async (number: number, label: string) => {
      await statefulAddIssueLabel(number, label);
      if (label === "agent:implement") throw new Error("label publication failed");
    });

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "blocked",
      reason: "spec-implementation-publication",
      jobId: "job-226",
    });

    expect(ports.implementer.implement).toHaveBeenCalledTimes(1);
    expect(ports.github.closeImplementedChild).toHaveBeenCalledTimes(1);
    expect(ports.github.addIssueLabel).toHaveBeenCalledWith(226, "agent:blocked");
    expect(ports.github.addSpecImplementationBlockedDiagnostic).toHaveBeenCalledWith(226, expect.objectContaining({
      reason: "spec-implementation-publication",
      childNumber: 301,
    }));
    expect(ports.events.at(-1)).toBe("remove:226:agent:in-progress");
  });

  it("turns a final review request failure into Blocked Automation", async () => {
    const ports = portsFor({
      pullRequests: {
        ensureSpecDraftPullRequest: vi.fn().mockResolvedValue({ number: 401, url: "https://example.test/pr/401" }),
        addPullRequestLabel: vi.fn().mockRejectedValue(new Error("review label failed")),
      },
      createJobId: () => "job-226",
    });
    ports.github.listChildren
      .mockResolvedValueOnce([child(303)])
      .mockResolvedValueOnce([child(303, { state: "CLOSED" })]);

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "blocked",
      reason: "spec-implementation-publication",
      jobId: "job-226",
    });

    expect(ports.github.addIssueLabel).toHaveBeenCalledWith(226, "agent:blocked");
  });

  it("refuses a concurrent command for the same Spec before another Agent can run", async () => {
    let releaseImplementation!: () => void;
    const implementationFinished = new Promise<void>((resolve) => { releaseImplementation = resolve; });
    const ports = portsFor({
      implementer: {
        implement: vi.fn(async (request: { branch: string }) => {
          await implementationFinished;
          return { branch: request.branch, headSha: childRevision };
        }),
      },
    });
    ports.github.listChildren
      .mockResolvedValueOnce([child(301), child(302)])
      .mockResolvedValueOnce([child(301, { state: "CLOSED" }), child(302)])
      .mockResolvedValue([child(301), child(302)]);

    const first = runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports);
    await vi.waitFor(() => expect(ports.implementer.implement).toHaveBeenCalledOnce());
    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports))
      .resolves.toEqual({ status: "refused", reason: "Spec #226 is already being implemented" });
    releaseImplementation();
    await first;

    expect(ports.implementer.implement).toHaveBeenCalledOnce();
  });

  it("refuses a Spec that is not queued for implementation without blocking it", async () => {
    const ports = portsFor({
      github: { readSpec: vi.fn().mockResolvedValue(spec({ labels: [] })) },
    });

    await expect(runSpecImplementationAutomationCommand({ issueNumber: 226 }, ports)).resolves.toEqual({
      status: "refused",
      reason: "Issue #226 is not queued for implementation",
    });

    expect(ports.github.listChildren).not.toHaveBeenCalled();
    expect(ports.github.addIssueLabel).not.toHaveBeenCalled();
  });
});
