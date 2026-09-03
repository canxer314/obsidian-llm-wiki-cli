import { createHash } from "node:crypto";

import type {
  MutationCorpusBoundary,
  MutationCorpusBoundaryFileState,
  MutationCorpusCrashPoint,
  MutationCorpusFileFixture,
  MutationCorpusProfile,
  MutationCorpusProofState,
} from "./crash-corpus-runner.js";

export const COPY_ATTACHMENT_LABEL = "copy-attachment";
export const MOVE_ATTACHMENT_LABEL = "move-attachment";
export const MULTI_ATTACHMENT_LABEL = "multi-attachment";

export const COPY_ATTACHMENT_SOURCE_PATH = "Corpus/Attachments/Copy-source.bin";
export const COPY_ATTACHMENT_DESTINATION_PATH = "Corpus/Attachments/Copy-destination.bin";
export const MOVE_ATTACHMENT_SOURCE_PATH = "Corpus/Attachments/Move-source.bin";
export const MOVE_ATTACHMENT_DESTINATION_PATH = "Corpus/Attachments/Move-destination.bin";
export const MULTI_COPY_SOURCE_PATH = "Corpus/Attachments/Multi-copy-source.bin";
export const MULTI_COPY_DESTINATION_PATH = "Corpus/Attachments/Multi-copy-destination.bin";
export const MULTI_MOVE_SOURCE_PATH = "Corpus/Attachments/Multi-move-source.bin";
export const MULTI_MOVE_DESTINATION_PATH = "Corpus/Attachments/Multi-move-destination.bin";

export const COPY_ATTACHMENT_BYTES = Uint8Array.from([
  0x00, 0xff, 0x10, 0x80, 0x42, 0x00, 0xc3, 0x28, 0x7f, 0x0a, 0xfe,
]);
export const MOVE_ATTACHMENT_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x81,
]);
export const MULTI_COPY_ATTACHMENT_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x7e, 0x00, 0x10, 0x80,
]);
export const MULTI_MOVE_ATTACHMENT_BYTES = Uint8Array.from([
  0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0xc0, 0xde, 0x0a, 0x00,
]);

type AttachmentOperation =
  | {
      readonly kind: "copy_attachment";
      readonly sourcePath: string;
      readonly destinationPath: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "move_attachment";
      readonly sourcePath: string;
      readonly destinationPath: string;
      readonly bytes: Uint8Array;
    };

interface AttachmentProfileDefinition {
  readonly kind: string;
  readonly label: string;
  readonly primaryPath: string;
  readonly files: readonly MutationCorpusFileFixture[];
  readonly operations: readonly AttachmentOperation[];
}

function attachmentExpectedSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function crashPointName(crashPoint: MutationCorpusCrashPoint): string {
  return crashPoint.point.replace(/[^A-Za-z0-9_-]/gu, "_");
}

export function attachmentCrashPoints(operationCount: number): readonly MutationCorpusCrashPoint[] {
  return [
    { point: "before_prepared", phase: "apply" },
    { point: "after_prepared", phase: "apply" },
    ...Array.from({ length: operationCount }, (_, index) => ({
      point: `after_mutation:${index}`,
      phase: "apply" as const,
    })),
    { point: "after_raw_verification", phase: "apply" },
    { point: "during_semantic_evidence", phase: "apply" },
    { point: "after_semantic_evidence", phase: "apply" },
    { point: "after_snapshot", phase: "apply" },
    { point: "after_committed", phase: "apply" },
    { point: "before_rollback", phase: "rollback" },
    ...Array.from({ length: operationCount }, (_, index) => ({
      point: `after_rollback_mutation:${index}`,
      phase: "rollback" as const,
    })),
    { point: "after_rollback_verification", phase: "rollback" },
    { point: "after_rollback_evidence", phase: "rollback" },
    { point: "before_rolled_back", phase: "rollback" },
    { point: "after_rolled_back", phase: "rollback" },
  ];
}

function proofStateAt(point: string): MutationCorpusProofState {
  return point === "after_committed" || point === "before_prepared"
    ? "intent_applied"
    : "intent_not_applied";
}

function journalPhaseAt(point: string): MutationCorpusBoundary["journalPhase"] {
  if (point === "before_prepared") return null;
  if (point === "after_committed") return "COMMITTED";
  if (point === "after_rolled_back") return "ROLLED_BACK";
  return "PREPARED";
}

function committedStates(
  definition: AttachmentProfileDefinition,
  appliedOperationCount: number,
): Map<string, MutationCorpusBoundaryFileState> {
  const states = new Map<string, MutationCorpusBoundaryFileState>(
    definition.files.map(({ path, originalBytes }) => [
      path,
      originalBytes === null ? "absent" : "original",
    ]),
  );
  for (const operation of definition.operations.slice(0, appliedOperationCount)) {
    states.set(operation.destinationPath, "committed");
    if (operation.kind === "move_attachment") states.set(operation.sourcePath, "absent");
  }
  return states;
}

function boundaryStates(
  definition: AttachmentProfileDefinition,
  point: string,
): Map<string, MutationCorpusBoundaryFileState> {
  if (point === "before_prepared" || point === "after_prepared") {
    return committedStates(definition, 0);
  }
  if (point.startsWith("after_mutation:")) {
    return committedStates(
      definition,
      Number(point.slice("after_mutation:".length)) + 1,
    );
  }
  if (point.startsWith("after_rollback_mutation:")) {
    const restored = Number(point.slice("after_rollback_mutation:".length)) + 1;
    return committedStates(definition, Math.max(0, definition.operations.length - restored));
  }
  if (
    point === "after_rollback_verification" ||
    point === "after_rollback_evidence" ||
    point === "before_rolled_back" ||
    point === "after_rolled_back"
  ) {
    return committedStates(definition, 0);
  }
  return committedStates(definition, definition.operations.length);
}

function boundaryFor(
  definition: AttachmentProfileDefinition,
  point: string,
): MutationCorpusBoundary {
  const states = boundaryStates(definition, point);
  return {
    journalPhase: journalPhaseAt(point),
    files: definition.files.map(({ path }) => ({ path, state: states.get(path)! })),
  };
}

function attachmentProfile(definition: AttachmentProfileDefinition): MutationCorpusProfile {
  return {
    kind: definition.kind,
    label: definition.label,
    files: definition.files,
    primaryPath: definition.primaryPath,
    submissionKey: (seed) => `submission-${seed}`,
    buildSubmitInput: (seed) => ({
      submissionKey: `submission-${seed}`,
      operations: definition.operations.map((operation, index) => ({
        operationId: `${definition.label}-${index}-${seed}`,
        kind: operation.kind,
        sourcePath: operation.sourcePath,
        destinationPath: operation.destinationPath,
        expectedSha256: attachmentExpectedSha256(operation.bytes),
      })),
    }),
    crashPoints: attachmentCrashPoints(definition.operations.length),
    rollbackLeadInPoint: "after_snapshot",
    expectedBoundary: (crashPoint) => boundaryFor(definition, crashPoint.point),
    expectedProofState: (crashPoint) => proofStateAt(crashPoint.point),
    timeoutMs: 90_000,
  };
}

const copyAttachmentDefinition: AttachmentProfileDefinition = {
  kind: "copy_attachment",
  label: COPY_ATTACHMENT_LABEL,
  primaryPath: COPY_ATTACHMENT_SOURCE_PATH,
  files: [
    {
      path: COPY_ATTACHMENT_SOURCE_PATH,
      kind: "attachment",
      originalBytes: COPY_ATTACHMENT_BYTES,
      committedBytes: COPY_ATTACHMENT_BYTES,
    },
    {
      path: COPY_ATTACHMENT_DESTINATION_PATH,
      kind: "attachment",
      originalBytes: null,
      committedBytes: COPY_ATTACHMENT_BYTES,
    },
  ],
  operations: [
    {
      kind: "copy_attachment",
      sourcePath: COPY_ATTACHMENT_SOURCE_PATH,
      destinationPath: COPY_ATTACHMENT_DESTINATION_PATH,
      bytes: COPY_ATTACHMENT_BYTES,
    },
  ],
};

const moveAttachmentDefinition: AttachmentProfileDefinition = {
  kind: "move_attachment",
  label: MOVE_ATTACHMENT_LABEL,
  primaryPath: MOVE_ATTACHMENT_SOURCE_PATH,
  files: [
    {
      path: MOVE_ATTACHMENT_SOURCE_PATH,
      kind: "attachment",
      originalBytes: MOVE_ATTACHMENT_BYTES,
      committedBytes: null,
    },
    {
      path: MOVE_ATTACHMENT_DESTINATION_PATH,
      kind: "attachment",
      originalBytes: null,
      committedBytes: MOVE_ATTACHMENT_BYTES,
    },
  ],
  operations: [
    {
      kind: "move_attachment",
      sourcePath: MOVE_ATTACHMENT_SOURCE_PATH,
      destinationPath: MOVE_ATTACHMENT_DESTINATION_PATH,
      bytes: MOVE_ATTACHMENT_BYTES,
    },
  ],
};

const multiAttachmentDefinition: AttachmentProfileDefinition = {
  kind: "attachment_multi_copy_move",
  label: MULTI_ATTACHMENT_LABEL,
  primaryPath: MULTI_COPY_SOURCE_PATH,
  files: [
    {
      path: MULTI_COPY_SOURCE_PATH,
      kind: "attachment",
      originalBytes: MULTI_COPY_ATTACHMENT_BYTES,
      committedBytes: MULTI_COPY_ATTACHMENT_BYTES,
    },
    {
      path: MULTI_COPY_DESTINATION_PATH,
      kind: "attachment",
      originalBytes: null,
      committedBytes: MULTI_COPY_ATTACHMENT_BYTES,
    },
    {
      path: MULTI_MOVE_SOURCE_PATH,
      kind: "attachment",
      originalBytes: MULTI_MOVE_ATTACHMENT_BYTES,
      committedBytes: null,
    },
    {
      path: MULTI_MOVE_DESTINATION_PATH,
      kind: "attachment",
      originalBytes: null,
      committedBytes: MULTI_MOVE_ATTACHMENT_BYTES,
    },
  ],
  operations: [
    {
      kind: "copy_attachment",
      sourcePath: MULTI_COPY_SOURCE_PATH,
      destinationPath: MULTI_COPY_DESTINATION_PATH,
      bytes: MULTI_COPY_ATTACHMENT_BYTES,
    },
    {
      kind: "move_attachment",
      sourcePath: MULTI_MOVE_SOURCE_PATH,
      destinationPath: MULTI_MOVE_DESTINATION_PATH,
      bytes: MULTI_MOVE_ATTACHMENT_BYTES,
    },
  ],
};

export function seedForCopyAttachment(crashPoint: MutationCorpusCrashPoint): string {
  return `${COPY_ATTACHMENT_LABEL}-${crashPointName(crashPoint)}`;
}

export function seedForMoveAttachment(crashPoint: MutationCorpusCrashPoint): string {
  return `${MOVE_ATTACHMENT_LABEL}-${crashPointName(crashPoint)}`;
}

export function seedForMultiAttachment(crashPoint: MutationCorpusCrashPoint): string {
  return `${MULTI_ATTACHMENT_LABEL}-${crashPointName(crashPoint)}`;
}

export function copyAttachmentCorpusProfile(): MutationCorpusProfile {
  return attachmentProfile(copyAttachmentDefinition);
}

export function moveAttachmentCorpusProfile(): MutationCorpusProfile {
  return attachmentProfile(moveAttachmentDefinition);
}

export function multiAttachmentCorpusProfile(): MutationCorpusProfile {
  return attachmentProfile(multiAttachmentDefinition);
}
