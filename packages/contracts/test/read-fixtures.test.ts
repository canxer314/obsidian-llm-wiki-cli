import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseReadInput, parseReadResult } from "../src/index.js";

const fixturesRoot = fileURLToPath(new URL("../fixtures/v1/vault-read/", import.meta.url));

type ReadFixture = { input?: unknown; result?: unknown };

async function fixtures(kind: "valid" | "invalid"): Promise<ReadFixture[]> {
  const directory = `${fixturesRoot}/${kind}`;
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  return names.map((name) => JSON.parse(readFileSync(`${directory}/${name}`, "utf8")));
}

function parseFixture(fixture: ReadFixture): void {
  if (fixture.input !== undefined) parseReadInput(fixture.input);
  if (fixture.result !== undefined) parseReadResult(fixture.result);
}

describe("versioned vault_read fixture corpus", () => {
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

  it("binds Exact Read fixture evidence to its literal UTF-8 bytes", () => {
    const fixture = JSON.parse(
      readFileSync(`${fixturesRoot}/valid/ordered-mixed.json`, "utf8"),
    ) as {
      result: {
        items: Array<{
          result?: {
            kind: string;
            content?: string;
            sizeBytes?: number;
            contentVersion?: string;
          };
        }>;
      };
    };
    const exact = fixture.result.items.find((item) => item.result?.kind === "exact")?.result;
    expect(exact?.content).toBeDefined();
    const bytes = Buffer.from(exact!.content!, "utf8");

    expect(exact?.sizeBytes).toBe(bytes.byteLength);
    expect(exact?.contentVersion).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  });
});
