import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createChangeSetStatusInputJsonSchema,
  createChangeSetStatusResultJsonSchema,
  createChangeSetSubmitInputJsonSchema,
  createChangeSetSubmitResultJsonSchema,
  createHealthInputJsonSchema,
  createHealthResultJsonSchema,
  createReadInputJsonSchema,
  createReadResultJsonSchema,
} from "../dist/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(packageRoot, "schema/v1");

await Promise.all([
  writeFile(
    resolve(schemaRoot, "vault-change-set-submit.input.schema.json"),
    `${JSON.stringify(createChangeSetSubmitInputJsonSchema(), null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    resolve(schemaRoot, "vault-change-set-submit.output.schema.json"),
    `${JSON.stringify(createChangeSetSubmitResultJsonSchema(), null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    resolve(schemaRoot, "vault-change-set-status.input.schema.json"),
    `${JSON.stringify(createChangeSetStatusInputJsonSchema(), null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    resolve(schemaRoot, "vault-change-set-status.output.schema.json"),
    `${JSON.stringify(createChangeSetStatusResultJsonSchema(), null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    resolve(schemaRoot, "vault-health.input.schema.json"),
    `${JSON.stringify(createHealthInputJsonSchema(), null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    resolve(schemaRoot, "vault-health.output.schema.json"),
    `${JSON.stringify(createHealthResultJsonSchema(), null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    resolve(schemaRoot, "vault-read.input.schema.json"),
    `${JSON.stringify(createReadInputJsonSchema(), null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    resolve(schemaRoot, "vault-read.output.schema.json"),
    `${JSON.stringify(createReadResultJsonSchema(), null, 2)}\n`,
    "utf8",
  ),
]);
