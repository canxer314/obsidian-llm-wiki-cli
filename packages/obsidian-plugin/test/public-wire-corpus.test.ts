import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
  canonicalPublicWireCorpusManifest,
  createPublicWireCorpusManifest,
  READ_SIDE_CORPUS_ID,
  READ_SIDE_SCENARIO_PLAN,
  registerHealthPublicWireFragment,
  runPublicWireCorpus,
} from "../src/index.js";

it("sends the literal unsafe Host header when probing the connection boundary", async () => {
  const hosts: string[] = [];
  const server = createServer((request, response) => {
    hosts.push(request.headers.host ?? "");
    response.writeHead(hosts.length <= 4 ? 403 : 500);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Server unavailable");
    await runPublicWireCorpus({
      endpoint: new URL(`http://127.0.0.1:${address.port}/mcp`),
      expectedVaultId: "fixture-vault", fixtureSeed: "fixture",
    }).catch(() => undefined);
    expect(hosts[2]).toBe("outside.example:80");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const SHA256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("authoritative public-wire corpus manifest", () => {
  it("assembles six independently registered deterministic fragments", () => {
    const first = createPublicWireCorpusManifest();
    const second = createPublicWireCorpusManifest();

    expect(canonicalPublicWireCorpusManifest(first)).toEqual(
      canonicalPublicWireCorpusManifest(second),
    );
    expect(first.fragments.map(({ tool }) => tool).sort()).toEqual([
      "vault_change_set_status",
      "vault_change_set_submit",
      "vault_continue",
      "vault_discover",
      "vault_health",
      "vault_read",
    ]);
  });

  it("rejects a manifest that does not cover exactly the public six-tool contract", () => {
    expect(() =>
      createPublicWireCorpusManifest((register) => {
        registerHealthPublicWireFragment(register);
      }),
    ).toThrow("exactly six tools");
  });
});

describe("read-side corpus deterministic plan", () => {
  it("names a closed discovery/read/continuation scenario program", () => {
    expect(READ_SIDE_CORPUS_ID).toBe("discovery-reads-continuation");
    expect([...READ_SIDE_SCENARIO_PLAN]).toEqual([
      "discovery/empty-result",
      "discovery/combined-graph",
      "discovery/inventory-before",
      "read/ordered-byte-exact-and-no-section-fallback",
      "read/single-note-over-limit-refusal",
      "read/multi-note-logical-grouping",
      "continuation/framing-reconstructs-frozen-result",
      "continuation/single-use-replay-rejected",
      "continuation/quota-exhaustion-preserves-live-state",
      "continuation/never-issued-token-unavailable",
      "content-version/canonical-markdown-and-attachment-distinction",
      "discovery/inventory-after",
    ]);
  });

  it("hashes to a stable deterministic scenario-manifest digest", () => {
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          corpusId: READ_SIDE_CORPUS_ID,
          scenarios: [...READ_SIDE_SCENARIO_PLAN],
        }),
        "utf8",
      )
      .digest("hex");
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    const recomputed = createHash("sha256")
      .update(
        JSON.stringify({
          corpusId: READ_SIDE_CORPUS_ID,
          scenarios: [...READ_SIDE_SCENARIO_PLAN],
        }),
        "utf8",
      )
      .digest("hex");
    expect(recomputed).toBe(digest);
  });
});

describe("public-wire corpus boundary evidence", () => {
  it("rejects unsafe connection initialization before opening an MCP session", async () => {
    const requests: import("node:http").IncomingHttpHeaders[] = [];
    const server = createServer((request, response) => {
      requests.push(request.headers);
      response.writeHead(403);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Server unavailable");
      const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
      await expect(
        runPublicWireCorpus({ endpoint, expectedVaultId: "vault-a", fixtureSeed: "seed" }),
      ).rejects.toThrow("Streamable HTTP error");
      expect(requests.length).toBeGreaterThanOrEqual(4);
      expect(requests[0]?.["x-expected-vault-id"]).toBeUndefined();
      expect(requests[1]?.["x-expected-vault-id"]).toBe("vault-a-wrong");
      expect(requests[2]?.host).toBe("outside.example:80");
      expect(requests[3]?.origin).toBe("http://outside.example");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a non-loopback or non-HTTP endpoint without making a request", async () => {
    await expect(
      runPublicWireCorpus({
        endpoint: new URL("https://127.0.0.1:443/mcp"),
        expectedVaultId: "vault-a",
        fixtureSeed: "seed",
      }),
    ).rejects.toThrow("127.0.0.1 HTTP endpoint");
  });

  it("records hash-only seed and event details", () => {
    expect(SHA256("seed")).toMatch(/^[a-f0-9]{64}$/u);
  });
});
