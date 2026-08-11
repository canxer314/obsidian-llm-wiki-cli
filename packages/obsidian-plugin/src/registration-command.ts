const LOOPBACK_ADDRESS = "127.0.0.1";
const MCP_PATH = "/mcp";

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createRegistrationCommand(
  vaultId: string,
  port: number,
  serverName = `vault-${vaultId}`,
): string {
  if (port < 1 || port > 65_535 || !Number.isInteger(port)) {
    throw new Error("Bridge Instance must be started first");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(serverName)) {
    throw new Error("Claude Code MCP server name contains unsupported characters");
  }
  return [
    "claude mcp add",
    "--transport http",
    "--scope local",
    `--header ${quotePowerShell(`X-Expected-Vault-ID: ${vaultId}`)}`,
    serverName,
    quotePowerShell(`http://${LOOPBACK_ADDRESS}:${port}${MCP_PATH}`),
  ].join(" ");
}
