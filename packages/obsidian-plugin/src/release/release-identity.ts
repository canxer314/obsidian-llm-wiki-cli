import { PLUGIN_VERSION } from "../version.js";

/**
 * Release identity constants (issue #196): every candidate Release bundle is
 * pinned to this repository, this protected workflow, and an immutable
 * `vX.Y.Z` tag. A mutable `latest` selector is never expressible: tag parsing
 * rejects anything that is not an exact `v`-prefixed semantic version, and
 * the verifier requires the attestation workflow ref to name the tag ref
 * exactly.
 */

export const RELEASE_PLUGIN_ID = "llm-wiki-vault-bridge";
export const RELEASE_REPOSITORY = "canxer314/obsidian-llm-wiki-cli";
export const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
/** Sibling-file convention: attestation claims live outside the closed bundle file set. */
export const RELEASE_ATTESTATION_SUFFIX = ".attestation.json";

export type ReleaseBundleFailureCode =
  | "release_tag_malformed"
  | "release_tag_mismatch"
  | "release_plugin_id_mismatch"
  | "release_build_output_missing"
  | "release_bundle_directory_not_empty"
  | "release_incompatible_runtime"
  | "release_attestation_absent"
  | "release_attestation_malformed"
  | "release_repository_mismatch"
  | "release_workflow_mismatch"
  | "release_attestation_subject_missing"
  | "release_attestation_subject_unexpected"
  | "release_attestation_digest_mismatch";

export class ReleaseBundleError extends Error {
  constructor(
    message: string,
    readonly code: ReleaseBundleFailureCode,
  ) {
    super(message);
    this.name = "ReleaseBundleError";
  }
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const RELEASE_TAG = /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)$/u;

export interface ParsedReleaseTag {
  /** Canonical immutable tag, e.g. `v0.1.0`. */
  readonly tag: string;
  /** Version without the `v` prefix, e.g. `0.1.0`. */
  readonly version: string;
  /** Git ref the attestation must be bound to, e.g. `refs/tags/v0.1.0`. */
  readonly tagRef: string;
}

/**
 * Parses an immutable release tag. Anything mutable or non-semver — `latest`,
 * branch refs, partial versions — is rejected so no caller can widen the
 * selector.
 */
export function parseReleaseTag(tag: unknown): ParsedReleaseTag {
  const match = typeof tag === "string" ? RELEASE_TAG.exec(tag) : null;
  if (match === null || match[1] === undefined) {
    throw new ReleaseBundleError(
      `Release tag must be an immutable v-prefixed semantic version, got: ${String(tag)}`,
      "release_tag_malformed",
    );
  }
  return { tag: match[0], version: match[1], tagRef: `refs/tags/${match[0]}` };
}

/** The workflow ref an attestation must carry for this tag to be trusted. */
export function expectedWorkflowRef(
  parsed: ParsedReleaseTag,
  repository: string = RELEASE_REPOSITORY,
  workflowPath: string = RELEASE_WORKFLOW_PATH,
): string {
  return `${repository}/${workflowPath}@${parsed.tagRef}`;
}

/** Compares two semantic versions: negative when left < right, 0 when equal. */
export function compareSemanticVersions(left: string, right: string): number {
  const parse = (version: string): number[] => {
    const match = SEMVER.exec(version);
    if (match === null) {
      throw new ReleaseBundleError(
        `Not a semantic version: ${version}`,
        "release_tag_malformed",
      );
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The tag matching this source tree's pinned plugin version. */
export function currentSourceTreeTag(): ParsedReleaseTag {
  return parseReleaseTag(`v${PLUGIN_VERSION}`);
}
