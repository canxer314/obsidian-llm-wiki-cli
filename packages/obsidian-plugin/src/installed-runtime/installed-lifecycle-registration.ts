import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

export interface AgentRegistrationCommandRequest {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly configDirectory: string;
}
export type AgentRegistrationCommand = (request: AgentRegistrationCommandRequest) => Promise<{ exitCode: number; stdout: string }>;
const exec = promisify(execFile);
/** The only command this observer runs is read-only `mcp get`; never add/remove. */
export const inspectRealAgentRegistration: AgentRegistrationCommand = async request => {
  const { stdout } = await exec("claude", [...request.args], {
    cwd: request.cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: request.configDirectory },
    timeout: 30_000, maxBuffer: 64 * 1024,
  });
  return { exitCode: 0, stdout };
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Read the actual isolated config separately from the Agent's connected status.
 * Raw config, command output, IDs and paths are private and never returned. */
export async function observeIsolatedMcpRegistration(options: {
  readonly configDirectory: string;
  readonly vaultPath: string;
  readonly vaultId: string;
  readonly port: number;
  readonly runAgentCommand?: AgentRegistrationCommand;
}) {
  const configDirectory = resolve(options.configDirectory);
  const vaultPath = resolve(options.vaultPath);
  const run = basename(vaultPath).replace(/^installed-runtime-vault-/u, "");
  if (!basename(vaultPath).startsWith("installed-runtime-vault-") || configDirectory !== join(dirname(vaultPath), `installed-runtime-profile-${run}`, "agent")) {
    throw new Error("MCP observation requires the generated isolated Agent profile");
  }
  if (await realpath(configDirectory) !== configDirectory || await realpath(vaultPath) !== vaultPath || (await lstat(join(configDirectory, ".claude.json"))).isSymbolicLink()) {
    throw new Error("Isolated MCP config must not traverse a symlink");
  }
  const bytes = await readFile(join(configDirectory, ".claude.json"), "utf8");
  const config = JSON.parse(bytes);
  if (typeof config !== "object" || config === null || typeof config.projects !== "object" || config.projects === null || Array.isArray(config.projects)) {
    throw new Error("Local MCP config state is uncertain");
  }
  const name = `vault-${options.vaultId}`;
  const server = config.projects?.[vaultPath]?.mcpServers?.[name];
  if (server === undefined) return { state: "absent" as const, agentConnected: false, configSha256: digest(bytes), agentObservationSha256: null };
  const url = `http://127.0.0.1:${options.port}/mcp`;
  if (server.type !== "http" || server.url !== url || server.headers?.["X-Expected-Vault-ID"] !== options.vaultId) {
    return { state: "identity_mismatch" as const, agentConnected: false, configSha256: digest(bytes), agentObservationSha256: null };
  }
  const observed = await (options.runAgentCommand ?? inspectRealAgentRegistration)({ args: ["mcp", "get", name], cwd: vaultPath, configDirectory });
  const lines = observed.stdout.split(/\r?\n/u).map(line => line.trim());
  const uniqueLine = (prefix: string, expected: string) => {
    const values = lines.filter(line => line.startsWith(prefix));
    return values.length === 1 && values[0] === expected;
  };
  if (observed.exitCode !== 0 || lines.filter(line => line === `${name}:`).length !== 1 ||
      !uniqueLine("Scope:", "Scope: Local config (private to you in this project)") ||
      !uniqueLine("Status:", "Status: ✓ Connected") || !uniqueLine("Type:", "Type: http") ||
      !uniqueLine("URL:", `URL: ${url}`) || !uniqueLine("X-Expected-Vault-ID:", `X-Expected-Vault-ID: ${options.vaultId}`)) {
    throw new Error("Local Agent registration could not be independently confirmed");
  }
  if (await readFile(join(configDirectory, ".claude.json"), "utf8") !== bytes) throw new Error("Local MCP config changed during registration observation");
  return { state: "registered" as const, agentConnected: true, configSha256: digest(bytes), agentObservationSha256: digest(observed.stdout) };
}
