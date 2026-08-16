import { createHash } from "node:crypto";

import type {
  ReviewRequest,
  ReviewerCapabilities,
  StageOutcome,
  ValidationRequest,
} from "@llm-wiki/afk-delivery-core";

export interface ValidationStagePorts {
  createDetachedClone(revision: string): Promise<{ path: string }>;
  runCheck(input: { worktreePath: string; command: string; timeoutMs: number }): Promise<{ exitCode: number | null; timedOut: boolean }>;
  removeDetachedClone(worktree: { path: string }): Promise<void>;
}

export function validationCheckId(request: ValidationRequest, ordinal: number): string {
  return `validation-${request.workflowRun.id}-${request.workflowRun.attempt}-${request.round}-${ordinal}-${createHash("sha256").update(request.checks[ordinal]?.command ?? "").digest("hex").slice(0, 12)}`;
}

export async function runValidationStage(
  request: ValidationRequest,
  timeoutMs: number,
  ports: ValidationStagePorts,
): Promise<Extract<StageOutcome, { kind: "validation" }>> {
  let worktree: { path: string } | undefined;
  try {
    try {
      worktree = await ports.createDetachedClone(request.revision);
    } catch {
      return {
        kind: "validation", status: "failed", failureKind: "infrastructure", revision: request.revision, round: request.round,
        commands: request.checks.map((check, ordinal) => ({ command: check.command, checkId: validationCheckId(request, ordinal), exitCode: null, timedOut: false })),
      };
    }
    const commands = [];
    for (const [ordinal, check] of request.checks.entries()) {
      try {
        const result = await ports.runCheck({ worktreePath: worktree.path, command: check.command, timeoutMs });
        commands.push({ command: check.command, checkId: validationCheckId(request, ordinal), exitCode: result.exitCode, timedOut: result.timedOut });
      } catch {
        return {
          kind: "validation", status: "failed", failureKind: "infrastructure", revision: request.revision, round: request.round,
          commands: [...commands, { command: check.command, checkId: validationCheckId(request, ordinal), exitCode: null, timedOut: false }],
        };
      }
    }
    const passed = commands.every((command) => command.exitCode === 0 && !command.timedOut);
    return {
      kind: "validation", status: passed ? "succeeded" : "failed", ...(passed ? {} : { failureKind: "code-validation" as const }),
      revision: request.revision, round: request.round, commands,
    };
  } finally {
    if (worktree !== undefined) await ports.removeDetachedClone(worktree);
  }
}

export interface ReviewStagePorts {
  runReviewer(input: { request: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

const isolatedCapabilities: ReviewerCapabilities = {
  sourceReadOnly: true,
  canEdit: false,
  canCommit: false,
  canPush: false,
  canComment: false,
  githubCredentials: false,
};

const headings = ["Verdict", "Standards", "Spec", "Interactions", "Constraints"];

function unableHandoff(reason: string): string {
  return [
    "## Verdict", "unable-to-review", "", "## Standards", `Unable to complete standards review: ${reason}`,
    "", "## Spec", `Unable to complete specification review: ${reason}`,
    "", "## Interactions", `Unable to assess interactions: ${reason}`,
    "", "## Constraints", "No approval is granted when review evidence is incomplete.",
  ].join("\n");
}

export function parseReviewHandoff(narrative: string): { disposition: "approved" | "changes-required" | "unable-to-review"; narrative: string } | undefined {
  const pattern = /^## (Verdict|Standards|Spec|Interactions|Constraints)\s*$/gmu;
  const matches = [...narrative.matchAll(pattern)];
  if (matches.length !== headings.length || matches.some((match, index) => match[1] !== headings[index])) return undefined;
  const sections = matches.map((match, index) => narrative.slice(
    (match.index ?? 0) + match[0].length,
    matches[index + 1]?.index ?? narrative.length,
  ).trim());
  const disposition = sections[0];
  if (!sections.every(Boolean) || (disposition !== "approved" && disposition !== "changes-required" && disposition !== "unable-to-review")) return undefined;
  return { disposition, narrative };
}

export function buildReviewRequest(request: ReviewRequest): string {
  return JSON.stringify(request);
}

export async function runReviewStage(
  request: ReviewRequest,
  timeoutMs: number,
  ports: ReviewStagePorts,
): Promise<Extract<StageOutcome, { kind: "review" }>> {
  let narrative: string;
  try {
    const result = await ports.runReviewer({ request: buildReviewRequest(request), timeoutMs });
    narrative = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const handoff = result.exitCode === 0 ? parseReviewHandoff(narrative) : undefined;
    if (handoff !== undefined) {
      return {
        kind: "review", status: "succeeded", revision: request.headRevision, baseRevision: request.baseRevision,
        round: request.round, disposition: handoff.disposition, narrative: handoff.narrative, capabilities: isolatedCapabilities,
      };
    }
    narrative = unableHandoff(result.exitCode === 0 ? "reviewer returned an incomplete handoff" : `reviewer exited with ${result.exitCode}`);
  } catch (error) {
    narrative = unableHandoff(error instanceof Error ? error.message : "reviewer infrastructure failure");
  }
  return {
    kind: "review", status: "succeeded", revision: request.headRevision, baseRevision: request.baseRevision,
    round: request.round, disposition: "unable-to-review", narrative, capabilities: isolatedCapabilities,
  };
}
