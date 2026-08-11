import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createHealthInputJsonSchema,
  createHealthResultJsonSchema,
} from "../dist/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(packageRoot, "schema/v1");

await Promise.all([
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
]);
