import { describe, expect, it, vi } from "vitest";

import { dispatchAutomationCommands } from "../.sandcastle/automation-dispatch.js";

const command = { number: 220, operation: "review" as const, identity: "pull-request:220", labels: ["agent:review"] };
const scheduler = {
  acquire: async () => ({ release: async () => {} }),
  prepare: async () => {},
  track: async (_identity: string, action: () => Promise<void>) => action(),
};

describe("Automation Command dispatch lifecycle", () => {
  it("fails closed when required labels are unavailable", async () => {
    const listCommands = vi.fn();
    await expect(dispatchAutomationCommands({}, {
      scheduler,
      github: { verifyLabels: async () => { throw new Error("Missing required Automation Command label: agent:review"); }, listCommands },
      run: vi.fn(),
    })).rejects.toThrow("Missing required Automation Command label: agent:review");
    expect(listCommands).not.toHaveBeenCalled();
  });

  it("uses one immutable discovery snapshot", async () => {
    const commands = [command];
    const late = { ...command, number: 221, identity: "pull-request:221" };
    const run = vi.fn(async () => { commands.push(late); });
    await dispatchAutomationCommands({}, {
      scheduler,
      github: { verifyLabels: async () => {}, listCommands: async () => commands },
      run,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(command);
  });
});
