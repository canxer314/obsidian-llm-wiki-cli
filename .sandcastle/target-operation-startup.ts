import type { Readable } from "node:stream";

import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

import type { createChildEnvironments } from "./automation-environment.ts";
import type { SandcastleModels } from "./private-config.ts";
import {
  frozenStringRecord,
  hasExactOwnKeys,
  ownDataPropertyValues,
} from "./protocol-record.ts";

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

const startupKeys = new Set(["imageName", "childEnvironments", "models"]);
const childEnvironmentKeys = new Set(["git", "github", "claude", "githubAgent"]);
const modelKeys = new Set(["default", "planner", "implementer", "reviewer"]);

function ownValues(
  value: unknown,
  keys?: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | undefined {
  const values = ownDataPropertyValues(value);
  if (values === undefined) return undefined;
  if (keys !== undefined && !hasExactOwnKeys(values, keys)) return undefined;
  return values;
}

export function targetOperationStartupSnapshot(value: unknown): TargetOperationStartupSnapshot {
  const candidate = ownValues(value, startupKeys);
  const childEnvironments = ownValues(candidate?.childEnvironments, childEnvironmentKeys);
  const models = ownValues(candidate?.models, modelKeys);
  const git = frozenStringRecord(childEnvironments?.git);
  const github = frozenStringRecord(childEnvironments?.github);
  const claude = frozenStringRecord(childEnvironments?.claude);
  const githubAgent = frozenStringRecord(childEnvironments?.githubAgent);
  if (
    candidate === undefined || typeof candidate.imageName !== "string" || candidate.imageName.length === 0 ||
    childEnvironments === undefined || git === undefined || github === undefined ||
    claude === undefined || githubAgent === undefined || models === undefined ||
    typeof models.default !== "string" || models.default.length === 0 ||
    typeof models.planner !== "string" || models.planner.length === 0 ||
    typeof models.implementer !== "string" || models.implementer.length === 0 ||
    typeof models.reviewer !== "string" || models.reviewer.length === 0
  ) throw new Error("Target operation startup snapshot is invalid");
  return Object.freeze({
    imageName: candidate.imageName,
    childEnvironments: Object.freeze({ git, github, claude, githubAgent }),
    models: Object.freeze({
      default: models.default,
      planner: models.planner,
      implementer: models.implementer,
      reviewer: models.reviewer,
    }),
  });
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
  const sandboxEnvironment = frozenStringRecord(candidate.sandboxEnvironment);
  const githubEnvironment = candidate.githubEnvironment === undefined
    ? undefined
    : frozenStringRecord(candidate.githubEnvironment);
  if (
    typeof candidate.imageName !== "string" || candidate.imageName.length === 0 ||
    sandboxEnvironment === undefined ||
    (candidate.githubEnvironment !== undefined && githubEnvironment === undefined)
  ) {
    throw new Error("Target worker startup snapshot is invalid");
  }
  return {
    sandbox: createSandboxProvider(sandboxEnvironment, candidate.imageName),
    ...(githubEnvironment === undefined ? {} : { githubEnvironment }),
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
