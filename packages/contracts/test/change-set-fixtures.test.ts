import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseChangeSetStatusInput,
  parseChangeSetStatusResult,
  parseChangeSetSubmitInput,
  parseChangeSetSubmitResult,
} from "../src/index.js";

const fixturesRoot = fileURLToPath(
  new URL("../fixtures/v1/vault-change-set/", import.meta.url),
);

type ChangeSetFixture = {
  submitInput?: unknown;
  submitResult?: unknown;
  statusInput?: unknown;
  statusResult?: unknown;
};

async function fixtures(kind: "valid" | "invalid"): Promise<ChangeSetFixture[]> {
  const directory = `${fixturesRoot}/${kind}`;
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  return names.map((name) =>
    JSON.parse(readFileSync(`${directory}/${name}`, "utf8")),
  );
}

function parseFixture(fixture: ChangeSetFixture): void {
  if (fixture.submitInput !== undefined) parseChangeSetSubmitInput(fixture.submitInput);
  if (fixture.submitResult !== undefined) parseChangeSetSubmitResult(fixture.submitResult);
  if (fixture.statusInput !== undefined) parseChangeSetStatusInput(fixture.statusInput);
  if (fixture.statusResult !== undefined) parseChangeSetStatusResult(fixture.statusResult);
}

describe("versioned Change Set fixture corpus", () => {
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
