import { describe, expect, it, vi } from "vitest";

import type { AutomationCommand, AutomationOperation } from "../.sandcastle/automation-command.js";
import { dispatchAutomationCommands } from "../.sandcastle/automation-dispatch.js";
import { createAutomationOperationDispatch } from "../.sandcastle/operation-dispatch.js";

const revision = "a".repeat(40);
const publishedRevision = "b".repeat(40);

type OperationCase = {
  readonly family: "dispatcher" | "queue-promotion" | "architecture-review";
  readonly operation?: AutomationOperation;
  readonly trigger?: string;
  readonly identity?: string;
  readonly outcome: string;
};

// These rows are the complete #219 operation mapping. Queue promotion has no
// Target Checkout by design; every Agent job row proves its authorized checkout
// reaches a GitHub-visible publication boundary.
const cases: readonly OperationCase[] = [
  { family: "dispatcher", operation: "update-branch", trigger: "agent:update-branch", identity: "pull-request:101", outcome: "branch-updated" },
  { family: "dispatcher", operation: "implement", trigger: "agent:implement", identity: "pull-request:102", outcome: "feedback-published" },
  { family: "dispatcher", operation: "implement-issue", trigger: "agent:implement", identity: "issue:103", outcome: "issue-pull-request-published" },
  { family: "dispatcher", operation: "implement-prd", trigger: "agent:implement", identity: "prd:104", outcome: "prd-child-published" },
  { family: "dispatcher", operation: "split-prd", trigger: "agent:to-issues", identity: "prd:105", outcome: "child-issues-published" },
  { family: "dispatcher", operation: "review", trigger: "agent:review", identity: "pull-request:106", outcome: "review-published" },
  { family: "queue-promotion", outcome: "queue-promoted" },
  { family: "architecture-review", outcome: "architecture-proposal-published" },
];

function command(entry: Required<Pick<OperationCase, "operation" | "trigger" | "identity">>, number: number): AutomationCommand {
  return { number, operation: entry.operation, identity: entry.identity, labels: [entry.trigger] };
}

function dispatcher(commandList: readonly AutomationCommand[], operationDispatch: ReturnType<typeof createAutomationOperationDispatch>) {
  const events: string[] = [];
  const scheduler = {
    acquire: vi.fn(async () => ({ release: async () => { events.push("dispatcher-release"); } })),
    prepare: vi.fn(async () => { events.push("dispatcher-acquired"); }),
    track: vi.fn(async (identity: string, action: () => Promise<void>) => {
      events.push(`track:${identity}`);
      await action();
    }),
  };
  return {
    events,
    scheduler,
    run: () => dispatchAutomationCommands({ concurrency: 1 }, {
      scheduler,
      readiness: { verifyGithubAgentAuthentication: async () => { events.push("readiness"); } },
      github: {
        verifyLabels: async () => { events.push("labels-verified"); },
        listCommands: async () => commandList,
      },
      promotion: { scan: operationDispatch.promoteQueue },
      run: operationDispatch.run,
    }),
  };
}

describe("Dispatcher operation composition", () => {
  it.each(cases)("moves $family through the production composition seam", async (entry) => {
    const events: string[] = [];
    const checkout = vi.fn(async (operation: string, number: number, action: (path: string) => Promise<void>) => {
      events.push(`checkout:${operation}:${number}:${revision}`);
      await action(`/target/${number}`);
    });
    const publish = vi.fn(async (outcome: string, number?: number, path?: string) => {
      events.push(`github:${outcome}:${number ?? "none"}:${path ?? "none"}:${publishedRevision}`);
    });
    const operationDispatch = createAutomationOperationDispatch({
      updateBranch: async (number) => checkout("update-branch", number, async (path) => publish("branch-updated", number, path)),
      implementFeedback: async (number) => checkout("implement", number, async (path) => publish("feedback-published", number, path)),
      directFeedback: async (number) => checkout("feedback", number, async (path) => publish("feedback-published", number, path)),
      implementIssue: async (number) => checkout("implement-issue", number, async (path) => publish("issue-pull-request-published", number, path)),
      implementPrd: async (number) => checkout("implement-prd", number, async (path) => publish("prd-child-published", number, path)),
      splitPrd: async (number) => checkout("split-prd", number, async (path) => publish("child-issues-published", number, path)),
      review: async (number) => checkout("review", number, async (path) => publish("review-published", number, path)),
      promoteQueue: async () => {
        await publish("queue-promoted");
        return { status: "scanned", promoted: [201], refused: [] };
      },
      architectureReview: async () => checkout("architecture-review", 0, async (path) => publish("architecture-proposal-published", 0, path)),
    });

    if (entry.family === "dispatcher") {
      const dispatchCommand = command(entry as Required<Pick<OperationCase, "operation" | "trigger" | "identity">>, 100);
      const subject = dispatcher([dispatchCommand], operationDispatch);
      await expect(subject.run()).resolves.toEqual({ status: "dispatched", selected: [dispatchCommand] });
      expect(subject.events).toEqual(expect.arrayContaining(["dispatcher-acquired", `track:${entry.identity}`]));
      expect(events).toEqual([
        `github:queue-promoted:none:none:${publishedRevision}`,
        `checkout:${entry.operation}:100:${revision}`,
        `github:${entry.outcome}:100:/target/100:${publishedRevision}`,
      ]);
    } else if (entry.family === "queue-promotion") {
      const subject = dispatcher([], operationDispatch);
      await expect(subject.run()).resolves.toEqual({ status: "dispatched", selected: [] });
      expect(events).toEqual([`github:${entry.outcome}:none:none:${publishedRevision}`]);
      expect(checkout).not.toHaveBeenCalled();
    } else {
      await operationDispatch.architectureReview();
      expect(events).toEqual([
        `checkout:architecture-review:0:${revision}`,
        `github:${entry.outcome}:0:/target/0:${publishedRevision}`,
      ]);
    }
    expect(publish).toHaveBeenCalledTimes(entry.family === "dispatcher" ? 2 : 1);
  });

  it("does not invoke an operation or write GitHub state for an ineligible command", async () => {
    const operation = vi.fn(async () => undefined);
    const operationDispatch = createAutomationOperationDispatch({
      updateBranch: operation,
      implementFeedback: operation,
      directFeedback: operation,
      implementIssue: operation,
      implementPrd: operation,
      splitPrd: operation,
      review: operation,
      promoteQueue: async () => ({ status: "scanned", promoted: [], refused: [] }),
      architectureReview: async () => undefined,
    });
    const entry = cases[0]! as Required<Pick<OperationCase, "operation" | "trigger" | "identity">>;
    const subject = dispatcher([{ ...command(entry, 100), labels: [] }], operationDispatch);

    await expect(subject.run()).resolves.toEqual({ status: "dispatched", selected: [] });

    expect(operation).not.toHaveBeenCalled();
    expect(subject.scheduler.track).not.toHaveBeenCalled();
  });
});
