import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CANDIDATE_CHECKSUM_MANIFEST,
  CANDIDATE_OPTIONAL_FILES,
  CANDIDATE_REQUIRED_FILES,
  isReleaseManagedBundleFile,
  parseManagedChecksumManifest,
  sha256Hex,
  type CandidateBundleIdentity,
} from "../installed-runtime/candidate-bundle.js";

/**
 * Release-managed file allowlist (issue #198, spec §9.1): the single
 * authority over which files inside a Managed Vault's plugin directory
 * deployment may stage, verify, replace, repair, or remove. Exactly
 * `manifest.json`, `main.js`, optional `styles.css`, and the deployed
 * `checksums.sha256`. Everything else in the Vault — plugin operational
 * state such as `data.json` (Vault identity, persistent port, FIFO queue,
 * Submission Keys, Change Set records, settings), Recovery Journals, other
 * plugins' storage, and Vault content — is never cleared or replaced by
 * lifecycle operations.
 */

export const RELEASE_MANAGED_REQUIRED_FILES: readonly string[] = CANDIDATE_REQUIRED_FILES;
export const RELEASE_MANAGED_OPTIONAL_FILES: readonly string[] = CANDIDATE_OPTIONAL_FILES;
export const RELEASE_MANAGED_CHECKSUM_FILE = CANDIDATE_CHECKSUM_MANIFEST;

/** The closed set of file names lifecycle operations may ever write or delete. */
export const RELEASE_MANAGED_FILES: readonly string[] = [
  ...RELEASE_MANAGED_REQUIRED_FILES,
  ...RELEASE_MANAGED_OPTIONAL_FILES,
  RELEASE_MANAGED_CHECKSUM_FILE,
];

export function isReleaseManagedFile(name: string): boolean {
  return name === RELEASE_MANAGED_CHECKSUM_FILE || isReleaseManagedBundleFile(name);
}

/** Canonical plugin directory for one Managed Vault. */
export function managedVaultPluginDirectory(
  vaultPath: string,
  configDirectoryName: string,
  pluginId: string,
): string {
  return join(vaultPath, configDirectoryName, "plugins", pluginId);
}

export type ManagedFileCondition = "verified" | "damaged" | "missing" | "unexpected";

export interface ManagedFileReport {
  readonly path: string;
  readonly condition: ManagedFileCondition;
}

export interface InstalledManagedSet {
  /** Parsed from the installed manifest when readable, else null. */
  readonly pluginId: string | null;
  readonly pluginVersion: string | null;
  readonly files: readonly ManagedFileReport[];
  /** True only when every expected file verifies and no stale managed file remains. */
  readonly complete: boolean;
}

/** One file the installed plugin directory must carry, with its expected digest. */
export interface ExpectedManagedFile {
  readonly path: string;
  readonly sha256: string;
}

/**
 * The expected installed file set for a verified bundle: the bundle's managed
 * files plus the checksum manifest deployed alongside them.
 */
export function expectedInstalledFiles(
  identity: CandidateBundleIdentity,
  checksumManifestSha256: string,
): readonly ExpectedManagedFile[] {
  return [
    ...identity.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    { path: RELEASE_MANAGED_CHECKSUM_FILE, sha256: checksumManifestSha256 },
  ];
}

async function readFileOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    // EISDIR: a directory squatting on a managed file name is damage (the
    // installed-set comments say so) — treat it as an unreadable managed file
    // so lifecycle operations repair or project it as defective instead of
    // crashing on an untyped filesystem error.
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "EISDIR"
    ) {
      return null;
    }
    throw error;
  }
}

function parseInstalledManifest(
  bytes: Uint8Array | null,
): { pluginId: string | null; pluginVersion: string | null } {
  if (bytes === null) return { pluginId: null, pluginVersion: null };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { pluginId: null, pluginVersion: null };
    }
    const { id, version } = parsed as Record<string, unknown>;
    return {
      pluginId: typeof id === "string" ? id : null,
      pluginVersion: typeof version === "string" ? version : null,
    };
  } catch {
    return { pluginId: null, pluginVersion: null };
  }
}

/**
 * Inspects one installed plugin directory against the expected managed file
 * set. Returns null when the directory does not exist at all. A directory
 * entry named like a managed file is managed regardless of type — a directory
 * squatting on `main.js` is damage, never something to preserve.
 */
export async function inspectInstalledManagedSet(
  pluginDirectory: string,
  expectedFiles: readonly ExpectedManagedFile[],
): Promise<InstalledManagedSet | null> {
  let entries: string[];
  try {
    entries = await readdir(pluginDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file.sha256]));
  const reports: ManagedFileReport[] = [];
  let manifestBytes: Uint8Array | null = null;
  for (const file of expectedFiles) {
    const bytes = await readFileOrNull(join(pluginDirectory, file.path));
    if (file.path === "manifest.json") manifestBytes = bytes;
    if (bytes === null) {
      reports.push({ path: file.path, condition: "missing" });
    } else {
      reports.push({
        path: file.path,
        condition: sha256Hex(bytes) === file.sha256 ? "verified" : "damaged",
      });
    }
  }
  const stale = entries.filter(
    (entry) => isReleaseManagedFile(entry) && !expectedByPath.has(entry),
  );
  for (const entry of stale.sort()) {
    reports.push({ path: entry, condition: "unexpected" });
  }
  const { pluginId, pluginVersion } = parseInstalledManifest(manifestBytes);
  return {
    pluginId,
    pluginVersion,
    files: reports,
    complete: reports.every((report) => report.condition === "verified"),
  };
}

export type InstalledSetIntegrity = "absent" | "incomplete" | "damaged" | "complete";

export interface DeployedSetInspection {
  readonly integrity: InstalledSetIntegrity;
  readonly pluginId: string | null;
  readonly pluginVersion: string | null;
  /** Managed files that are missing, damaged, or not covered by the checksum manifest. */
  readonly defectiveFiles: readonly string[];
}

/**
 * Verifies an installed plugin directory against its own deployed
 * `checksums.sha256` — the lifecycle projection's integrity check when no
 * bundle is at hand. Fail closed: an absent or unparseable checksum manifest
 * makes the whole installed set unverifiable, which projects as damaged.
 */
export async function inspectDeployedManagedSet(
  pluginDirectory: string,
): Promise<DeployedSetInspection> {
  let entries: string[];
  try {
    entries = await readdir(pluginDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { integrity: "absent", pluginId: null, pluginVersion: null, defectiveFiles: [] };
    }
    throw error;
  }
  const defective = new Set<string>();
  const present = new Set(entries);
  for (const required of RELEASE_MANAGED_REQUIRED_FILES) {
    if (!present.has(required)) defective.add(required);
  }
  if (defective.size > 0) {
    return {
      integrity: "incomplete",
      pluginId: null,
      pluginVersion: null,
      defectiveFiles: [...defective].sort(),
    };
  }
  const checksumBytes = await readFileOrNull(join(pluginDirectory, RELEASE_MANAGED_CHECKSUM_FILE));
  let declared: ReadonlyMap<string, string> | null = null;
  if (checksumBytes !== null) {
    try {
      declared = parseManagedChecksumManifest(checksumBytes);
    } catch {
      declared = null;
    }
  }
  if (declared === null) {
    defective.add(RELEASE_MANAGED_CHECKSUM_FILE);
  } else {
    for (const [path, digest] of declared) {
      const bytes = await readFileOrNull(join(pluginDirectory, path));
      if (bytes === null || sha256Hex(bytes) !== digest) defective.add(path);
    }
    for (const entry of entries) {
      if (isReleaseManagedBundleFile(entry) && !declared.has(entry)) defective.add(entry);
    }
  }
  const manifestBytes = await readFileOrNull(join(pluginDirectory, "manifest.json"));
  const { pluginId, pluginVersion } = parseInstalledManifest(manifestBytes);
  return {
    integrity: defective.size === 0 ? "complete" : "damaged",
    pluginId,
    pluginVersion,
    defectiveFiles: [...defective].sort(),
  };
}
