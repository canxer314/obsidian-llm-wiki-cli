import type { LocalQualityResult } from "./local-quality.js";
import type {
  ReviewerAgentSession,
  ReviewerFinding,
  ReviewerOutput,
} from "./reviewer-session.js";

export interface ReviewCommitStatus {
  readonly revision: string;
  readonly context: "sandcastle/review";
  readonly state: "pending" | "success" | "failure" | "error";
  readonly description: string;
}

export interface ReviewGithubPort {
  getPullRequestHead(pullRequestNumber: number): Promise<string>;
  publishCommitStatus(status: ReviewCommitStatus): Promise<void>;
  addPullRequestComment(pullRequestNumber: number, body: string): Promise<void>;
}

export type ReviewResult =
  | (ReviewerOutput & {
    readonly status: "success" | "failure";
    readonly revision: string;
  })
  | { readonly status: "error"; readonly revision: string };

function formatFindings(findings: readonly ReviewerFinding[]): string {
  if (findings.length === 0) return "None.";
  return findings
    .map((finding) => `- **${finding.summary}** — ${finding.details}`)
    .join("\n");
}

function formatComment(revision: string, output: ReviewerOutput): string {
  return [
    `## Sandcastle review: ${output.verdict}`,
    "",
    output.summary,
    "",
    "### Findings",
    "",
    formatFindings(output.findings),
    "",
    `Reviewed revision: \`${revision}\``,
  ].join("\n");
}

export async function reviewPullRequest(options: {
  readonly pullRequestNumber: number;
  readonly revision: string;
  readonly localQuality: LocalQualityResult & { readonly revision: string };
  readonly model: string;
  readonly session: ReviewerAgentSession;
  readonly github: ReviewGithubPort;
}): Promise<ReviewResult> {
  if (options.localQuality.status !== "success") {
    throw new Error("Independent review requires successful local quality");
  }
  if (options.localQuality.revision !== options.revision) {
    throw new Error("Independent review requires local quality for the same revision");
  }

  const startingRevision = await options.github.getPullRequestHead(
    options.pullRequestNumber,
  );
  if (startingRevision !== options.revision) {
    await options.github.publishCommitStatus({
      revision: options.revision,
      context: "sandcastle/review",
      state: "error",
      description: "Independent review stale before start",
    });
    return { status: "error", revision: options.revision };
  }

  let pendingPublished = false;
  try {
    await options.github.publishCommitStatus({
      revision: options.revision,
      context: "sandcastle/review",
      state: "pending",
      description: "Independent review started",
    });
    pendingPublished = true;
    let output: ReviewerOutput;
    try {
      output = await options.session.run({
        pullRequestNumber: options.pullRequestNumber,
        revision: options.revision,
        model: options.model,
      });
    } catch {
      await options.github.publishCommitStatus({
        revision: options.revision,
        context: "sandcastle/review",
        state: "error",
        description: "Independent review session failed",
      });
      await options.github.addPullRequestComment(
        options.pullRequestNumber,
        [
          "## Sandcastle review error",
          "",
          "The independent Reviewer session failed before producing a valid verdict.",
          "",
          `Reviewed revision: \`${options.revision}\``,
        ].join("\n"),
      );
      return { status: "error", revision: options.revision };
    }

    const currentRevision = await options.github.getPullRequestHead(
      options.pullRequestNumber,
    );
    if (currentRevision !== options.revision) {
      await options.github.publishCommitStatus({
        revision: options.revision,
        context: "sandcastle/review",
        state: "error",
        description: "Independent review stale after head changed",
      });
      await options.github.addPullRequestComment(
        options.pullRequestNumber,
        [
          "## Sandcastle review discarded",
          "",
          "The Pull Request head changed before this review could be published.",
          "",
          `Reviewed revision: \`${options.revision}\``,
        ].join("\n"),
      );
      return { status: "error", revision: options.revision };
    }

    const status = output.verdict === "Approved" ? "success" : "failure";
    try {
      await options.github.addPullRequestComment(
        options.pullRequestNumber,
        formatComment(options.revision, output),
      );
    } catch {
      await options.github.publishCommitStatus({
        revision: options.revision,
        context: "sandcastle/review",
        state: "error",
        description: "Independent review audit comment failed",
      });
      return { status: "error", revision: options.revision };
    }

    const revisionAfterComment = await options.github.getPullRequestHead(
      options.pullRequestNumber,
    );
    if (revisionAfterComment !== options.revision) {
      await options.github.publishCommitStatus({
        revision: options.revision,
        context: "sandcastle/review",
        state: "error",
        description: "Independent review stale after head changed",
      });
      await options.github.addPullRequestComment(
        options.pullRequestNumber,
        [
          "## Sandcastle review discarded",
          "",
          "The Pull Request head changed after the review audit was recorded.",
          "",
          `Reviewed revision: \`${options.revision}\``,
        ].join("\n"),
      );
      return { status: "error", revision: options.revision };
    }

    await options.github.publishCommitStatus({
      revision: options.revision,
      context: "sandcastle/review",
      state: status,
      description: output.verdict === "Approved"
        ? "Independent review approved"
        : "Independent review requested changes",
    });

    const publishedRevision = await options.github.getPullRequestHead(
      options.pullRequestNumber,
    );
    if (publishedRevision !== options.revision) {
      await options.github.publishCommitStatus({
        revision: options.revision,
        context: "sandcastle/review",
        state: "error",
        description: "Independent review stale after head changed",
      });
      await options.github.addPullRequestComment(
        options.pullRequestNumber,
        [
          "## Sandcastle review discarded",
          "",
          "The Pull Request head changed while the review status was being published.",
          "",
          `Reviewed revision: \`${options.revision}\``,
        ].join("\n"),
      );
      return { status: "error", revision: options.revision };
    }

    return { status, revision: options.revision, ...output };
  } catch (error) {
    if (pendingPublished) {
      try {
        await options.github.publishCommitStatus({
          revision: options.revision,
          context: "sandcastle/review",
          state: "error",
          description: "Independent review could not complete",
        });
      } catch {
        // Preserve the original gate failure when terminal status publication also fails.
      }
    }
    throw error;
  }
}
