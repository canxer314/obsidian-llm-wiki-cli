import { spawn } from "node:child_process";

// The GitHub-capable Agent Session container environment carries the
// transport and Claude/API allowlists plus GH_TOKEN and the operator git
// identity (#267, #269), and the Agent image installs the GitHub CLI. The
// readiness probe runs `gh auth status` — a read-only token validation
// against api.github.com — inside that exact content-addressed image and
// environment, so a missing or invalid container credential fails closed
// before the Dispatcher acquires any Automation Work Item for an operation
// that can start a GitHub-capable Agent, and before any trigger,
// `agent:in-progress`, `agent:blocked`, or diagnostic mutation.

export type GithubAgentReadiness = "ready" | "missing" | "invalid" | "unavailable";

export interface GithubAgentReadinessProcess {
  run(
    args: readonly string[],
    environment: Readonly<Record<string, string>>,
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
  }>;
}

const MISSING_AUTHENTICATION = /not logged in|no oauth token|no token (?:found|configured)/iu;
const PROBE_INCAPABLE = /dial tcp|connection refused|could not resolve|timed out|no such file|command not found|unable to find image/i;
const INVALID_AUTHENTICATION = /\b401\b|bad credentials|authentication failed|unauthorized|invalid token|could not fetch scopes/iu;

function probeEnvironment(environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return { ...environment, HOME: "/home/agent" };
}

function probeArguments(options: {
  readonly image: string;
  readonly uid: number;
  readonly gid: number;
  readonly environment: Readonly<Record<string, string>>;
}): readonly string[] {
  // The same container launch parameters the GitHub-capable Agent Session
  // sandbox uses: the exact githubAgent environment plus the provider-imposed
  // HOME, the host UID/GID, and the host network. The image's `sleep infinity`
  // entrypoint is overridden so the probe command itself runs.
  return [
    "run",
    "--rm",
    "--network",
    "host",
    "--user",
    `${options.uid}:${options.gid}`,
    ...Object.keys(probeEnvironment(options.environment)).flatMap((name) => [
      "-e",
      name,
    ]),
    "--entrypoint",
    "sh",
    options.image,
    "-c",
    "timeout 30s gh auth status --show-token=false",
  ];
}

export const githubAgentReadinessProcess: GithubAgentReadinessProcess = {
  run: (args, environment) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn("docker", args, {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("close", (exitCode) => resolvePromise({ stdout, stderr, exitCode }));
    }),
};

function classify(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}): GithubAgentReadiness {
  if (result.exitCode === 0) return "ready";
  const diagnostics = `${result.stdout}\n${result.stderr}`;
  if (MISSING_AUTHENTICATION.test(diagnostics)) return "missing";
  if (PROBE_INCAPABLE.test(diagnostics)) return "unavailable";
  // gh reports authentication failures with exit code 4.
  if (result.exitCode === 4 || INVALID_AUTHENTICATION.test(diagnostics)) return "invalid";
  return "unavailable";
}

export async function githubAgentReadiness(options: {
  readonly image: string;
  readonly uid: number;
  readonly gid: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly process?: GithubAgentReadinessProcess;
}): Promise<GithubAgentReadiness> {
  if (options.environment.GH_TOKEN === undefined) return "missing";
  let result: { readonly stdout: string; readonly stderr: string; readonly exitCode: number | null };
  try {
    result = await (options.process ?? githubAgentReadinessProcess).run(
      probeArguments(options),
      probeEnvironment(options.environment),
    );
  } catch {
    return "unavailable";
  }
  return classify(result);
}

// Stable, classified, redacted failures: raw probe stdout/stderr, token
// values, and the image name never reach error messages, logs, retained
// artifacts, or GitHub diagnostics.
const READINESS_ERROR_MESSAGES: Readonly<Record<Exclude<GithubAgentReadiness, "ready">, string>> = {
  missing: "GitHub-capable Agent container authentication is not ready; GH_TOKEN is missing from the private environment file",
  invalid: "GitHub-capable Agent container authentication is not ready; GH_TOKEN in the private environment file does not authenticate",
  unavailable: "GitHub-capable Agent container authentication readiness is unavailable; run `npm run sandcastle -- inspect`",
};

export class GithubAgentReadinessError extends Error {
  readonly classification: Exclude<GithubAgentReadiness, "ready">;
  constructor(classification: Exclude<GithubAgentReadiness, "ready">) {
    super(READINESS_ERROR_MESSAGES[classification]);
    this.name = "GithubAgentReadinessError";
    this.classification = classification;
  }
}

export async function requireGithubAgentReadiness(options: {
  readonly image: string;
  readonly uid: number;
  readonly gid: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly process?: GithubAgentReadinessProcess;
}): Promise<void> {
  const readiness = await githubAgentReadiness(options);
  if (readiness === "ready") return;
  throw new GithubAgentReadinessError(readiness);
}

// Operations whose Agent Session contract invokes the GitHub CLI receive the
// GitHub-capable container environment (#267): Issue/PRD planning and
// implementation, feedback implementation, Pull Request review, and PRD
// splitting. Architecture review, branch update, label setup, and inspection
// stay on the narrower Claude-only automationSandbox and never run the probe.
const GITHUB_CAPABLE_OPERATIONS = ["review", "implement", "implement-prd", "feedback", "split"] as const;

export function githubAgentReadinessRequiredFor(operation: string): boolean {
  return (GITHUB_CAPABLE_OPERATIONS as readonly string[]).includes(operation);
}
