import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [path, expected] = process.argv.slice(2);
if (path === undefined || expected === undefined) throw new Error("usage: verify-integrity FILE ALGORITHM-DIGEST");
const separator = expected.indexOf("-");
if (separator < 1) throw new Error("invalid integrity value");
const algorithm = expected.slice(0, separator);
const digest = expected.slice(separator + 1);
const actual = createHash(algorithm).update(await readFile(path)).digest("base64");
if (actual !== digest) throw new Error(`integrity mismatch for ${path}`);
