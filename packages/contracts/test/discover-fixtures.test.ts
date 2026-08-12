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

  it("preserves registered reference syntax in combined fixture evidence", () => {
    const fixture = JSON.parse(
      readFileSync(`${fixturesRoot}/valid/structured-graph-projection.json`, "utf8"),
    ) as {
      result: {
        items: Array<{
          references: Array<{
            profile: string;
            target: string;
            original: string;
          }>;
        }>;
      };
    };

    expect(fixture.result.items[0]?.references).toEqual([
      {
        profile: "wikilink",
        target: "Target Note",
        resolvedPath: "Target Note.md",
        original: "[[Target Note|target]]",
        startByte: 71,
        endByteExclusive: 93,
      },
      {
        profile: "markdown_embed",
        target: "Assets/my image.png",
        resolvedPath: "Assets/my image.png",
        original: "![alt](<Assets/my image.png>)",
        startByte: 94,
        endByteExclusive: 127,
      },
    ]);
  });
});
