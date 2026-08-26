import { describe, expect, it, vi } from "vitest";

import { convergeFeedbackHead } from "../.sandcastle/feedback-convergence.js";
import { classifyGithubReadError } from "../.sandcastle/github-cli.js";

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
      classifyReadError: () => ({ kind: "deterministic" as const }),
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
      classifyReadError: () => ({ kind: "transient" as const }),
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
      classifyReadError: () => ({ kind: "deterministic" as const }),
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
      classifyReadError: () => ({ kind: "deterministic" as const }),
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
      classifyReadError: () => ({ kind: "deterministic" as const }),
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
      classifyReadError: () => ({ kind: "transient" as const }),
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
      classifyReadError: () => ({ kind: "deterministic" as const }),
      attempts: 3,
      wait: async (_classification, attempt) => { waits.push(attempt); },
    });
    expect(waits).toEqual([1]);
  });
  it("fails fast without waiting when the production classifier sees target number 429", async () => {
    const waits: string[] = [];
    const error = Object.assign(new Error("Command failed: gh pr view 429 --json headRefOid"), {
      stderr: "HTTP 404 Not Found",
    });
    const readHead = vi.fn().mockRejectedValue(error);

    await expect(convergeFeedbackHead({
      expectedPost: POST,
      acquiredPre: PRE,
      readHead,
      classifyReadError: classifyGithubReadError,
      attempts: 3,
      wait: async (classification) => { waits.push(classification.kind); },
    })).rejects.toBe(error);

    expect(readHead).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("uses one dedicated rate-limit wait rather than propagation polling", async () => {
    const waits: { readonly classification: string; readonly attempt: number }[] = [];
    const readHead = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 403: API rate limit exceeded"))
      .mockResolvedValueOnce(POST);

    await expect(convergeFeedbackHead({
      expectedPost: POST,
      acquiredPre: PRE,
      readHead,
      classifyReadError: (error) => error instanceof Error && error.message.includes("rate limit")
        ? { kind: "rate-limited" }
        : { kind: "deterministic" },
      attempts: 3,
      wait: async (classification, attempt) => { waits.push({ classification: classification.kind, attempt }); },
    })).resolves.toEqual({ status: "converged", sha: POST });

    expect(waits).toEqual([{ classification: "rate-limited", attempt: 1 }]);
    expect(readHead).toHaveBeenCalledTimes(2);
  });

  it("fails closed after a second rate-limit response", async () => {
    const waits: string[] = [];
    const readHead = vi.fn().mockRejectedValue(new Error("HTTP 429"));

    await expect(convergeFeedbackHead({
      expectedPost: POST,
      acquiredPre: PRE,
      readHead,
      classifyReadError: () => ({ kind: "rate-limited" }),
      attempts: 3,
      wait: async (classification) => { waits.push(classification.kind); },
    })).resolves.toEqual({ status: "indeterminate" });

    expect(waits).toEqual(["rate-limited"]);
    expect(readHead).toHaveBeenCalledTimes(2);
  });
  it("still performs the dedicated rate-limit retry after the normal polling budget is exhausted", async () => {
    const waits: string[] = [];
    const readHead = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 429"))
      .mockResolvedValueOnce(POST);

    await expect(convergeFeedbackHead({
      expectedPost: POST,
      acquiredPre: PRE,
      readHead,
      classifyReadError: () => ({ kind: "rate-limited" }),
      attempts: 1,
      wait: async (classification) => { waits.push(classification.kind); },
    })).resolves.toEqual({ status: "converged", sha: POST });

    expect(waits).toEqual(["rate-limited"]);
    expect(readHead).toHaveBeenCalledTimes(2);
  });
});