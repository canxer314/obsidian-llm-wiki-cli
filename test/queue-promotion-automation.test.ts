import { describe, expect, it, vi } from "vitest";

import { runQueuePromotionScan } from "../.sandcastle/queue-promotion-automation.js";

const queuedIssue = { number: 5, labels: ["agent:queued"] } as const;

function queuedState(overrides: Partial<{
  readonly labels: readonly string[];
  readonly parentNumber: number;
  readonly blockers: readonly { readonly number: number; readonly state: string }[];
}> = {}) {
  return { labels: ["agent:queued"], blockers: [], ...overrides };
}

function ports(overrides: Partial<{
  queuedIssues: readonly { readonly number: number; readonly labels: readonly string[] }[];
  state: {
    readonly labels: readonly string[];
    readonly parentNumber?: number;
    readonly blockers: readonly { readonly number: number; readonly state: string }[];
  };
}> = {}) {
  return {
    github: {
      listQueuedIssues: vi.fn(async () => overrides.queuedIssues ?? []),
      readPromotionState: vi.fn(async () => overrides.state ?? { labels: ["agent:queued"], blockers: [] }),
      addIssueLabel: vi.fn(async () => {}),
      removeIssueLabel: vi.fn(async () => {}),
      addPromotionDiagnostic: vi.fn(async () => {}),
      addPromotionBlockedDiagnostic: vi.fn(async () => {}),
      addSubIssueRefusalDiagnostic: vi.fn(async () => {}),
    },
  };
}

function statefulPorts(blockers: readonly { readonly number: number; state: string }[]) {
  const labels = new Set(["agent:queued"]);
  const scanned = {
    github: {
      listQueuedIssues: vi.fn(async () => labels.has("agent:queued") ? [{ number: 5, labels: [...labels] }] : []),
      readPromotionState: vi.fn(async () => ({ labels: [...labels], blockers })),
      addIssueLabel: vi.fn(async (_issue: number, label: string) => { labels.add(label); }),
      removeIssueLabel: vi.fn(async (_issue: number, label: string) => { labels.delete(label); }),
      addPromotionDiagnostic: vi.fn(async () => {}),
      addPromotionBlockedDiagnostic: vi.fn(async () => {}),
      addSubIssueRefusalDiagnostic: vi.fn(async () => {}),
    },
  };
  return { labels, scanned };
}

describe("queued Issue promotion", () => {
  it("keeps a queued Issue unchanged while any blocker remains open", async () => {
    const scanned = ports({
      queuedIssues: [queuedIssue],
      state: { labels: ["agent:queued"], blockers: [{ number: 7, state: "OPEN" }, { number: 8, state: "CLOSED" }] },
    });

    await expect(runQueuePromotionScan(scanned)).resolves.toEqual({
      status: "scanned",
      promoted: [],
      refused: [],
    });
    expect(scanned.github.addIssueLabel).not.toHaveBeenCalled();
    expect(scanned.github.removeIssueLabel).not.toHaveBeenCalled();
  });

  it.each([
    ["all blockers closed", [{ number: 7, state: "CLOSED" }, { number: 8, state: "CLOSED" }]],
    ["no blockers", []],
  ])("promotes a queued Issue with %s through the upstream label transition", async (_case, blockers) => {
    const scanned = ports({
      queuedIssues: [queuedIssue],
      state: queuedState({ blockers }),
    });

    await expect(runQueuePromotionScan(scanned)).resolves.toEqual({
      status: "scanned",
      promoted: [5],
      refused: [],
    });
    expect(scanned.github.removeIssueLabel).toHaveBeenCalledWith(5, "agent:queued");
    expect(scanned.github.addIssueLabel).toHaveBeenCalledWith(5, "agent:implement");
    expect(scanned.github.addIssueLabel).toHaveBeenCalledTimes(1);
    expect(scanned.github.addPromotionDiagnostic).toHaveBeenCalledWith(5);
  });

  it("adds the implement trigger before clearing the queued label so an interrupted promotion stays recoverable", async () => {
    const order: string[] = [];
    const scanned = ports({
      queuedIssues: [queuedIssue],
      state: queuedState(),
    });
    scanned.github.addIssueLabel.mockImplementation(async () => { order.push("add-implement"); });
    scanned.github.removeIssueLabel.mockImplementation(async () => { order.push("remove-queued"); });
    scanned.github.addPromotionDiagnostic.mockImplementation(async () => { order.push("comment"); });

    await runQueuePromotionScan(scanned);
    expect(order).toEqual(["add-implement", "remove-queued", "comment"]);
  });

  it("observes a blocker closed while the Dispatcher was offline on a later scan, without any event", async () => {
    const blocker = { number: 7, state: "OPEN" };
    const { labels, scanned } = statefulPorts([blocker]);

    await expect(runQueuePromotionScan(scanned)).resolves.toEqual({ status: "scanned", promoted: [], refused: [] });

    // The Dispatcher is offline while the blocker closes; no event is consumed.
    blocker.state = "CLOSED";

    await expect(runQueuePromotionScan(scanned)).resolves.toEqual({ status: "scanned", promoted: [5], refused: [] });
    expect(labels.has("agent:queued")).toBe(false);
    expect(labels.has("agent:implement")).toBe(true);
  });

  it("leaves an in-progress queued Issue unchanged", async () => {
    const scanned = ports({
      queuedIssues: [{ number: 5, labels: ["agent:queued", "agent:in-progress"] }],
      state: { labels: ["agent:queued", "agent:in-progress"], blockers: [] },
    });

    await expect(runQueuePromotionScan(scanned)).resolves.toEqual({ status: "scanned", promoted: [], refused: [] });
    expect(scanned.github.addIssueLabel).not.toHaveBeenCalled();
    expect(scanned.github.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("refuses to promote a queued sub-Issue by clearing the queue and explaining, without blocking it", async () => {
    const scanned = ports({
      queuedIssues: [queuedIssue],
      state: queuedState({ parentNumber: 12 }),
    });

    await expect(runQueuePromotionScan(scanned)).resolves.toEqual({ status: "scanned", promoted: [], refused: [5] });
    expect(scanned.github.removeIssueLabel).toHaveBeenCalledWith(5, "agent:queued");
    expect(scanned.github.addIssueLabel).not.toHaveBeenCalled();
    expect(scanned.github.addSubIssueRefusalDiagnostic).toHaveBeenCalledWith(5, 12);
  });

  it("comments a sub-Issue refusal before clearing the queue so an interrupted refusal stays visible", async () => {
    const order: string[] = [];
    const scanned = ports({
      queuedIssues: [queuedIssue],
      state: queuedState({ parentNumber: 12 }),
    });
    scanned.github.addSubIssueRefusalDiagnostic.mockImplementation(async () => { order.push("comment"); });
    scanned.github.removeIssueLabel.mockImplementation(async () => { order.push("remove-queued"); });

    await runQueuePromotionScan(scanned);
    expect(order).toEqual(["comment", "remove-queued"]);
  });

  it("does not request duplicate work for an already-promoted Issue on a repeated scan", async () => {
    const { scanned } = statefulPorts([]);

    await runQueuePromotionScan(scanned);
    await expect(runQueuePromotionScan(scanned)).resolves.toEqual({ status: "scanned", promoted: [], refused: [] });
    expect(scanned.github.addIssueLabel).toHaveBeenCalledTimes(1);
    expect(scanned.github.addPromotionDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("abandons a promotion when the queued label is lost before the mutation lands", async () => {
    const scanned = ports({
      queuedIssues: [queuedIssue],
    });
    scanned.github.readPromotionState
      .mockResolvedValueOnce({ labels: ["agent:queued"], blockers: [] })
      .mockResolvedValueOnce({ labels: [], blockers: [] });

    await expect(runQueuePromotionScan(scanned)).resolves.toEqual({ status: "scanned", promoted: [], refused: [] });
    expect(scanned.github.addIssueLabel).not.toHaveBeenCalled();
    expect(scanned.github.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("scans queued Issues in deterministic ascending number order", async () => {
    const scanned = ports({
      queuedIssues: [
        { number: 9, labels: ["agent:queued"] },
        { number: 3, labels: ["agent:queued"] },
        { number: 7, labels: ["agent:queued"] },
      ],
      state: { labels: ["agent:queued"], blockers: [{ number: 1, state: "OPEN" }] },
    });

    await runQueuePromotionScan(scanned);
    const readOrder = scanned.github.readPromotionState.mock.calls.map(([issueNumber]) => issueNumber);
    expect(readOrder).toEqual([3, 7, 9]);
  });

  it("blocks a queued Issue when promotion publication fails", async () => {
    const scanned = ports({
      queuedIssues: [queuedIssue],
      state: queuedState(),
    });
    const failure = new Error("implement label publication failed");
    scanned.github.addIssueLabel.mockRejectedValueOnce(failure);

    await expect(runQueuePromotionScan(scanned, {
      createJobId: () => "queue-promotion-job",
    })).rejects.toBe(failure);

    expect(scanned.github.addIssueLabel).toHaveBeenNthCalledWith(1, 5, "agent:implement");
    expect(scanned.github.addIssueLabel).toHaveBeenNthCalledWith(2, 5, "agent:blocked");
    expect(scanned.github.addPromotionBlockedDiagnostic).toHaveBeenCalledWith(5, {
      jobId: "queue-promotion-job",
      summary: "implement label publication failed",
    });
    expect(scanned.github.removeIssueLabel).not.toHaveBeenCalledWith(5, "agent:queued");
  });

  it("fails closed without promoting when dependency state is unreadable", async () => {
    const scanned = ports({
      queuedIssues: [
        { number: 3, labels: ["agent:queued"] },
        { number: 9, labels: ["agent:queued"] },
      ],
    });
    scanned.github.readPromotionState.mockImplementation(async (issueNumber: number) => {
      if (issueNumber === 3) throw new Error("GitHub dependency state is unavailable");
      return { labels: ["agent:queued"], blockers: [] };
    });

    await expect(runQueuePromotionScan(scanned)).rejects.toThrow("GitHub dependency state is unavailable");
    expect(scanned.github.addIssueLabel).not.toHaveBeenCalled();
    expect(scanned.github.removeIssueLabel).not.toHaveBeenCalled();
  });
});
