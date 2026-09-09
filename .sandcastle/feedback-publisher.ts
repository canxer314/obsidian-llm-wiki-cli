import { createExactLeasePublisher } from "./exact-lease-publisher.ts";

const FEEDBACK_DIAGNOSTICS = {
  invalidAcquiredRevision: "Feedback publication requires a full expected revision",
  invalidExpectedRevision: "Feedback publication requires a full expected revision",
  invalidBranch: "Feedback publication branch is invalid",
  checkoutMismatch: "Feedback checkout did not start at the acquired revision",
  invalidResultingRevision: "Feedback implementation did not create a full local revision",
  invalidRemote: "Feedback publication remote is invalid",
} as const;

export function createFeedbackPublisher(options: {
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
    diagnostics: FEEDBACK_DIAGNOSTICS,
    revisionPolicy: {
      requireNewRevision: true,
      unchangedRevisionDiagnostic: "Feedback implementation did not create a new local revision",
    },
  });
}
