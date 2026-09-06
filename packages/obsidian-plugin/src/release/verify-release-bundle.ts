import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { SUPPORTED_OBSIDIAN_VERSION } from "../version.js";
import {
  CANDIDATE_CHECKSUM_MANIFEST,
  brandVerifiedCandidateBundle,
  inspectCandidateBundle,
  sha256Hex,
  type VerifiedCandidateBundle,
} from "../installed-runtime/candidate-bundle.js";
import {
  parseAttestationClaims,
  type ReleaseAttestationClaims,
} from "./attestation-claims.js";
import {
  RELEASE_ATTESTATION_SUFFIX,
  RELEASE_PLUGIN_ID,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW_PATH,
  ReleaseBundleError,
  compareSemanticVersions,
  expectedWorkflowRef,
  parseReleaseTag,
} from "./release-identity.js";

/**
 * Release-bundle verifier (issue #196): the only way to obtain an installable
 * bundle. Verification fails closed on bundle-integrity failures (closed file
 * set, mandatory checksum manifest, byte-exact digests), tag/version or
 * plugin-id mismatch against the pinned tag, Obsidian `minAppVersion`
 * incompatibility, and any attestation defect — absent, malformed, wrong
 * repository, wrong workflow ref (including any mutable selector such as
 * `latest`), or a subject set that misses, adds, or mis-hashes a managed
 * file. Success yields a branded `VerifiedReleaseBundle`; the brand is
 * unforgeable outside this module, so downstream deployment cannot be fed a
 * raw directory, an arbitrary URL, or a caller assertion.
 */

export type VerifiedReleaseBundle = VerifiedCandidateBundle;

export interface VerifyReleaseBundleOptions {
  readonly bundleDirectory: string;
  /** Immutable tag the bundle must match, e.g. `v0.1.0`. Never `latest`. */
  readonly expectedTag: string;
  /** Parsed claims; when omitted, claims are read from `attestationPath`. */
  readonly attestation?: unknown;
  /** Defaults to `<bundleDirectory>.attestation.json`. */
  readonly attestationPath?: string;
  readonly expectedRepository?: string;
  readonly expectedWorkflowPath?: string;
  readonly expectedPluginId?: string;
  /** Obsidian runtime floor the bundle must be installable into. */
  readonly supportedObsidianVersion?: string;
}

async function loadAttestationClaims(
  options: VerifyReleaseBundleOptions,
): Promise<ReleaseAttestationClaims> {
  let raw: unknown = options.attestation;
  if (raw === undefined) {
    const attestationPath =
      options.attestationPath ?? `${options.bundleDirectory}${RELEASE_ATTESTATION_SUFFIX}`;
    let serialized: string;
    try {
      serialized = await readFile(attestationPath, "utf8");
    } catch {
      throw new ReleaseBundleError(
        "Release attestation is absent; unprovenanced bundles are never installed",
        "release_attestation_absent",
      );
    }
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new ReleaseBundleError(
        "Release attestation is not valid JSON",
        "release_attestation_malformed",
      );
    }
  }
  return parseAttestationClaims(raw);
}

export async function verifyReleaseBundle(
  options: VerifyReleaseBundleOptions,
): Promise<VerifiedReleaseBundle> {
  const tag = parseReleaseTag(options.expectedTag);
  const expectedRepository = options.expectedRepository ?? RELEASE_REPOSITORY;
  const expectedWorkflowPath = options.expectedWorkflowPath ?? RELEASE_WORKFLOW_PATH;
  const expectedPluginId = options.expectedPluginId ?? RELEASE_PLUGIN_ID;
  const supportedObsidianVersion =
    options.supportedObsidianVersion ?? SUPPORTED_OBSIDIAN_VERSION;

  // 1. Bundle integrity: closed file set, mandatory checksum manifest, exact
  //    digests (CandidateBundleError propagates — already fail closed).
  const identity = await inspectCandidateBundle(options.bundleDirectory, {
    requireChecksumManifest: true,
  });

  // 2. Manifest identity and version must match the pinned tag and plugin.
  if (identity.pluginId !== expectedPluginId) {
    throw new ReleaseBundleError(
      `Bundle plugin id ${identity.pluginId} is not the expected ${expectedPluginId}`,
      "release_plugin_id_mismatch",
    );
  }
  if (identity.pluginVersion !== tag.version) {
    throw new ReleaseBundleError(
      `Bundle version ${identity.pluginVersion} does not match the pinned tag ${tag.tag}`,
      "release_tag_mismatch",
    );
  }

  // 3. The bundle must be installable into the supported Obsidian runtime.
  if (compareSemanticVersions(identity.minAppVersion, supportedObsidianVersion) > 0) {
    throw new ReleaseBundleError(
      `Bundle requires Obsidian ${identity.minAppVersion}, above the supported runtime ${supportedObsidianVersion}`,
      "release_incompatible_runtime",
    );
  }

  // 4. Attestation: repository, protected workflow ref bound to the tag, and
  //    a subject set exactly covering the bundle's files.
  const claims = await loadAttestationClaims(options);
  if (claims.repository !== expectedRepository) {
    throw new ReleaseBundleError(
      `Attestation repository ${claims.repository} is not the expected ${expectedRepository}`,
      "release_repository_mismatch",
    );
  }
  const requiredWorkflowRef = expectedWorkflowRef(tag, expectedRepository, expectedWorkflowPath);
  if (claims.workflowRef !== requiredWorkflowRef) {
    throw new ReleaseBundleError(
      `Attestation workflow ref ${claims.workflowRef} is not the required ${requiredWorkflowRef}`,
      "release_workflow_mismatch",
    );
  }

  const checksumBytes = new Uint8Array(
    await readFile(join(options.bundleDirectory, CANDIDATE_CHECKSUM_MANIFEST)),
  );
  const expectedSubjects = new Map<string, string>([
    ...identity.files.map((file) => [file.path, file.sha256] as const),
    [CANDIDATE_CHECKSUM_MANIFEST, sha256Hex(checksumBytes)],
  ]);
  const claimedSubjects = new Map(claims.subjects.map((subject) => [subject.name, subject.sha256]));
  for (const [name, digest] of expectedSubjects) {
    const claimed = claimedSubjects.get(name);
    if (claimed === undefined) {
      throw new ReleaseBundleError(
        `Attestation has no subject for managed file ${name}`,
        "release_attestation_subject_missing",
      );
    }
    if (claimed !== digest) {
      throw new ReleaseBundleError(
        `Attestation subject digest mismatch for ${name}`,
        "release_attestation_digest_mismatch",
      );
    }
  }
  for (const name of claimedSubjects.keys()) {
    if (!expectedSubjects.has(name)) {
      throw new ReleaseBundleError(
        `Attestation carries an unexpected subject: ${name}`,
        "release_attestation_subject_unexpected",
      );
    }
  }

  return brandVerifiedCandidateBundle({
    bundleDirectory: options.bundleDirectory,
    identity,
    tag: tag.tag,
    repository: claims.repository,
    workflowRef: claims.workflowRef,
    attestationSource: claims.source,
  });
}
