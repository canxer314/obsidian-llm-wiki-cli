import { describe, expect, it, vi } from "vitest";

import { classifyAgentStreamEvent } from "../.sandcastle/agent-activity.js";
import { createSandcastleLiveStatus } from "../.sandcastle/live-status.js";

const hostile = "token=secret https://private.example /home/user/vault $(curl bad) 源码";

describe("Sandcastle agent activity", () => {
  it.each([
    [{ type: "toolCall", name: "Read", formattedArgs: hostile }, "inspecting-repository"],
    [{ type: "toolCall", name: "Edit", formattedArgs: hostile }, "editing"],
    [{ type: "toolCall", name: "Bash", formattedArgs: hostile }, "executing-command"],
    [{ type: "toolCall", name: hostile, formattedArgs: hostile }, "executing-other-tool"],
    [{ type: "text", message: hostile }, null],
    [{ type: "raw", line: hostile }, null],
    [{ type: hostile, payload: hostile }, "waiting"],
  ])("classifies untrusted events without returning payload data", (event, expected) => {
    const result = classifyAgentStreamEvent(event);
    expect(result).toBe(expected);
    expect(JSON.stringify(result)).not.toContain(hostile);
  });

  it("emits activity changes, suppresses duplicates, and reports age without heartbeat refresh", () => {
    const lines: string[] = [];
    const ticks: Array<() => void> = [];
    let now = 0;
    const registry = createSandcastleLiveStatus({
      runId: "activity-run",
      format: "json",
      dependencies: {
        sink: (line) => lines.push(line),
        monotonicNow: () => now,
        utcNow: () => new Date("2026-08-20T00:00:00.000Z"),
        setInterval: (tick) => { ticks.push(tick); return tick; },
        clearInterval: vi.fn(),
      },
    });
    const status = registry.startIssue(0, 205);
    status.transition("planner");
    status.observeAgentEvent({ type: "toolCall", name: "Read", formattedArgs: hostile });
    now = 60_000;
    status.observeAgentEvent({ type: "toolCall", name: "Read", formattedArgs: hostile });
    now = 120_000;
    ticks[0]!();

    const events = lines.map((line) => JSON.parse(line).sandcastleStatus);
    expect(events.filter((event) => event.lastObservedActivity === "inspecting-repository"))
      .toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      kind: "heartbeat",
      lastObservedActivity: "inspecting-repository",
      activityAgeMs: 60_000,
    });
    expect(JSON.stringify(events)).not.toContain(hostile);
  });

  it.each([
    ["planner", 15 * 60_000, "planner-over-soft-limit"],
    ["implementer", 75 * 60_000, "implementer-over-soft-limit"],
    ["reviewer", 30 * 60_000, "reviewer-over-soft-limit"],
    ["repair", 60 * 60_000, "repair-over-soft-limit"],
    ["merger", 45 * 60_000, "merger-over-soft-limit"],
  ] as const)("warns once when %s exceeds its soft threshold", (stage, threshold, warning) => {
    const lines: string[] = [];
    const ticks: Array<() => void> = [];
    let now = 0;
    const registry = createSandcastleLiveStatus({
      runId: "timing-run",
      format: "json",
      dependencies: {
        sink: (line) => lines.push(line), monotonicNow: () => now,
        utcNow: () => new Date("2026-08-20T00:00:00.000Z"),
        setInterval: (tick) => { ticks.push(tick); return tick; }, clearInterval: vi.fn(),
      },
    });
    const status = registry.startIssue(0, 205);
    status.transition(stage);
    now = threshold;
    ticks[0]!();
    ticks[0]!();
    const warnings = lines.map((line) => JSON.parse(line).sandcastleStatus)
      .filter((event) => event.warning === warning);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ health: "warning", stageElapsedMs: threshold });
  });

  it("warns once for agent idle and whole workflow without changing terminal outcome", () => {
    const lines: string[] = [];
    const ticks: Array<() => void> = [];
    let now = 0;
    const registry = createSandcastleLiveStatus({
      runId: "workflow-run", format: "json",
      dependencies: {
        sink: (line) => lines.push(line), monotonicNow: () => now,
        utcNow: () => new Date("2026-08-20T00:00:00.000Z"),
        setInterval: (tick) => { ticks.push(tick); return tick; }, clearInterval: vi.fn(),
      },
    });
    const status = registry.startIssue(0, 205);
    status.transition("planner");
    status.observeAgentEvent({ type: "text", message: hostile });
    now = 12 * 60 * 60_000;
    ticks[0]!();
    registry.finishIssue(205, "completed");
    const events = lines.map((line) => JSON.parse(line).sandcastleStatus);
    expect(events.filter((event) => event.warning === "agent-idle")).toHaveLength(1);
    expect(events.filter((event) => event.warning === "workflow-over-soft-limit")).toHaveLength(1);
    expect(events.at(-1).health).toBe("completed");
    expect(JSON.stringify(events)).not.toContain(hostile);
  });
});
