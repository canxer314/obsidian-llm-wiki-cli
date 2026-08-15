import type { ImplementationAgentInvocation } from "./implementation.js";

const ALLOWED_ENVIRONMENT = new Set(["MODEL_GATEWAY_URL", "MODEL_GATEWAY_TOKEN"]);

export interface ImplementationContainerCommand {
  file: "docker";
  args: string[];
  stdin: string;
  timeoutMs: number;
  environment: Record<string, string>;
  redactedEnvironment: Record<string, string>;
}

export function buildImplementationContainerCommand(
  image: string,
  invocation: ImplementationAgentInvocation,
): ImplementationContainerCommand {
  for (const name of Object.keys(invocation.environment)) {
    if (!ALLOWED_ENVIRONMENT.has(name)) {
      throw new Error(`forbidden implementation-stage environment variable: ${name}`);
    }
  }
  const environment = { ...invocation.environment };
  const redactedEnvironment = Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      name,
      name.endsWith("TOKEN") ? "[REDACTED]" : value,
    ]),
  );
  const args = [
    "run",
    "--rm",
    "--user", "agent",
    "--read-only",
    "--cpus", String(invocation.cpuLimit),
    "--mount", `type=bind,source=${invocation.worktreePath},target=/workspace`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m",
    "--tmpfs", "/home/agent:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700",
    "--add-host", "host.docker.internal:host-gateway",
    "--workdir", "/workspace",
  ];
  for (const name of Object.keys(environment).sort()) {
    args.push("--env", name);
  }
  args.push(
    "--env", `AFK_MODEL=${invocation.model}`,
    "--env", `AFK_CONTEXT_WINDOW=${invocation.contextWindow}`,
    "--env", `AFK_MAX_ITERATIONS=${invocation.maximumIterations}`,
    image,
  );
  return {
    file: "docker",
    args,
    stdin: invocation.prompt,
    timeoutMs: invocation.timeoutMs,
    environment,
    redactedEnvironment,
  };
}
