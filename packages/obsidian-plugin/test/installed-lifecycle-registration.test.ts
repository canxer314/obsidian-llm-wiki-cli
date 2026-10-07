import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { observeIsolatedMcpRegistration } from "../src/installed-runtime/installed-lifecycle-registration.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const vaultId = "11111111-1111-4111-8111-111111111111";
async function arrange() {
  const root = await mkdtemp(join(tmpdir(), "475-registration-")); roots.push(root);
  const vaultPath = join(root, "installed-runtime-vault-registration");
  const configDirectory = join(root, "installed-runtime-profile-registration", "agent");
  await mkdir(vaultPath); await mkdir(configDirectory, { recursive: true });
  return { root, vaultPath, configDirectory, configPath: join(configDirectory, ".claude.json"), vaultId, port: 27123 };
}

it("a printed registration command or simulated flag is not an observed local Agent registration", async () => {
  const options = await arrange();
  await writeFile(options.configPath, JSON.stringify({ projects: {} }));
  const result = await observeIsolatedMcpRegistration({ ...options, registered: true,
    registrationCommand: "claude mcp add --scope local ...",
    runAgentCommand: async () => { throw new Error("Missing local registration must not be probed as registered"); },
  } as never);
  expect(result).toMatchObject({ state: "absent", agentConnected: false });
});

it("requires matching local config and an independently connected real Agent inspection", async () => {
  const options = await arrange();
  await writeFile(options.configPath, JSON.stringify({ projects: { [options.vaultPath]: { mcpServers: {
    [`vault-${vaultId}`]: { type: "http", url: "http://127.0.0.1:27123/mcp", headers: { "X-Expected-Vault-ID": vaultId } },
  } } } }));
  const calls: unknown[] = [];
  const result = await observeIsolatedMcpRegistration({ ...options, runAgentCommand: async request => {
    calls.push(request);
    return { exitCode: 0, stdout: `vault-${vaultId}:\n  Scope: Local config (private to you in this project)\n  Status: ✓ Connected\n  Type: http\n  URL: http://127.0.0.1:27123/mcp\n  Headers:\n    X-Expected-Vault-ID: ${vaultId}\n` };
  } });
  expect(result).toMatchObject({ state: "registered", agentConnected: true });
  expect(calls).toEqual([{ args: ["mcp", "get", `vault-${vaultId}`], cwd: options.vaultPath, configDirectory: options.configDirectory }]);
  expect(JSON.stringify(result)).not.toContain(vaultId);
  expect(JSON.stringify(result)).not.toContain(options.root);
});

it("rejects malformed config, a wrong identity, pending approval and self-reported passed summaries", async () => {
  const options = await arrange();
  await writeFile(options.configPath, "{broken");
  await expect(observeIsolatedMcpRegistration(options)).rejects.toThrow();
  await writeFile(options.configPath, JSON.stringify({ projects: { [options.vaultPath]: { mcpServers: {
    [`vault-${vaultId}`]: { type: "http", url: "http://127.0.0.1:27123/mcp", headers: { "X-Expected-Vault-ID": "foreign" } },
  } } } }));
  expect(await observeIsolatedMcpRegistration(options)).toMatchObject({ state: "identity_mismatch", agentConnected: false });
  await writeFile(options.configPath, JSON.stringify({ projects: { [options.vaultPath]: { mcpServers: {
    [`vault-${vaultId}`]: { type: "http", url: "http://127.0.0.1:27123/mcp", headers: { "X-Expected-Vault-ID": vaultId } },
  } } } }));
  for (const stdout of ['{"verdict":"passed","registered":true}', "Status: ⏸ Pending approval", "Status: ✓ Connected", `vault-${vaultId}:\nScope: Local config (private to you in this project)\nStatus: ✓ Connected\nType: http\nURL: http://127.0.0.1:27124/mcp\nX-Expected-Vault-ID: ${vaultId}`, `vault-other-run:\nScope: Local config (private to you in this project)\nStatus: ✓ Connected\nType: http\nURL: http://127.0.0.1:27123/mcp\nX-Expected-Vault-ID: ${vaultId}`]) {
    await expect(observeIsolatedMcpRegistration({ ...options, runAgentCommand: async () => ({ exitCode: 0, stdout }) })).rejects.toThrow("independently confirmed");
  }
});

it("rejects contradictory Agent output instead of cherry-picking a Connected line", async () => {
  const options = await arrange();
  await writeFile(options.configPath, JSON.stringify({ projects: { [options.vaultPath]: { mcpServers: {
    [`vault-${vaultId}`]: { type: "http", url: "http://127.0.0.1:27123/mcp", headers: { "X-Expected-Vault-ID": vaultId } },
  } } } }));
  const stdout = `vault-${vaultId}:\nScope: Local config (private to you in this project)\nStatus: ✓ Connected\nStatus: ✗ Failed\nType: http\nURL: http://127.0.0.1:27123/mcp\nX-Expected-Vault-ID: ${vaultId}\n`;
  await expect(observeIsolatedMcpRegistration({ ...options, runAgentCommand: async () => ({ exitCode: 0, stdout }) })).rejects.toThrow("independently confirmed");
});

it("refuses config outside the generated isolated Agent profile and rejects a symlinked config", async () => {
  const options = await arrange();
  const daily = join(options.root, "daily-client"); await mkdir(daily);
  await writeFile(join(daily, ".claude.json"), '{"projects":{}}');
  await expect(observeIsolatedMcpRegistration({ ...options, configDirectory: daily })).rejects.toThrow("isolated");
  const { symlink } = await import("node:fs/promises");
  await symlink(join(daily, ".claude.json"), options.configPath);
  await expect(observeIsolatedMcpRegistration(options)).rejects.toThrow("symlink");
});
