import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalPublicWireCorpusManifest,
  createPublicWireCorpusManifest,
  registerHealthPublicWireFragment,
  runPublicWireCorpus,
} from "../src/index.js";

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

describe("public-wire corpus boundary evidence", () => {
  it("rejects unsafe connection initialization before opening an MCP session", async () => {
    const endpoint = new URL("http://127.0.0.1:1/mcp");
    const fetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 403 });
    };
    try {
      await expect(
        runPublicWireCorpus({ endpoint, expectedVaultId: "vault-a", fixtureSeed: "seed" }),
      ).rejects.toThrow("Streamable HTTP error");
      expect(requests.length).toBeGreaterThanOrEqual(4);
      expect(requests[0]?.headers.get("x-expected-vault-id")).toBeNull();
      expect(requests[1]?.headers.get("x-expected-vault-id")).toBe("vault-a-wrong");
      expect(requests[2]?.headers.get("host")).toBe("outside.example:80");
      expect(requests[3]?.headers.get("origin")).toBe("http://outside.example");
    } finally {
      globalThis.fetch = fetch;
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
