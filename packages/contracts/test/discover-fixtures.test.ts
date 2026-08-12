import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseDiscoverInput, parseDiscoverResult } from "../src/index.js";

const fixturesRoot = fileURLToPath(
  new URL("../fixtures/v1/vault-discover/", import.meta.url),
);

type DiscoverFixture = { input?: unknown; result?: unknown };

async function fixtures(kind: "valid" | "invalid"): Promise<DiscoverFixture[]> {
  const directory = `${fixturesRoot}/${kind}`;
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  return names.map((name) => JSON.parse(readFileSync(`${directory}/${name}`, "utf8")));
}

function parseFixture(fixture: DiscoverFixture): void {
  if (fixture.input !== undefined) parseDiscoverInput(fixture.input);
  if (fixture.result !== undefined) parseDiscoverResult(fixture.result);
}

describe("versioned vault_discover fixture corpus", () => {
  it("accepts every valid fixture", async () => {
    const validFixtures = await fixtures("valid");
    expect(validFixtures.length).toBeGreaterThan(0);
    for (const fixture of validFixtures) {
      expect(() => parseFixture(fixture)).not.toThrow();
    }
  });

  it("rejects every invalid fixture", async () => {
    const invalidFixtures = await fixtures("invalid");
    expect(invalidFixtures.length).toBeGreaterThan(0);
    for (const fixture of invalidFixtures) {
      expect(() => parseFixture(fixture)).toThrow();
    }
  });
});
