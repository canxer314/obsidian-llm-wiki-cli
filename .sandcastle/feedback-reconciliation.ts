// Observe-first publication reconciliation for feedback implementation.
// Durable GitHub evidence is scoped to the one immutable review root selected
// before Agent execution; ambiguity fails closed rather than guessing.

export interface FeedbackThreadReply {
  readonly rootCommentId: string;
  readonly replyCommentId: string;
  readonly body: string;
}

export interface FeedbackReplyMarker {
  readonly pullRequestNumber: number;
  readonly pre: string;
  readonly post: string;
  readonly rootCommentId: string;
}

const MARKER_PATTERN = /<!--\s*feedback-reconcile\s+op=feedback\s+pr=(\d+)\s+pre=([0-9a-f]{40})\s+post=([0-9a-f]{40})\s+root=([A-Za-z0-9_-]+)\s*-->/u;
const MARKER_SHAPE = /<!--\s*feedback-reconcile\b/gu;
const FULL_REVISION = /[0-9a-f]{40}/gu;

function markerShapeCount(body: string): number {
  return body.match(MARKER_SHAPE)?.length ?? 0;
}

export function feedbackReplyMarker(request: FeedbackReplyMarker): string {
  return `<!-- feedback-reconcile op=feedback pr=${request.pullRequestNumber} pre=${request.pre} post=${request.post} root=${request.rootCommentId} -->`;
}

export function parseFeedbackMarker(body: string): FeedbackReplyMarker | undefined {
  const match = MARKER_PATTERN.exec(body);
  if (match === null) return undefined;
  return {
    pullRequestNumber: Number(match[1]),
    pre: match[2]!,
    post: match[3]!,
    rootCommentId: match[4]!,
  };
}

export function countFeedbackMarkerReplies(
  replies: readonly FeedbackThreadReply[],
  marker: FeedbackReplyMarker,
): number {
  return replies.filter((reply) => {
    const parsed = parseFeedbackMarker(reply.body);
    return parsed !== undefined
      && reply.rootCommentId === marker.rootCommentId
      && parsed.pullRequestNumber === marker.pullRequestNumber
      && parsed.pre === marker.pre
      && parsed.post === marker.post
      && parsed.rootCommentId === marker.rootCommentId;
  }).length;
}

export type FeedbackMarkerReplyReadback = "none" | "exactly-one" | "conflict";

export function inspectFeedbackMarkerReplies(
  replies: readonly FeedbackThreadReply[],
  marker: FeedbackReplyMarker,
): FeedbackMarkerReplyReadback {
  const selectedReplies = replies.filter((reply) => reply.rootCommentId === marker.rootCommentId);
  if (selectedReplies.some((reply) => markerShapeCount(reply.body) > 1)) return "conflict";
  const matchingReplies = countFeedbackMarkerReplies(selectedReplies, marker);
  if (selectedReplies.length === 0) return "none";
  if (selectedReplies.length !== 1 || matchingReplies !== 1) return "conflict";
  const parsed = parseFeedbackMarker(selectedReplies[0]!.body);
  return parsed !== undefined && parsed.rootCommentId === selectedReplies[0]!.rootCommentId
    ? "exactly-one"
    : "conflict";
}

export type FeedbackReconciliation =
  | { readonly status: "proceed" }
  | { readonly status: "adopt"; readonly post: string }
  | { readonly status: "reply-only"; readonly post: string }
  | { readonly status: "fail-closed"; readonly reason: string };

export interface FeedbackReviewState {
  readonly unresolvedRootCommentIds: readonly string[];
  readonly replies: readonly FeedbackThreadReply[];
}

export type FeedbackIntentSelection =
  | { readonly status: "selected"; readonly rootCommentId: string }
  | { readonly status: "none" }
  | { readonly status: "fail-closed"; readonly reason: string };

export async function selectFeedbackIntent(request: {
  readonly pullRequestNumber: number;
  readonly invocation?: "ordinary" | "reconcile";
  readonly state: FeedbackReviewState;
  readonly parentOf: (sha: string) => Promise<string | undefined>;
}): Promise<FeedbackIntentSelection> {
  const roots = [...new Set(request.state.unresolvedRootCommentIds)];
  if (roots.length !== request.state.unresolvedRootCommentIds.length) {
    return { status: "fail-closed", reason: "feedback review state contains duplicate roots" };
  }
  const pending: string[] = [];
  const completed: string[] = [];
  for (const rootCommentId of roots) {
    const replies = request.state.replies.filter((reply) => reply.rootCommentId === rootCommentId);
    if (replies.some((reply) => markerShapeCount(reply.body) > 1)) {
      return { status: "fail-closed", reason: "feedback thread has multiple marker-shaped replies" };
    }
    const markers = replies
      .map((reply) => ({ reply, marker: parseFeedbackMarker(reply.body) }))
      .filter((entry): entry is { reply: FeedbackThreadReply; marker: FeedbackReplyMarker } =>
        entry.marker !== undefined && entry.marker.pullRequestNumber === request.pullRequestNumber,
      );
    if (markers.length === 0) {
      const legacyReplies = replies.filter((reply) => {
        const hexes = reply.body.match(FULL_REVISION) ?? [];
        return hexes.length === 1;
      });
      if (legacyReplies.length === 0) {
        if (replies.length > 0) {
          return { status: "fail-closed", reason: "feedback thread has non-canonical reply evidence" };
        }
        pending.push(rootCommentId);
        continue;
      }
      if (request.invocation === "reconcile" && legacyReplies.length === 1 && replies.length === 1) {
        completed.push(rootCommentId);
        continue;
      }
      return { status: "fail-closed", reason: "feedback thread has non-canonical reply evidence" };
    }
    if (
      markers.length !== 1 ||
      replies.length !== 1 ||
      markers[0]!.reply.rootCommentId !== markers[0]!.marker.rootCommentId ||
      (await request.parentOf(markers[0]!.marker.post)) !== markers[0]!.marker.pre
    ) {
      return { status: "fail-closed", reason: "feedback thread has ambiguous marker or follow-up evidence" };
    }
    completed.push(rootCommentId);
  }
  if (pending.length === 0) {
    if (completed.length === 1) return { status: "selected", rootCommentId: completed[0]! };
    return { status: "none" };
  }
  if (pending.length !== 1) return { status: "fail-closed", reason: "feedback review state has multiple unresolved intents" };
  return { status: "selected", rootCommentId: pending[0]! };
}

export async function classifyFeedbackReconciliation(request: {
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRevision: string | undefined;
  readonly expectedPost?: string;
  readonly expectedReplyRootCommentId?: string;
  readonly intentRootCommentId?: string;
  readonly invocation?: "ordinary" | "reconcile";
  readonly replies: readonly FeedbackThreadReply[];
  readonly parentOf: (sha: string) => Promise<string | undefined>;
}): Promise<FeedbackReconciliation> {
  const { pullRequestNumber, headSha, baseRevision, intentRootCommentId } = request;
  const invocation = request.invocation ?? (baseRevision === undefined ? "ordinary" : "reconcile");
  const selectedReplies = intentRootCommentId === undefined
    ? request.replies
    : request.replies.filter((reply) => reply.rootCommentId === intentRootCommentId);

  if (intentRootCommentId !== undefined && selectedReplies.some((reply) => markerShapeCount(reply.body) !== 0 && parseFeedbackMarker(reply.body) === undefined)) {
    return { status: "fail-closed", reason: "current feedback reply contains a malformed marker" };
  }
  if (intentRootCommentId !== undefined && selectedReplies.some((reply) => markerShapeCount(reply.body) > 1)) {
    return { status: "fail-closed", reason: "current feedback reply contains multiple marker-shaped evidence" };
  }
  if (intentRootCommentId !== undefined && selectedReplies.length > 1) {
    return { status: "fail-closed", reason: "current feedback thread has an unrepresentable follow-up" };
  }

  const markerReplies = selectedReplies
    .map((reply) => ({ reply, marker: parseFeedbackMarker(reply.body) }))
    .filter((entry): entry is { reply: FeedbackThreadReply; marker: FeedbackReplyMarker } =>
      entry.marker !== undefined && entry.marker.pullRequestNumber === pullRequestNumber);
  if (intentRootCommentId !== undefined && markerReplies.some(({ reply, marker }) => reply.rootCommentId !== marker.rootCommentId)) {
    return { status: "fail-closed", reason: "current feedback marker root conflicts with its linked thread" };
  }
  const legacyCandidates = selectedReplies.filter((reply) => {
    if (markerReplies.some((entry) => entry.reply === reply)) return false;
    const hexes = reply.body.match(FULL_REVISION) ?? [];
    return hexes.length === 1 && hexes[0] === headSha;
  });

  if (markerReplies.length + legacyCandidates.length > 1) {
    return { status: "fail-closed", reason: "multiple candidate feedback replies" };
  }

  const marker = markerReplies[0]?.marker;
  const legacy = legacyCandidates[0];
  if (marker !== undefined) {
    if (marker.post !== headSha) {
      return { status: "fail-closed", reason: "feedback reply references a third-party head" };
    }
    const parent = await request.parentOf(headSha);
    if (parent !== marker.pre) {
      return { status: "fail-closed", reason: "feedback reply provenance conflicts with the observed parent" };
    }
    if (invocation !== "reconcile") {
      return { status: "fail-closed", reason: "matching feedback evidence requires explicit reconcile authorization" };
    }
    return { status: "adopt", post: headSha };
  }
  if (legacy !== undefined) {
    if (invocation !== "reconcile" || baseRevision === undefined) {
      return { status: "fail-closed", reason: "legacy feedback evidence lacks the acquired revision" };
    }
    const parent = await request.parentOf(headSha);
    if (parent !== baseRevision) {
      return { status: "fail-closed", reason: "legacy feedback evidence does not descend from the acquired revision" };
    }
    return { status: "adopt", post: headSha };
  }
  if (request.expectedPost !== undefined) {
    if (
      invocation !== "reconcile" ||
      request.expectedReplyRootCommentId === undefined ||
      intentRootCommentId === undefined ||
      request.expectedReplyRootCommentId !== intentRootCommentId ||
      headSha !== request.expectedPost
    ) {
      return { status: "fail-closed", reason: "reply-only completion cannot be proven for the current feedback intent" };
    }
    return { status: "reply-only", post: headSha };
  }
  if (baseRevision !== undefined && headSha !== baseRevision) {
    return { status: "fail-closed", reason: "observed head is an unrelated third-party revision" };
  }
  return { status: "proceed" };
}
