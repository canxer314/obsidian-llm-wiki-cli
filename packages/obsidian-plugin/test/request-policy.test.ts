import { createServer, request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { rejectRequest, verifyRequestPolicy } from "../src/request-policy.js";

const servers: Array<ReturnType<typeof createServer>> = [];

async function startPolicyServer(actualVaultId: string): Promise<URL> {
  const server = createServer((request, response) => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("not listening");
    const failure = verifyRequestPolicy(request, actualVaultId, address.port);
    if (failure !== null) {
      rejectRequest(response, failure);
      return;
    }
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("not listening");
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function requestWithHost(
  endpoint: URL,
  host: string,
): Promise<{ status: number; body: unknown; headers: import("node:http").IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      endpoint,
      {
        headers: { Host: host, "X-Expected-Vault-ID": "vault-a" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: text.length === 0 ? undefined : JSON.parse(text),
            headers: response.headers,
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        }),
    ),
  );
});

describe("loopback HTTP request policy", () => {
  it("accepts only the expected Vault identity on an allowed loopback Host", async () => {
    const endpoint = await startPolicyServer("vault-a");

    const accepted = await fetch(endpoint, {
      headers: { "X-Expected-Vault-ID": "vault-a" },
    });
    const missing = await fetch(endpoint);
    const mismatched = await fetch(endpoint, {
      headers: { "X-Expected-Vault-ID": "vault-b" },
    });

    expect(accepted.status).toBe(204);
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({
      error: { message: "missing_expected_vault_id" },
    });
    expect(mismatched.status).toBe(403);
    expect(await mismatched.json()).toMatchObject({
      error: { message: "mismatched_expected_vault_id" },
    });
  });

  it("rejects untrusted Host and Origin values without permissive CORS", async () => {
    const endpoint = await startPolicyServer("vault-a");
    const invalidHost = await requestWithHost(endpoint, "attacker.example");
    const invalidOrigin = await fetch(endpoint, {
      headers: {
        Origin: "https://attacker.example",
        "X-Expected-Vault-ID": "vault-a",
      },
    });
    const sameOrigin = await fetch(endpoint, {
      headers: {
        Origin: endpoint.origin,
        "X-Expected-Vault-ID": "vault-a",
      },
    });

    expect(invalidHost.status).toBe(403);
    expect(invalidHost.body).toMatchObject({ error: { message: "invalid_host" } });
    expect(invalidOrigin.status).toBe(403);
    expect(await invalidOrigin.json()).toMatchObject({
      error: { message: "invalid_origin" },
    });
    expect(invalidOrigin.headers.has("access-control-allow-origin")).toBe(false);
    expect(sameOrigin.status).toBe(204);
  });
});
