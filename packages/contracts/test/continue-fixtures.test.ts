import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseContinueInput, parseContinueResult } from "../src/index.js";

const fixturesRoot = fileURLToPath(
  new URL("../fixtures/v1/vault-continue/", import.meta.url),
);

type ContinueFixture = { input?: unknown; result?: unknown };

async function fixtures(kind: "valid" | "invalid"): Promise<ContinueFixture[]> {
  const directory = `${fixturesRoot}/${kind}`;
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  return names.map((name) => JSON.parse(readFileSync(`${directory}/${name}`, "utf8")));
}

function parseFixture(fixture: ContinueFixture): void {
  if (fixture.input !== undefined) parseContinueInput(fixture.input);
  if (fixture.result !== undefined) parseContinueResult(fixture.result);
}

describe("versioned vault_continue fixture corpus", () => {
  it("accepts every valid fixture", async () => {
    const valid = await fixtures("valid");
    expect(valid.length).toBeGreaterThan(0);
    for (const fixture of valid) {
      expect(() => parseFixture(fixture)).not.toThrow();
    }
  });

  it("rejects every invalid fixture", async () => {
    const invalid = await fixtures("invalid");
    expect(invalid.length).toBeGreaterThan(0);
    for (const fixture of invalid) {
      expect(() => parseFixture(fixture)).toThrow();
    }
  });
});
