import { describe, expect, it, vi } from "vitest";
import {
  runBoundedDeliveryWorker,
  type PreflightCheck,
} from "../src/index.js";

const failedPreflight: PreflightCheck = {
  name: "docker",
  check: async () => ({ ok: false, reason: "daemon unavailable" }),
};

describe("runBoundedDeliveryWorker", () => {
  it("performs no GitHub state mutation when preflight fails", async () => {
    const reconstruct = vi.fn();
    const dispatch = vi.fn();

    await expect(runBoundedDeliveryWorker({
      preflightChecks: [failedPreflight],
      reconstruct,
      dispatch,
    })).resolves.toEqual({
      status: "preflight-failed",
      failedCheck: "docker",
      reason: "daemon unavailable",
    });
    expect(reconstruct).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reconstructs after preflight and dispatches exactly one transition", async () => {
    const snapshot = { ticketNumber: 64 };
    const reconstruct = vi.fn(async () => snapshot);
    const dispatch = vi.fn(async () => ({ transitionId: "afk-v1-1" }));

    await expect(runBoundedDeliveryWorker({
      preflightChecks: [{ name: "docker", check: async () => ({ ok: true }) }],
      reconstruct,
      dispatch,
    })).resolves.toEqual({ status: "dispatched", transitionId: "afk-v1-1" });
    expect(reconstruct).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(snapshot, undefined);
  });

  it("propagates cancellation and never dispatches after reconstruction aborts", async () => {
    const controller = new AbortController();
    const dispatch = vi.fn();

    await expect(runBoundedDeliveryWorker({
      preflightChecks: [{ name: "docker", check: async () => ({ ok: true }) }],
      reconstruct: async () => {
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      },
      dispatch,
    }, controller.signal)).rejects.toThrow("cancelled");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
