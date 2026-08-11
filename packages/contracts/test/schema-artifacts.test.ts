import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createHealthInputJsonSchema,
  createHealthResultJsonSchema,
} from "../src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(packageRoot, "schema/v1");

function readSchema(name: string): unknown {
  return JSON.parse(readFileSync(resolve(schemaRoot, name), "utf8"));
}

describe("committed JSON Schema artifacts", () => {
  it("stay identical to the authoritative generated contract", () => {
    expect(readSchema("vault-health.input.schema.json")).toEqual(
      createHealthInputJsonSchema(),
    );
    expect(readSchema("vault-health.output.schema.json")).toEqual(
      createHealthResultJsonSchema(),
    );
  });
});
