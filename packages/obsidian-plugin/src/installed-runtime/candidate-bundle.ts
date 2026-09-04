import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Candidate-bundle seam (issue #197): the harness installs exactly one
 * candidate Vault Operation Bridge bundle — `manifest.json`, `main.js`,
 * optional `styles.css`, and an optional `checksums.sha256` — into the
 * dedicated generated test Vault, and records input hashes as evidence.
 * Integrity failures are evidence-invalidating, never bypassable.
 */

export const CANDIDATE_REQUIRED_FILES = ["manifest.json", "main.js"] as const;
export const CANDIDATE_OPTIONAL_FILES = ["styles.css"] as const;
export const CANDIDATE_CHECKSUM_MANIFEST = "checksums.sha256";

export type CandidateManagedFile =
  | (typeof CANDIDATE_REQUIRED_FILES)[number]
  | (typeof CANDIDATE_OPTIONAL_FILES)[number];

const CANDIDATE_MANAGED_FILES: readonly string[] = [
  ...CANDIDATE_REQUIRED_FILES,
  ...CANDIDATE_OPTIONAL_FILES,
];

const SHA256 = /^[a-f0-9]{64}$/u;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

export class CandidateBundleError extends Error {
  constructor(
    message: string,
    readonly code:
      | "candidate_file_missing"
      | "candidate_file_unexpected"
      | "candidate_checksum_mismatch"
      | "candidate_manifest_invalid",
  ) {
    super(message);
    this.name = "CandidateBundleError";
  }
}

export interface CandidateFileDigest {
  readonly path: CandidateManagedFile;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface CandidateBundleIdentity {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly minAppVersion: string;
  readonly files: readonly CandidateFileDigest[];
  /** Canonical digest over the sorted `sha256  path` lines of managed files. */
  readonly bundleSha256: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCandidateManagedFile(path: string): path is CandidateManagedFile {
  return CANDIDATE_MANAGED_FILES.includes(path);
}

function parseManifest(bytes: Uint8Array): {
  id: string;
  version: string;
  minAppVersion: string;
} {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CandidateBundleError(
      "Candidate manifest.json is not valid UTF-8 JSON",
      "candidate_manifest_invalid",
    );
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new CandidateBundleError(
      "Candidate manifest.json is not an object",
      "candidate_manifest_invalid",
    );
  }
  const { id, version, minAppVersion } = manifest as Record<string, unknown>;
  if (
    typeof id !== "string" ||
    !PLUGIN_ID.test(id) ||
    typeof version !== "string" ||
    !SEMVER.test(version) ||
    typeof minAppVersion !== "string" ||
    !SEMVER.test(minAppVersion)
  ) {
    throw new CandidateBundleError(
      "Candidate manifest.json has an invalid id, version, or minAppVersion",
      "candidate_manifest_invalid",
    );
  }
  return { id, version, minAppVersion };
}

function parseChecksumManifest(bytes: Uint8Array): ReadonlyMap<string, string> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CandidateBundleError(
      "Candidate checksums.sha256 is not valid UTF-8",
      "candidate_manifest_invalid",
    );
  }
  if (!text.endsWith("\n") || text.includes("\r")) {
    throw new CandidateBundleError(
      "Candidate checksums.sha256 must use canonical LF-terminated lines",
      "candidate_manifest_invalid",
    );
  }
  const checksums = new Map<string, string>();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new CandidateBundleError(
        "Candidate checksums.sha256 contains malformed data",
        "candidate_manifest_invalid",
      );
    }
    if (!isCandidateManagedFile(match[2]) || checksums.has(match[2])) {
      throw new CandidateBundleError(
        "Candidate checksums.sha256 references unmanaged or duplicate files",
        "candidate_manifest_invalid",
      );
    }
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

/**
 * Reads and verifies one candidate bundle directory. Every managed file is
 * hashed; when a `checksums.sha256` is present each listed digest must match
 * exactly, and unknown bundle members reject the candidate.
 */
export async function inspectCandidateBundle(
  directory: string,
): Promise<CandidateBundleIdentity> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    throw new CandidateBundleError(
      "Candidate bundle directory is unreadable",
      "candidate_file_missing",
    );
  }
  const managedPresent = entries.filter((entry) => isCandidateManagedFile(entry));
  const unexpected = entries.filter(
    (entry) => !isCandidateManagedFile(entry) && entry !== CANDIDATE_CHECKSUM_MANIFEST,
  );
  if (unexpected.length > 0) {
    throw new CandidateBundleError(
      `Candidate bundle contains unmanaged files: ${unexpected.sort().join(", ")}`,
      "candidate_file_unexpected",
    );
  }
  for (const required of CANDIDATE_REQUIRED_FILES) {
    if (!managedPresent.includes(required)) {
      throw new CandidateBundleError(
        `Candidate bundle is missing ${required}`,
        "candidate_file_missing",
      );
    }
  }

  const files: CandidateFileDigest[] = [];
  const contents = new Map<string, Uint8Array>();
  for (const path of [...managedPresent].sort()) {
    const bytes = new Uint8Array(await readFile(join(directory, path)));
    contents.set(path, bytes);
    files.push({ path: path as CandidateManagedFile, sha256: sha256(bytes), sizeBytes: bytes.length });
  }

  if (entries.includes(CANDIDATE_CHECKSUM_MANIFEST)) {
    const declared = parseChecksumManifest(
      new Uint8Array(await readFile(join(directory, CANDIDATE_CHECKSUM_MANIFEST))),
    );
    for (const file of files) {
      const expected = declared.get(file.path);
      if (expected !== file.sha256) {
        throw new CandidateBundleError(
          `Candidate checksum mismatch for ${file.path}`,
          "candidate_checksum_mismatch",
        );
      }
    }
  }

  const manifest = parseManifest(contents.get("manifest.json")!);
  const canonical = files
    .map((file) => `${file.sha256}  ${file.path}`)
    .join("\n");
  return {
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    minAppVersion: manifest.minAppVersion,
    files,
    bundleSha256: sha256(new TextEncoder().encode(`${canonical}\n`)),
  };
}

export interface InstalledCandidate {
  readonly pluginDirectory: string;
  readonly identity: CandidateBundleIdentity;
}

/**
 * Installs the verified candidate into the dedicated test Vault as the only
 * enabled community plugin and verifies the written bytes hash-equal the
 * inspected candidate. The plugin directory must not already exist: install
 * never overwrites release-managed files it did not just write.
 */
export async function installCandidateBundle(
  bundleDirectory: string,
  identity: CandidateBundleIdentity,
  vaultPath: string,
  configDirectoryName = ".obsidian",
): Promise<InstalledCandidate> {
  const configDirectory = join(vaultPath, configDirectoryName);
  const pluginsRoot = join(configDirectory, "plugins");
  const pluginDirectory = join(pluginsRoot, identity.pluginId);
  await mkdir(pluginsRoot, { recursive: true });
  try {
    await mkdir(pluginDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CandidateBundleError(
        "Candidate plugin directory already exists in the test Vault",
        "candidate_file_unexpected",
      );
    }
    throw error;
  }

  for (const file of identity.files) {
    const bytes = new Uint8Array(await readFile(join(bundleDirectory, file.path)));
    if (sha256(bytes) !== file.sha256) {
      throw new CandidateBundleError(
        `Candidate file changed between inspection and install: ${file.path}`,
        "candidate_checksum_mismatch",
      );
    }
    const destination = join(pluginDirectory, file.path);
    await writeFile(destination, bytes, { flag: "wx" });
    const written = new Uint8Array(await readFile(destination));
    if (sha256(written) !== file.sha256) {
      throw new CandidateBundleError(
        `Installed candidate file failed verification: ${file.path}`,
        "candidate_checksum_mismatch",
      );
    }
  }

  // The dedicated profile requirement (spec §12.1) is enforced by writing the
  // enabled-plugin inventory ourselves: the candidate is the only entry.
  await writeFile(
    join(configDirectory, "community-plugins.json"),
    `${JSON.stringify([identity.pluginId])}\n`,
    "utf8",
  );
  return { pluginDirectory, identity };
}

export { sha256 as sha256Hex };
