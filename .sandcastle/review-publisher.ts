import { createExactLeasePublisher } from "./exact-lease-publisher.ts";

const REVIEW_DIAGNOSTICS = {
  invalidAcquiredRevision: "Review publication requires a full expected revision",
  invalidExpectedRevision: "Review publication requires a full expected revision",
  invalidBranch: "Review publication branch is invalid",
  checkoutMismatch: "Review checkout did not start at the acquired revision",
  invalidResultingRevision: "Reviewer did not leave a full local revision",
  invalidRemote: "Review publication remote is invalid",
} as const;

export function createReviewPublisher(options: {
  readonly execute?: Parameters<typeof createExactLeasePublisher>[0]["execute"];
  readonly sourceRepositoryPath?: string;
  readonly gitEnvironment?: Readonly<Record<string, string>>;
}) {
  return createExactLeasePublisher({
    ...(options.execute === undefined ? {} : { execute: options.execute }),
    ...(options.sourceRepositoryPath === undefined
      ? {}
      : { sourceRepositoryPath: options.sourceRepositoryPath }),
    ...(options.gitEnvironment === undefined
      ? {}
      : { gitEnvironment: options.gitEnvironment }),
    diagnostics: REVIEW_DIAGNOSTICS,
    revisionPolicy: { requireNewRevision: false },
    configureCheckout: async (checkoutPath, git) => {
      await git(["-C", checkoutPath, "config", "user.name", "claude-code[bot]"]);
      await git([
        "-C", checkoutPath,
        "config", "user.email", "claude-code[bot]@users.noreply.github.com",
      ]);
    },
  });
}
