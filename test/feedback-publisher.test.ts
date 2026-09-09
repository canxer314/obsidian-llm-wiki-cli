import { describe, expect, it, vi } from "vitest";

import type { CheckoutObserver } from "../.sandcastle/checkout-safety.js";
import { StopRetryError, isStopRetry } from "../.sandcastle/invocation-recovery.js";
import { createFeedbackPublisher } from "../.sandcastle/feedback-publisher.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REMOTE = "https://github.com/example/repository.git";

// The publisher's clean-checkout proof is an injected seam in these tests;
// production defaults to the real checkout observer.
function cleanObserver() {
  const snapshot = { head: SHA_B, entries: [] };
  const requireClean = vi.fn().mockResolvedValue(snapshot);
  const observer = {
    observe: vi.fn().mockResolvedValue(snapshot),
    requireClean,
    requireUnchanged: vi.fn().mockResolvedValue(snapshot),
  } as CheckoutObserver;
  return { observer, requireClean };
}

describe("feedback publisher", () => {
  it("pushes the feedback commit with an exact lease after proving the checkout clean", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${REMOTE}\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const { observer, requireClean } = cleanObserver();
    const publisher = createFeedbackPublisher({ execute, observer });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
    })).resolves.toBe(SHA_B);

    // Head verification runs first, then the clean-checkout proof, then the
    // remote lookup and leased push.
    expect(execute).toHaveBeenNthCalledWith(1, "git", ["-C", "/checkout", "rev-parse", "HEAD"]);
    expect(requireClean).toHaveBeenCalledOnce();
    expect(requireClean).toHaveBeenCalledWith("/checkout");
    expect(execute).toHaveBeenNthCalledWith(2, "git", ["-C", "/checkout", "remote", "get-url", "origin"]);
    expect(execute).toHaveBeenNthCalledWith(3, "git", [
      "-C", "/checkout", "push", REMOTE,
      `--force-with-lease=refs/heads/feature/feedback:${SHA_A}`,
      "HEAD:refs/heads/feature/feedback",
    ]);
  });

  it("never pushes from a dirty checkout: the clean-checkout proof gates the push", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_B}\n`, stderr: "" });
    const { observer, requireClean } = cleanObserver();
    requireClean.mockRejectedValueOnce(
      new StopRetryError("Target Checkout is not clean (staged=0, unstaged=1, unmerged=0, untracked=0)"),
    );
    const publisher = createFeedbackPublisher({ execute, observer });

    const failure = await publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
    }).catch((error: unknown) => error);

    expect(isStopRetry(failure)).toBe(true);
    expect((failure as Error).message).toContain("Target Checkout is not clean");
    // Head verification ran; the remote lookup and the push never did.
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("git", ["-C", "/checkout", "rev-parse", "HEAD"]);
  });

  it("rejects an unchanged revision before the clean-checkout proof runs", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ stdout: `${SHA_A}\n`, stderr: "" });
    const { observer, requireClean } = cleanObserver();
    const publisher = createFeedbackPublisher({ execute, observer });

    await expect(publisher.publish({
      checkoutPath: "/checkout",
      branch: "feature/feedback",
      expectedRevision: SHA_A,
    })).rejects.toThrow("Feedback implementation did not create a new local revision");
    expect(requireClean).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });
});
