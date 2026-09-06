import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CANDIDATE_CHECKSUM_MANIFEST,
  sha256Hex,
} from "../installed-runtime/candidate-bundle.js";
import {
  serializeAttestationClaims,
  type AttestationSource,
  type ReleaseAttestationClaims,
} from "./attestation-claims.js";
import {
  RELEASE_ATTESTATION_SUFFIX,
  RELEASE_PLUGIN_ID,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  ReleaseBundleError,
  expectedWorkflowRef,
  parseReleaseTag,
  type ParsedReleaseTag,
} from "./release-identity.js";

/**
 * Deterministic release packaging (issue #196): for one fixed immutable tag,
 * assembles exactly the release-managed plugin files — `manifest.json`,
 * `main.js`, optional `styles.css` — plus a canonical `checksums.sha256`
 * manifest, and emits the attestation claims document as a sibling file
 * (attestations live outside the closed bundle file set, as they do in the
 * GitHub attestation store). Assembly asserts the manifest and package
 * versions both match the pinned tag; a mismatch refuses to assemble.
 */

export interface AssembleReleaseBundleOptions {
  /** Immutable release tag, e.g. `v0.1.0`. Mutable selectors are rejected. */
  readonly tag: string;
  /** Plugin package root containing manifest.json and package.json. */
  readonly packageRoot: string;
  /** Destination directory; must be absent or empty so stale bytes never leak in. */
  readonly bundleDirectory: string;
  /** Claims destination; defaults to `<bundleDirectory>.attestation.json`. */
  readonly attestationPath?: string;
  /** Claims issuer; CI passes `github-artifact-attestation` only after real attestation. */
  readonly source?: AttestationSource;
  readonly repository?: string;
  readonly workflowPath?: string;
}

export interface AssembledReleaseFile {
  readonly path: "manifest.json" | "main.js" | "styles.css";
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface AssembledReleaseBundle {
  readonly tag: ParsedReleaseTag["tag"];
  readonly version: string;
  readonly bundleDirectory: string;
  readonly attestationPath: string;
  readonly files: readonly AssembledReleaseFile[];
  readonly checksumManifestSha256: string;
  readonly claims: ReleaseAttestationClaims;
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ReleaseBundleError(`${label} is unreadable or not valid JSON`, "release_build_output_missing");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ReleaseBundleError(`${label} is not a JSON object`, "release_build_output_missing");
  }
  return parsed as Record<string, unknown>;
}

export async function assembleReleaseBundle(
  options: AssembleReleaseBundleOptions,
): Promise<AssembledReleaseBundle> {
  const tag = parseReleaseTag(options.tag);
  const repository = options.repository ?? RELEASE_REPOSITORY;
  const workflowPath = options.workflowPath ?? RELEASE_WORKFLOW_PATH;
  const attestationPath =
    options.attestationPath ?? `${options.bundleDirectory}${RELEASE_ATTESTATION_SUFFIX}`;

  const manifest = await readJsonObject(join(options.packageRoot, "manifest.json"), "manifest.json");
  const packageJson = await readJsonObject(join(options.packageRoot, "package.json"), "package.json");
  if (manifest["id"] !== RELEASE_PLUGIN_ID) {
    throw new ReleaseBundleError(
      `manifest.json id ${String(manifest["id"])} is not the release plugin id ${RELEASE_PLUGIN_ID}`,
      "release_plugin_id_mismatch",
    );
  }
  if (manifest["version"] !== tag.version) {
    throw new ReleaseBundleError(
      `manifest.json version ${String(manifest["version"])} does not match the pinned tag ${tag.tag}`,
      "release_tag_mismatch",
    );
  }
  if (packageJson["version"] !== tag.version) {
    throw new ReleaseBundleError(
      `package.json version ${String(packageJson["version"])} does not match the pinned tag ${tag.tag}`,
      "release_tag_mismatch",
    );
  }

  try {
    await mkdir(options.bundleDirectory, { recursive: true });
  } catch (error) {
    throw new ReleaseBundleError(
      `Cannot create bundle directory: ${error instanceof Error ? error.message : String(error)}`,
      "release_bundle_directory_not_empty",
    );
  }
  if ((await readdir(options.bundleDirectory)).length > 0) {
    throw new ReleaseBundleError(
      "Bundle directory is not empty; refusing to mix stale bytes into a release candidate",
      "release_bundle_directory_not_empty",
    );
  }

  const sources: [AssembledReleaseFile["path"], string][] = [
    ["manifest.json", join(options.packageRoot, "manifest.json")],
    ["main.js", join(options.packageRoot, "dist", "main.js")],
    ["styles.css", join(options.packageRoot, "styles.css")],
  ];
  const files: AssembledReleaseFile[] = [];
  for (const [path, source] of sources) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(source));
    } catch {
      if (path === "styles.css") continue; // optional release-managed file
      throw new ReleaseBundleError(
        `Required build output is missing: ${path} (run the plugin build first)`,
        "release_build_output_missing",
      );
    }
    await copyFile(source, join(options.bundleDirectory, path));
    files.push({ path, sha256: sha256Hex(bytes), sizeBytes: bytes.length });
  }

  // Canonical checksum manifest: LF-terminated `sha256  path` lines, sorted.
  const checksumLines = files
    .map((file) => `${file.sha256}  ${file.path}`)
    .sort()
    .join("\n");
  const checksumBytes = new TextEncoder().encode(`${checksumLines}\n`);
  await writeFile(
    join(options.bundleDirectory, CANDIDATE_CHECKSUM_MANIFEST),
    checksumBytes,
  );
  const checksumManifestSha256 = createHash("sha256").update(checksumBytes).digest("hex");

  const claims: ReleaseAttestationClaims = {
    source: options.source ?? "local-candidate",
    repository,
    workflowRef: expectedWorkflowRef(tag, repository, workflowPath),
    subjects: [
      ...files.map((file) => ({ name: file.path, sha256: file.sha256 })),
      { name: CANDIDATE_CHECKSUM_MANIFEST, sha256: checksumManifestSha256 },
    ].sort((left, right) => left.name.localeCompare(right.name)),
  };
  await writeFile(attestationPath, serializeAttestationClaims(claims), "utf8");

  return {
    tag: tag.tag,
    version: tag.version,
    bundleDirectory: options.bundleDirectory,
    attestationPath,
    files,
    checksumManifestSha256,
    claims,
  };
}
