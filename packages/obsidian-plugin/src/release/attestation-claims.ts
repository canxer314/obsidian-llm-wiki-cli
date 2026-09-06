import {
  ReleaseBundleError,
} from "./release-identity.js";

/**
 * Attestation-claims model (issue #196): the verifier never trusts a caller's
 * word about where a bundle came from — it requires an attestation claims
 * document naming the source, repository, protected workflow ref, and the
 * exact SHA-256 subject set. GitHub builds produce these claims from real
 * artifact attestations (verified via `gh attestation verify` and converted
 * with `claimsFromGhAttestationVerifyOutput`); the local packaging step emits
 * the same closed shape marked `local-candidate` so the installed-runtime
 * harness exercises the identical verification path.
 */

export const ATTESTATION_SOURCES = [
  "github-artifact-attestation",
  "local-candidate",
] as const;

export type AttestationSource = (typeof ATTESTATION_SOURCES)[number];

export interface ReleaseAttestationSubject {
  /** Bundle-relative file name (closed set: managed files + checksums.sha256). */
  readonly name: string;
  readonly sha256: string;
}

export interface ReleaseAttestationClaims {
  readonly source: AttestationSource;
  /** `owner/repo` the attestation is bound to. */
  readonly repository: string;
  /** `owner/repo/<workflow path>@refs/tags/vX.Y.Z` the attestation is bound to. */
  readonly workflowRef: string;
  readonly subjects: readonly ReleaseAttestationSubject[];
}

const SHA256 = /^[a-f0-9]{64}$/u;
/** Subject names are closed: only release-managed files plus the checksum manifest. */
const SUBJECT_NAMES = new Set([
  "manifest.json",
  "main.js",
  "styles.css",
  "checksums.sha256",
]);

function malformed(message: string): ReleaseBundleError {
  return new ReleaseBundleError(`Malformed release attestation: ${message}`, "release_attestation_malformed");
}

/**
 * Validates and normalizes a parsed attestation claims document. Any
 * structural deviation — unknown source, missing fields, subjects outside the
 * closed name set, duplicate subjects — rejects the document.
 */
export function parseAttestationClaims(raw: unknown): ReleaseAttestationClaims {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw malformed("claims are not an object");
  }
  const record = raw as Record<string, unknown>;
  const source = record["source"];
  if (
    typeof source !== "string" ||
    !(ATTESTATION_SOURCES as readonly string[]).includes(source)
  ) {
    throw malformed("source must be github-artifact-attestation or local-candidate");
  }
  const repository = record["repository"];
  const workflowRef = record["workflowRef"];
  if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    throw malformed("repository must be an owner/repo string");
  }
  if (typeof workflowRef !== "string" || workflowRef.length === 0) {
    throw malformed("workflowRef must be a non-empty string");
  }
  const subjects = record["subjects"];
  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw malformed("subjects must be a non-empty array");
  }
  const seen = new Set<string>();
  const parsedSubjects: ReleaseAttestationSubject[] = [];
  for (const subject of subjects) {
    if (typeof subject !== "object" || subject === null || Array.isArray(subject)) {
      throw malformed("subject is not an object");
    }
    const { name, sha256 } = subject as Record<string, unknown>;
    if (typeof name !== "string" || !SUBJECT_NAMES.has(name)) {
      throw malformed(`subject name outside the closed bundle set: ${String(name)}`);
    }
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
      throw malformed(`subject ${name} carries an invalid SHA-256`);
    }
    if (seen.has(name)) {
      throw malformed(`duplicate subject: ${name}`);
    }
    seen.add(name);
    parsedSubjects.push({ name, sha256 });
  }
  return {
    source: source as AttestationSource,
    repository,
    workflowRef,
    subjects: parsedSubjects.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/** Canonical serialization: fixed key order, sorted subjects, trailing LF. */
export function serializeAttestationClaims(claims: ReleaseAttestationClaims): string {
  const subjects = [...claims.subjects].sort((left, right) => left.name.localeCompare(right.name));
  return `${JSON.stringify(
    {
      source: claims.source,
      repository: claims.repository,
      workflowRef: claims.workflowRef,
      subjects: subjects.map((subject) => ({ name: subject.name, sha256: subject.sha256 })),
    },
    null,
    2,
  )}\n`;
}

const GITHUB_URI_PREFIX = "https://github.com/";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stripGithubUri(uri: unknown, field: string): string {
  if (typeof uri !== "string" || !uri.startsWith(GITHUB_URI_PREFIX)) {
    throw malformed(`${field} must be a https://github.com/ URI`);
  }
  return uri.slice(GITHUB_URI_PREFIX.length);
}

/**
 * Converts the JSON output of `gh attestation verify --format json` into
 * canonical claims. Repository and signer workflow are read from the verified
 * certificate extensions (never from caller-supplied environment); subjects
 * come from the verified statement. Any structural surprise rejects the
 * document — a partially understood attestation is never trusted.
 */
export function claimsFromGhAttestationVerifyOutput(raw: unknown): ReleaseAttestationClaims {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw malformed("gh attestation verify output must be a non-empty array");
  }
  let repository: string | null = null;
  let workflowRef: string | null = null;
  const subjects = new Map<string, string>();
  for (const entry of raw) {
    const record = asRecord(entry);
    const verification = asRecord(record?.["verificationResult"]);
    if (record === null || verification === null) {
      throw malformed("entry lacks a verificationResult object");
    }
    const certificate =
      asRecord(verification["verifiedCertificate"]) ??
      asRecord(verification["signerCertificate"]) ??
      asRecord(record["signerCertificate"]);
    const extensions = asRecord(certificate?.["extensions"]);
    if (extensions === null) {
      throw malformed("verified certificate lacks extensions");
    }
    const entryRepository = stripGithubUri(
      extensions["sourceRepositoryURI"],
      "sourceRepositoryURI",
    );
    const entryWorkflowRef = stripGithubUri(extensions["buildSignerURI"], "buildSignerURI");
    if (repository !== null && repository !== entryRepository) {
      throw malformed("entries disagree on the source repository");
    }
    if (workflowRef !== null && workflowRef !== entryWorkflowRef) {
      throw malformed("entries disagree on the signer workflow");
    }
    repository = entryRepository;
    workflowRef = entryWorkflowRef;

    const statement = asRecord(verification["statement"]) ?? asRecord(record["statement"]);
    const statementSubjects = statement?.["subject"];
    if (!Array.isArray(statementSubjects) || statementSubjects.length === 0) {
      throw malformed("verified statement carries no subjects");
    }
    for (const subject of statementSubjects) {
      const subjectRecord = asRecord(subject);
      const digest = asRecord(subjectRecord?.["digest"]);
      const name = subjectRecord?.["name"];
      const sha256 = digest?.["sha256"];
      if (typeof name !== "string" || typeof sha256 !== "string") {
        throw malformed("verified statement subject lacks name or sha256 digest");
      }
      if (subjects.has(name) && subjects.get(name) !== sha256) {
        throw malformed(`entries disagree on the digest of ${name}`);
      }
      subjects.set(name, sha256);
    }
  }
  return parseAttestationClaims({
    source: "github-artifact-attestation",
    repository,
    workflowRef,
    subjects: [...subjects.entries()].map(([name, sha256]) => ({ name, sha256 })),
  });
}
