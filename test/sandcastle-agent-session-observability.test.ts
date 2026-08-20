import { devNull } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { agentActivityLogging } from "../.sandcastle/agent-session-observability.js";

const payload = "token=secret /home/private $(curl endpoint) 源码";

describe("Sandcastle Agent stream wiring", () => {
  it("forwards each supported session callback only to its run-scoped status port", () => {
    const ports = ["planner", "implementer", "reviewer", "merger"].map(() => ({
      transition: vi.fn(),
      observeAgentEvent: vi.fn(),
    }));

    ports.forEach((port, index) => {
      const logging = agentActivityLogging(`session-${index}`, port);
      expect(logging?.type).toBe("file");
      if (logging?.type !== "file") throw new Error("expected file logging");
      expect(logging.path).toBe(devNull);
      expect(logging.verbose).not.toBe(true);
      logging.onAgentStreamEvent?.({
        type: "raw", line: payload, iteration: 1, timestamp: new Date(0),
      });
    });

    ports.forEach((port) => {
      expect(port.observeAgentEvent).toHaveBeenCalledOnce();
      expect(port.transition).not.toHaveBeenCalled();
    });
  });

  it("does not change default logging when live status is unavailable", () => {
    expect(agentActivityLogging("session", undefined)).toBeUndefined();
  });
});
