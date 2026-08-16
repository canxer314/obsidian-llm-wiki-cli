import { describe, expect, it, vi } from "vitest";
import {
  runWorkerPreflight,
  type PreflightCheck,
} from "../src/index.js";

const requiredChecks = [
  "docker",
  "container-settings",
  "model-gateway",
  "delivery-image",
  "reviewer-image",
  "pinned-skills",
  "github-authentication",
  "repository-access",
  "writable-workspace",
] as const;

function checks(failing?: typeof requiredChecks[number]): PreflightCheck[] {
  return requiredChecks.map((name) => ({
    name,
    check: vi.fn(async () => name === failing
      ? { ok: false as const, reason: `${name} unavailable` }
      : { ok: true as const }),
  }));
}

describe("runWorkerPreflight", () => {
  it("verifies every Delivery Worker prerequisite before reporting ready", async () => {
    await expect(runWorkerPreflight(checks())).resolves.toEqual({
      status: "ready",
      checks: [...requiredChecks],
    });
  });

  it("fails at the first unavailable prerequisite and does not run later checks", async () => {
    const configured = checks("delivery-image");

    await expect(runWorkerPreflight(configured)).resolves.toEqual({
      status: "not-ready",
      failedCheck: "delivery-image",
      reason: "delivery-image unavailable",
      checks: ["docker", "container-settings", "model-gateway", "delivery-image"],
    });
    expect(configured[4]?.check).not.toHaveBeenCalled();
  });

  it("fails closed when a check throws", async () => {
    const configured = checks();
    configured[0] = { name: "docker", check: async () => { throw new Error("socket denied"); } };

    await expect(runWorkerPreflight(configured)).resolves.toEqual({
      status: "not-ready",
      failedCheck: "docker",
      reason: "socket denied",
      checks: ["docker"],
    });
  });
});
