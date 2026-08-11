import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PLUGIN_VERSION, SUPPORTED_OBSIDIAN_VERSION } from "../src/version.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(packageRoot, name), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("plugin release metadata", () => {
  it("uses one plugin version and the supported Obsidian runtime floor", () => {
    const manifest = readJson("manifest.json");
    const packageJson = readJson("package.json");

    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(packageJson.version).toBe(PLUGIN_VERSION);
    expect(manifest.minAppVersion).toBe(SUPPORTED_OBSIDIAN_VERSION);
  });
});
