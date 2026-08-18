export interface LocalQualityCommandResult {
  readonly exitCode: number;
  readonly output?: string;
}

export interface LocalQualityHost {
  setup(revision: string): Promise<void>;
  run(command: readonly string[]): Promise<LocalQualityCommandResult>;
  dispose(): Promise<void>;
}

export interface LocalQualityCommitStatus {
  readonly revision: string;
  readonly context: "sandcastle/local-quality";
  readonly state: "pending" | "success" | "failure" | "error";
  readonly description: string;
}

export interface LocalQualityGithubPort {
  getPullRequestHead(pullRequestNumber: number): Promise<string>;
  publishCommitStatus(status: LocalQualityCommitStatus): Promise<void>;
}

type LocalQualityStage = "setup" | "build" | "typecheck" | "test";

export type LocalQualityResult =
  | { readonly status: "success" }
  | {
    readonly status: "failure" | "error";
    readonly stage: LocalQualityStage;
    readonly output?: string;
  };

const QUALITY_COMMANDS = [
  { stage: "build", command: ["npm", "run", "build"] },
  { stage: "typecheck", command: ["npm", "run", "typecheck"] },
  { stage: "test", command: ["npm", "test"] },
] as const;

function terminalResult(
  status: "failure" | "error",
  stage: LocalQualityStage,
  output?: string,
): LocalQualityResult {
  return { status, stage, ...(output === undefined ? {} : { output }) };
}

function errorResult(stage: LocalQualityStage, error: unknown): LocalQualityResult {
  return terminalResult(
    "error",
    stage,
    error instanceof Error ? error.message : String(error),
  );
}

async function setupAttempt(
  revision: string,
  host: LocalQualityHost,
): Promise<LocalQualityResult | undefined> {
  try {
    await host.setup(revision);
    const install = await host.run(["npm", "ci"]);
    return install.exitCode === 0
      ? undefined
      : terminalResult("error", "setup", install.output);
  } catch (error) {
    return errorResult("setup", error);
  }
}

async function disposeResult(host: LocalQualityHost): Promise<LocalQualityResult | undefined> {
  try {
    await host.dispose();
    return undefined;
  } catch (error) {
    return errorResult("setup", error);
  }
}

function statusDescription(result: LocalQualityResult): string {
  if (result.status === "success") return "Local quality checks passed";
  return result.status === "failure"
    ? `Local quality failed during ${result.stage}`
    : `Local quality error during ${result.stage}`;
}

export async function checkPullRequestLocalQuality(
  pullRequestNumber: number,
  github: LocalQualityGithubPort,
  host: LocalQualityHost,
): Promise<LocalQualityResult & { readonly revision: string }> {
  const revision = await github.getPullRequestHead(pullRequestNumber);
  await github.publishCommitStatus({
    revision,
    context: "sandcastle/local-quality",
    state: "pending",
    description: "Local quality checks started",
  });

  const result = await runLocalQuality(revision, host);
  const currentRevision = await github.getPullRequestHead(pullRequestNumber);
  if (result.status === "success" && currentRevision !== revision) {
    const staleResult = terminalResult(
      "error",
      "setup",
      "Pull Request head changed during local quality checks",
    );
    await github.publishCommitStatus({
      revision,
      context: "sandcastle/local-quality",
      state: "error",
      description: "Local quality result stale after head changed",
    });
    return { ...staleResult, revision };
  }
  await github.publishCommitStatus({
    revision,
    context: "sandcastle/local-quality",
    state: result.status,
    description: statusDescription(result),
  });
  return { ...result, revision };
}

export async function runLocalQuality(
  revision: string,
  host: LocalQualityHost,
): Promise<LocalQualityResult> {
  if (!/^[0-9a-f]{40}$/iu.test(revision)) {
    return terminalResult(
      "error",
      "setup",
      "Local quality requires a full 40-character commit SHA",
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const setupFailure = await setupAttempt(revision, host);
    if (setupFailure === undefined) break;
    const cleanupFailure = await disposeResult(host);
    if (cleanupFailure !== undefined) return cleanupFailure;
    if (attempt === 1) return setupFailure;
  }

  let stage: LocalQualityStage = "build";
  let result: LocalQualityResult = { status: "success" };
  try {
    for (const quality of QUALITY_COMMANDS) {
      stage = quality.stage;
      const commandResult = await host.run(quality.command);
      if (commandResult.exitCode !== 0) {
        result = terminalResult("failure", stage, commandResult.output);
        break;
      }
    }
  } catch (error) {
    result = errorResult(stage, error);
  }
  return (await disposeResult(host)) ?? result;
}
