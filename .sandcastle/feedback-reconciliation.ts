// Observe-first publication reconciliation for feedback implementation
// (#293). A canonical implementation reply carries a bounded machine-readable
// marker so a later authorized invocation can prove which branch POST it
// published before running an Agent, pushing, or replying again. Ambiguous,
// mismatched, or third-party evidence fails closed rather than guessing.

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
const FULL_REVISION = /[0-9a-f]{40}/gu;

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
      && parsed.pullRequestNumber === marker.pullRequestNumber
      && parsed.pre === marker.pre
      && parsed.post === marker.post
      && parsed.rootCommentId === marker.rootCommentId;
  }).length;
}

export type FeedbackReconciliation =
  | { readonly status: "proceed" }
  | { readonly status: "adopt"; readonly post: string }
  | { readonly status: "reply-only"; readonly post: string }
  | { readonly status: "fail-closed"; readonly reason: string };

export async function classifyFeedbackReconciliation(request: {
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRevision: string | undefined;
  readonly expectedPost?: string;
  readonly replies: readonly FeedbackThreadReply[];
  readonly parentOf: (sha: string) => Promise<string | undefined>;
}): Promise<FeedbackReconciliation> {
  const { pullRequestNumber, headSha, baseRevision } = request;

  const markerReplies = request.replies
    .map((reply) => ({ reply, marker: parseFeedbackMarker(reply.body) }))
    .filter((entry): entry is { reply: FeedbackThreadReply; marker: FeedbackReplyMarker } =>
      entry.marker !== undefined && entry.marker.pullRequestNumber === pullRequestNumber);
  const legacyCandidates = request.replies.filter((reply) => {
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
    return { status: "adopt", post: headSha };
  }
  // Legacy adoption is strictly evidence-based: a single candidate reply
  // implies one relevant root request and one linked implementation reply;
  // its unique full POST match plus the direct-child parentage proof stand in
  // for the marker the pre-marker Canary shape never carried. Any ambiguity
  // fails closed rather than guessing (#293).
  if (legacy !== undefined) {
    if (baseRevision === undefined) {
      return { status: "fail-closed", reason: "legacy feedback evidence lacks the acquired revision" };
    }
    const parent = await request.parentOf(headSha);
    if (parent !== baseRevision) {
      return { status: "fail-closed", reason: "legacy feedback evidence does not descend from the acquired revision" };
    }
    return { status: "adopt", post: headSha };
  }
  if (request.expectedPost !== undefined) {
    if (headSha !== request.expectedPost) {
      return { status: "fail-closed", reason: "reply-only completion cannot be proven for the observed head" };
    }
    return { status: "reply-only", post: headSha };
  }
  if (baseRevision !== undefined && headSha !== baseRevision) {
    return { status: "fail-closed", reason: "observed head is an unrelated third-party revision" };
  }
  return { status: "proceed" };
}
