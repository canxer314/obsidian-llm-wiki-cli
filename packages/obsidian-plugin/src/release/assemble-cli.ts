/**
 * Release-bundle assembly CLI (issue #196):
 *
 *   node dist/release-assemble.mjs --tag vX.Y.Z [--package-root <dir>] \
 *     [--bundle <dir>] [--attestation <path>]
 *
 * Assembles exactly the release-managed files plus checksums for one fixed
 * immutable tag and writes the attestation claims document next to the
 * bundle. Exits non-zero without emitting a bundle when versions disagree.
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { assembleReleaseBundle } from "./assemble-release-bundle.js";
import { ReleaseBundleError } from "./release-identity.js";

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      tag: { type: "string" },
      "package-root": { type: "string" },
      bundle: { type: "string" },
      attestation: { type: "string" },
    },
    strict: true,
  });
  if (values.tag === undefined) {
    process.stderr.write(
      "Usage: release-assemble --tag vX.Y.Z [--package-root <dir>] [--bundle <dir>] [--attestation <path>]\n",
    );
    return 2;
  }
  const packageRoot = resolve(
    values["package-root"] ?? fileURLToPath(new URL("..", import.meta.url)),
  );
  const bundle = resolve(values.bundle ?? join(packageRoot, "dist", "release-bundle"));
  const assembled = await assembleReleaseBundle({
    tag: values.tag,
    packageRoot,
    bundleDirectory: bundle,
    ...(values.attestation !== undefined ? { attestationPath: resolve(values.attestation) } : {}),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        tag: assembled.tag,
        bundleDirectory: assembled.bundleDirectory,
        attestationPath: assembled.attestationPath,
        files: assembled.files,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const code = error instanceof ReleaseBundleError ? ` (${error.code})` : "";
    process.stderr.write(
      `release assemble failed${code}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
