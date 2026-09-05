import { describe, expect, it, vi } from "vitest";

import { dispatchAutomationCommands } from "../.sandcastle/automation-dispatch.js";

const command = { number: 220, operation: "review" as const, identity: "pull-request:220", labels: ["agent:review"] };
const scheduler = {
  acquire: async () => ({ release: async () => {} }),
  prepare: async () => {},
  track: async (_identity: string, action: () => Promise<void>) => action(),
};
const promotion = { scan: async () => ({ status: "scanned" as const, promoted: [], refused: [] }) };
const readiness = { verifyGithubAgentAuthentication: async () => {} };
const recovery = { recoverInterrupted: async () => [] };

describe("Automation Command dispatch lifecycle", () => {
  it("fails closed when required labels are unavailable", async () => {
    const listCommands = vi.fn();
    await expect(dispatchAutomationCommands({}, {
      scheduler,
      promotion,
      readiness,
      recovery,
      github: { verifyLabels: async () => { throw new Error("Missing required Automation Command label: agent:review"); }, listCommands },
      run: vi.fn(),
    })).rejects.toThrow("Missing required Automation Command label: agent:review");
    expect(listCommands).not.toHaveBeenCalled();
  });

  it("re-discovers after a worker finishes so a command that becomes eligible mid-session runs in the same session", async () => {
    // ADR-0005: there is no frozen frontier anymore; a completion-triggered
    // refill discovers the late command and dispatches it before draining.
    const late = { ...command, number: 221, identity: "pull-request:221" };
    const store = [command];
    const run = vi.fn(async (selected: typeof command) => {
      store.splice(store.findIndex((entry) => entry.identity === selected.identity), 1);
      if (selected.number === 220) store.push(late);
    });
    const result = await dispatchAutomationCommands({}, {
      scheduler,
      promotion,
      readiness,
      recovery,
      wait: () => new Promise<void>(() => {}),
      github: { verifyLabels: async () => {}, listCommands: async () => store.slice() },
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, command);
    expect(run).toHaveBeenNthCalledWith(2, late);
    expect(result).toEqual({ status: "dispatched", selected: [command, late] });
  });
});
