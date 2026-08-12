import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createChangeSetStatusInputJsonSchema,
  createChangeSetStatusResultJsonSchema,
  createChangeSetSubmitInputJsonSchema,
  createChangeSetSubmitResultJsonSchema,
  createHealthInputJsonSchema,
  createHealthResultJsonSchema,
  createReadInputJsonSchema,
  createReadResultJsonSchema,
} from "../src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(packageRoot, "schema/v1");

function readSchema(name: string): unknown {
  return JSON.parse(readFileSync(resolve(schemaRoot, name), "utf8"));
}

describe("committed JSON Schema artifacts", () => {
  it("stay identical to the authoritative generated contract", () => {
    expect(readSchema("vault-change-set-submit.input.schema.json")).toEqual(
      createChangeSetSubmitInputJsonSchema(),
    );
    expect(readSchema("vault-change-set-submit.output.schema.json")).toEqual(
      createChangeSetSubmitResultJsonSchema(),
    );
    expect(readSchema("vault-change-set-status.input.schema.json")).toEqual(
      createChangeSetStatusInputJsonSchema(),
    );
    expect(readSchema("vault-change-set-status.output.schema.json")).toEqual(
      createChangeSetStatusResultJsonSchema(),
    );
    expect(readSchema("vault-health.input.schema.json")).toEqual(
      createHealthInputJsonSchema(),
    );
    expect(readSchema("vault-health.output.schema.json")).toEqual(
      createHealthResultJsonSchema(),
    );
    expect(readSchema("vault-read.input.schema.json")).toEqual(
      createReadInputJsonSchema(),
    );
    expect(readSchema("vault-read.output.schema.json")).toEqual(
      createReadResultJsonSchema(),
    );
  });
});
