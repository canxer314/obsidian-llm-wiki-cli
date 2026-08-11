import type { IncomingMessage, ServerResponse } from "node:http";

export const EXPECTED_VAULT_ID_HEADER = "x-expected-vault-id";

export type RequestPolicyFailure =
  | "invalid_host"
  | "invalid_origin"
  | "authentication_failed"
  | "missing_expected_vault_id"
  | "mismatched_expected_vault_id";

export function verifyRequestPolicy(
  request: IncomingMessage,
  actualVaultId: string,
  port: number,
): RequestPolicyFailure | null {
  if (
    request.socket.localAddress !== "127.0.0.1" ||
    request.socket.remoteAddress !== "127.0.0.1"
  ) {
    return "invalid_host";
  }

  const host = request.headers.host;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (host === undefined || !allowedHosts.has(host.toLowerCase())) {
    return "invalid_host";
  }

  const origin = request.headers.origin;
  if (origin !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return "invalid_origin";
    }
    if (
      parsed.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(parsed.hostname.toLowerCase()) ||
      parsed.port !== String(port)
    ) {
      return "invalid_origin";
    }
  }

  const expectedVaultId = request.headers[EXPECTED_VAULT_ID_HEADER];
  if (typeof expectedVaultId !== "string" || expectedVaultId.length === 0) {
    return "missing_expected_vault_id";
  }
  if (expectedVaultId !== actualVaultId) {
    return "mismatched_expected_vault_id";
  }

  return null;
}

export function rejectRequest(
  response: ServerResponse,
  failure: RequestPolicyFailure,
): void {
  response.writeHead(403, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32_000, message: failure },
      id: null,
    }),
  );
}
