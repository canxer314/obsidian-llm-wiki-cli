import { describe, expect, it, vi } from "vitest";

import { convergeFeedbackHead } from "../.sandcastle/feedback-convergence.js";

const PRE = "a".repeat(40);
const POST = "b".repeat(40);
const OTHER = "c".repeat(40);

const noWait = async () => {};

describe("feedback head convergence", () => {
  it("treats a temporary observation of the acquired PRE as propagation", async () => {
    const readHead = vi.fn()
      .mockResolvedValueOnce(PRE)
      .mockResolvedValueOnce(POST);
    await expect(convergeFeedbackHead({
      expectedPost: POST,
      acquiredPre: PRE,
      readHead,
      isTransientReadError: () => false,
      attempts: 3,
      wait: noWait,
    })).resolves.toEqual({ status: "converged", sha: POST });
    expect(readHead).toHaveBeenCalledTimes(2);
  });

  it("retries only explicitly transient read errors within the budget", async () => {
    const readHead = vi.fn()
      .mockRejectedValueOnce(new Error("network reset"))
      .mockResolvedValueOnce(POST);
    await expect(convergeFeedbackHead({
      expectedPost: POST,
      acquiredPre: PRE,
      readHead,
      isTransientReadError: () => true,
      attempts: 3,
      wait: noWait,
    })).resolves.toEqual({ status: "converged", sha: POST });
    expect(readHead).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient read errors", async () => {
    const readHead = vi.fn().mockRejectedValueOnce(new Error("unexpected shape"));
    await expect(convergeFeedbackHead({
      expectedPost: POST,
      acquiredPre: PRE,
      readHead,
      isTransientReadError: () => false,
      attempts: 3,
      wait: noWait,
    })).rejects.toThrow("unexpected shape");
    expect(readHead).toHaveBeenCalledTimes(1);
  });

  it("returns indeterminate when reads stay at PRE until exhaustion", async () => {
    const readHead = vi.fn().mockResolvedValue(PRE);
    await expect(convergeFeedbackHead({
      expectedPost: POST,
      acquiredPre: PRE,
      readHead,
      isTransientReadError: () => false,
      attempts: 3,
      wait: noWait,
    })).resolves.toEqual({ status: "indeterminate" });
    expect(readHead).toHaveBeenCalledTimes(3);
  });

  it("fails closed on a third-party head without waiting", async () => {
    const readHead = vi.fn().mockResolvedValueOnce(OTHER);
    await expect(convergeFeedbackHead({
      expectedPost: POST,
      acquiredPre: PRE,
      readHead,
      isTransientReadError: () => false,
      attempts: 3,
      wait: noWait,
    })).resolves.toEqual({ status: "race", sha: OTHER });
    expect(readHead).toHaveBeenCalledTimes(1);
  });

  it("returns indeterminate when transient errors exhaust the budget", async () => {
    const readHead = vi.fn().mockRejectedValue(new Error("network reset"));
    await expect(convergeFeedbackHead({
      expectedPost: POST,
      acquiredPre: PRE,
      readHead,
      isTransientReadError: () => true,
      attempts: 2,
      wait: noWait,
    })).resolves.toEqual({ status: "indeterminate" });
    expect(readHead).toHaveBeenCalledTimes(2);
  });

  it("waits with the injectable delay between attempts", async () => {
    const waits: number[] = [];
    const readHead = vi.fn()
      .mockResolvedValueOnce(PRE)
      .mockResolvedValueOnce(POST);
    await convergeFeedbackHead({
      expectedPost: POST,
      acquiredPre: PRE,
      readHead,
      isTransientReadError: () => false,
      attempts: 3,
      wait: async (attempt) => { waits.push(attempt); },
    });
    expect(waits).toEqual([1]);
  });
});
