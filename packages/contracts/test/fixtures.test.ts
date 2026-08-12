import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseHealthResult } from "../src/index.js";

const fixturesRoot = fileURLToPath(new URL("../fixtures/v1/", import.meta.url));

async function fixtures(kind: "valid" | "invalid"): Promise<unknown[]> {
  const directory = `${fixturesRoot}/${kind}`;
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  return names.map((name) => JSON.parse(readFileSync(`${directory}/${name}`, "utf8")));
}

describe("versioned vault_health fixture corpus", () => {
  it("accepts every valid fixture", async () => {
    const validFixtures = await fixtures("valid");
    expect(validFixtures.length).toBeGreaterThan(0);
    for (const fixture of validFixtures) {
      expect(() => parseHealthResult(fixture)).not.toThrow();
    }
  });

  it("rejects every invalid fixture", async () => {
    const invalidFixtures = await fixtures("invalid");
    expect(invalidFixtures.length).toBeGreaterThan(0);
    for (const fixture of invalidFixtures) {
      expect(() => parseHealthResult(fixture)).toThrow();
    }
  });

  it("publishes the identity and compatibility scenarios owned beyond JSON Schema", () => {
    const manifest = JSON.parse(
      readFileSync(`${fixturesRoot}/scenarios.json`, "utf8"),
    ) as { scenarios: Array<{ id: string }> };

    expect(manifest.scenarios.map(({ id }) => id)).toEqual([
      "matching-identity-observed-health",
      "missing-identity-rejected",
      "mismatched-identity-rejected",
      "schema-compatible-incompatible-health",
      "two-vault-coexistence",
      "structured-compatibility-identity",
      "byte-exact-ordered-mixed-read",
      "section-occurrence-no-fallback",
      "exact-read-limit-and-grouping",
      "content-read-operational-block",
      "invalid-utf8-no-trusted-result",
      "frozen-byte-exact-continuation",
      "single-use-client-bound-sliding-continuation",
      "continuation-quota-and-lifecycle-cleanup",
      "continuation-operational-gate-precedence",
    ]);
  });
});
