import { describe, expect, it } from "vitest";

import {
  classifyFeedbackReconciliation,
  countFeedbackMarkerReplies,
  feedbackReplyMarker,
  parseFeedbackMarker,
} from "../.sandcastle/feedback-reconciliation.js";

const PRE = "a".repeat(40);
const POST = "b".repeat(40);
const OTHER = "c".repeat(40);
const ROOT = "PRRC_root";

function reply(body: string, rootCommentId = ROOT): { readonly rootCommentId: string; readonly replyCommentId: string; readonly body: string } {
  return { rootCommentId, replyCommentId: "PRRC_reply", body };
}

function classify(request: {
  readonly headSha: string;
  readonly baseRevision?: string;
  readonly expectedPost?: string;
  readonly replies?: readonly { readonly rootCommentId: string; readonly replyCommentId: string; readonly body: string }[];
  readonly parent?: string | undefined;
}) {
  return classifyFeedbackReconciliation({
    pullRequestNumber: 224,
    headSha: request.headSha,
    baseRevision: "baseRevision" in request ? request.baseRevision : PRE,
    expectedPost: request.expectedPost,
    replies: request.replies ?? [],
    parentOf: async () => request.parent,
  });
}

describe("feedback publication reconciliation", () => {
  it("marks a canonical reply with bounded machine-readable provenance", () => {
    const marker = feedbackReplyMarker({
      pullRequestNumber: 224,
      pre: PRE,
      post: POST,
      rootCommentId: ROOT,
    });
    expect(parseFeedbackMarker(marker)).toEqual({
      pullRequestNumber: 224,
      pre: PRE,
      post: POST,
      rootCommentId: ROOT,
    });
    expect(parseFeedbackMarker("Human-readable reply body.\n\n" + marker)).toEqual({
      pullRequestNumber: 224,
      pre: PRE,
      post: POST,
      rootCommentId: ROOT,
    });
    expect(parseFeedbackMarker("no marker here")).toBeUndefined();
  });

  it("counts exactly the replies matching one canonical marker", () => {
    const marker = { pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT };
    const matching = reply(feedbackReplyMarker(marker));
    const otherPost = reply(feedbackReplyMarker({ ...marker, post: OTHER }));
    expect(countFeedbackMarkerReplies([matching], marker)).toBe(1);
    expect(countFeedbackMarkerReplies([matching, otherPost], marker)).toBe(1);
    expect(countFeedbackMarkerReplies([otherPost], marker)).toBe(0);
    expect(countFeedbackMarkerReplies([matching, matching], marker)).toBe(2);
  });

  it("adopts the exact POST when one marker reply matches and POST is the direct child of PRE", async () => {
    await expect(classify({
      headSha: POST,
      replies: [reply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT }))],
      parent: PRE,
    })).resolves.toEqual({ status: "adopt", post: POST });
  });

  it("fails closed when the marker reply conflicts with the observed parent", async () => {
    await expect(classify({
      headSha: POST,
      replies: [reply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT }))],
      parent: OTHER,
    })).resolves.toEqual({ status: "fail-closed", reason: expect.stringContaining("parent") });
  });

  it("fails closed when a marker reply does not match the observed head", async () => {
    await expect(classify({
      headSha: OTHER,
      replies: [reply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT }))],
      parent: PRE,
    })).resolves.toEqual({ status: "fail-closed", reason: expect.stringContaining("third") });
  });

  it("proceeds when nothing is published for the current head", async () => {
    await expect(classify({ headSha: PRE })).resolves.toEqual({ status: "proceed" });
  });

  it("fails closed when the head moved without any publishable evidence", async () => {
    await expect(classify({ headSha: OTHER })).resolves.toEqual({
      status: "fail-closed",
      reason: expect.stringContaining("unrelated"),
    });
  });

  it("proceeds without a controlled acquired revision so acquisition can race the head", async () => {
    await expect(classify({ headSha: OTHER, baseRevision: undefined })).resolves.toEqual({ status: "proceed" });
  });

  it("adopts strict unique legacy evidence with a known acquired revision", async () => {
    await expect(classify({
      headSha: POST,
      replies: [reply(`Implemented in ${POST}.`)],
      parent: PRE,
    })).resolves.toEqual({ status: "adopt", post: POST });
  });

  it("fails closed when legacy evidence lacks the acquired revision", async () => {
    await expect(classify({
      headSha: POST,
      replies: [reply(`Implemented in ${POST}.`)],
      baseRevision: undefined,
      parent: PRE,
    })).resolves.toEqual({ status: "fail-closed", reason: expect.stringContaining("legacy") });
  });

  it("fails closed when legacy evidence does not descend from the acquired revision", async () => {
    await expect(classify({
      headSha: POST,
      replies: [reply(`Implemented in ${POST}.`)],
      parent: OTHER,
    })).resolves.toEqual({ status: "fail-closed", reason: expect.stringContaining("descend") });
  });

  it("fails closed on multiple candidate replies", async () => {
    await expect(classify({
      headSha: POST,
      replies: [
        reply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT })),
        reply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT })),
      ],
      parent: PRE,
    })).resolves.toEqual({ status: "fail-closed", reason: expect.stringContaining("multiple") });
  });

  it("fails closed when a marker and legacy candidate conflict", async () => {
    await expect(classify({
      headSha: POST,
      replies: [
        reply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: POST, rootCommentId: ROOT })),
        reply(`Implemented in ${POST}.`),
      ],
      parent: PRE,
    })).resolves.toEqual({ status: "fail-closed", reason: expect.stringContaining("multiple") });
  });

  it("fails closed when a reply matches a different POST than the observed head", async () => {
    await expect(classify({
      headSha: POST,
      replies: [reply(feedbackReplyMarker({ pullRequestNumber: 224, pre: PRE, post: OTHER, rootCommentId: ROOT }))],
      parent: PRE,
    })).resolves.toEqual({ status: "fail-closed", reason: expect.stringContaining("third") });
  });

  it("allows a controlled reply-only completion when the POST and intent are proven", async () => {
    await expect(classify({
      headSha: POST,
      expectedPost: POST,
      parent: PRE,
    })).resolves.toEqual({ status: "reply-only", post: POST });
  });

  it("refuses reply-only completion without an expected POST", async () => {
    await expect(classify({
      headSha: POST,
      parent: PRE,
    })).resolves.toEqual({ status: "fail-closed", reason: expect.stringContaining("unrelated") });
  });

  it("refuses reply-only completion when the head is not the expected POST", async () => {
    await expect(classify({
      headSha: OTHER,
      expectedPost: POST,
      parent: PRE,
    })).resolves.toEqual({ status: "fail-closed", reason: expect.stringContaining("reply-only") });
  });
});
