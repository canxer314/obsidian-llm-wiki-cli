import type { Readable } from "node:stream";

import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

import type { createChildEnvironments } from "./automation-environment.ts";
import type { SandcastleModels } from "./private-config.ts";

function createSandboxProvider(
  environment: Readonly<Record<string, string>>,
  imageName: string,
) {
  return docker({ imageName, network: "host", env: { ...environment } });
}

export interface TargetOperationStartupSnapshot {
  readonly imageName: string;
  readonly childEnvironments: Pick<
    ReturnType<typeof createChildEnvironments>,
    "git" | "github" | "claude" | "githubAgent"
  >;
  readonly models: SandcastleModels;
}

function strings(value: unknown): value is Readonly<Record<string, string>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

export function targetOperationStartupSnapshot(value: unknown): TargetOperationStartupSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Target operation startup snapshot is invalid");
  }
  const candidate = value as Partial<TargetOperationStartupSnapshot>;
  if (
    typeof candidate.imageName !== "string" || candidate.imageName.length === 0 ||
    typeof candidate.childEnvironments !== "object" || candidate.childEnvironments === null ||
    !strings(candidate.childEnvironments.git) ||
    !strings(candidate.childEnvironments.github) ||
    !strings(candidate.childEnvironments.claude) ||
    !strings(candidate.childEnvironments.githubAgent) ||
    typeof candidate.models !== "object" || candidate.models === null ||
    typeof candidate.models.default !== "string" || candidate.models.default.length === 0 ||
    typeof candidate.models.planner !== "string" || candidate.models.planner.length === 0 ||
    typeof candidate.models.implementer !== "string" || candidate.models.implementer.length === 0 ||
    typeof candidate.models.reviewer !== "string" || candidate.models.reviewer.length === 0
  ) {
    throw new Error("Target operation startup snapshot is invalid");
  }
  return candidate as TargetOperationStartupSnapshot;
}

export interface TargetWorkerStartupSnapshot {
  readonly imageName: string;
  readonly sandboxEnvironment: Readonly<Record<string, string>>;
  readonly githubEnvironment?: Readonly<Record<string, string>>;
}

export function targetWorkerStartup(
  snapshot: TargetOperationStartupSnapshot,
  profile: "github-agent" | "github-agent-with-cli" | "claude-only",
): string {
  return JSON.stringify({
    imageName: snapshot.imageName,
    sandboxEnvironment: profile === "claude-only"
      ? snapshot.childEnvironments.claude
      : snapshot.childEnvironments.githubAgent,
    ...(profile === "github-agent-with-cli"
      ? { githubEnvironment: snapshot.childEnvironments.github }
      : {}),
  } satisfies TargetWorkerStartupSnapshot);
}

export async function readTargetWorkerStartup(
  input: Readable = process.stdin,
): Promise<{
  readonly sandbox: ReturnType<typeof createSandboxProvider>;
  readonly githubEnvironment?: Readonly<Record<string, string>>;
}> {
  let serialized = "";
  for await (const chunk of input) serialized += String(chunk);
  if (serialized.length === 0) throw new Error("Target worker startup snapshot is missing");
  const candidate = JSON.parse(serialized) as Partial<TargetWorkerStartupSnapshot>;
  if (
    typeof candidate.imageName !== "string" || candidate.imageName.length === 0 ||
    !strings(candidate.sandboxEnvironment) ||
    (candidate.githubEnvironment !== undefined && !strings(candidate.githubEnvironment))
  ) {
    throw new Error("Target worker startup snapshot is invalid");
  }
  return {
    sandbox: createSandboxProvider(candidate.sandboxEnvironment, candidate.imageName),
    ...(candidate.githubEnvironment === undefined ? {} : { githubEnvironment: candidate.githubEnvironment }),
  };
}

export async function readTargetOperationStartup(
  input: Readable = process.stdin,
): Promise<{
  readonly serialized: string;
  readonly snapshot: TargetOperationStartupSnapshot;
  readonly githubAgentSandbox: ReturnType<typeof createSandboxProvider>;
  readonly automationSandbox: ReturnType<typeof createSandboxProvider>;
}> {
  let serialized = "";
  for await (const chunk of input) serialized += String(chunk);
  if (serialized.length === 0) throw new Error("Target operation startup snapshot is missing");
  const snapshot = targetOperationStartupSnapshot(JSON.parse(serialized));
  return {
    serialized,
    snapshot,
    githubAgentSandbox: createSandboxProvider(
      snapshot.childEnvironments.githubAgent,
      snapshot.imageName,
    ),
    automationSandbox: createSandboxProvider(
      snapshot.childEnvironments.claude,
      snapshot.imageName,
    ),
  };
}
