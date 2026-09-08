/**
 * Release-bundle verification CLI (issue #196):
 *
 *   node dist/release-verify.mjs --tag vX.Y.Z --bundle <dir> \
 *     [--attestation <claims.json> | --gh-verified <gh-attestation-verify.json>] \
 *     [--repository owner/repo] [--workflow-path .github/workflows/release.yml] \
 *     [--plugin-id id] [--obsidian X.Y.Z]
 *
 * Prints the verified bundle identity and exits zero only when every check
 * passes; any fail-closed rejection exits non-zero with the failure code.
 * With `--gh-verified`, raw `gh attestation verify --format json` output is
 * converted into canonical claims (repository and workflow are read from the
 * verified certificate, never from the environment).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  claimsFromGhAttestationVerifyOutput,
} from "./attestation-claims.js";
import { ReleaseBundleError } from "./release-identity.js";
import { verifyReleaseBundle } from "./verify-release-bundle.js";

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      tag: { type: "string" },
      bundle: { type: "string" },
      attestation: { type: "string" },
      "gh-verified": { type: "string" },
      repository: { type: "string" },
      "workflow-path": { type: "string" },
      "plugin-id": { type: "string" },
      obsidian: { type: "string" },
    },
    strict: true,
  });
  if (
    values.tag === undefined ||
    values.bundle === undefined ||
    (values.attestation !== undefined && values["gh-verified"] !== undefined)
  ) {
    process.stderr.write(
      "Usage: release-verify --tag vX.Y.Z --bundle <dir> [--attestation <claims.json> | --gh-verified <file>] [--repository owner/repo] [--workflow-path <path>] [--plugin-id <id>] [--obsidian X.Y.Z]\n",
    );
    return 2;
  }
  let attestation: unknown;
  if (values["gh-verified"] !== undefined) {
    attestation = claimsFromGhAttestationVerifyOutput(
      JSON.parse(await readFile(resolve(values["gh-verified"]), "utf8")),
    );
  }
  const verified = await verifyReleaseBundle({
    bundleDirectory: resolve(values.bundle),
    expectedTag: values.tag,
    ...(attestation !== undefined ? { attestation } : {}),
    ...(values.attestation !== undefined
      ? { attestationPath: resolve(values.attestation) }
      : {}),
    ...(values.repository !== undefined ? { expectedRepository: values.repository } : {}),
    ...(values["workflow-path"] !== undefined
      ? { expectedWorkflowPath: values["workflow-path"] }
      : {}),
    ...(values["plugin-id"] !== undefined ? { expectedPluginId: values["plugin-id"] } : {}),
    ...(values.obsidian !== undefined ? { supportedObsidianVersion: values.obsidian } : {}),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        tag: verified.tag,
        pluginId: verified.identity.pluginId,
        pluginVersion: verified.identity.pluginVersion,
        minAppVersion: verified.identity.minAppVersion,
        bundleSha256: verified.identity.bundleSha256,
        repository: verified.repository,
        workflowRef: verified.workflowRef,
        attestationSource: verified.attestationSource,
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
      `release verification failed${code}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
