import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep, dirname } from "node:path";

import { sha256Hex } from "./candidate-bundle.js";

/**
 * Test-Vault lifecycle seam (issue #197): every run creates one dedicated
 * generated Vault and profile root, refuses to overwrite any pre-existing
 * root, records before/after inventories (paths, sizes, and hashes only —
 * never note bodies), and reports residual paths after cleanup. A timeout or
 * killed outer process is never treated as proof of cleanup (spec §12.6).
 */

export const TEST_VAULT_DIRECTORY_PREFIX = "installed-runtime-vault-";
export const TEST_PROFILE_DIRECTORY_PREFIX = "installed-runtime-profile-";

/** Deterministic seed notes so health/discovery observations are reproducible. */
const SEED_NOTES: ReadonlyArray<readonly [string, string]> = [
  [
    "Notes/Welcome.md",
    "---\ntags: [harness]\n---\n# Installed Runtime Harness\n\nThis generated note seeds the dedicated test Vault.\n",
  ],
  [
    "Notes/Linked.md",
    "# Linked\n\nReferences [[Welcome]] for discovery warm-up.\n",
  ],
];

export class TestVaultError extends Error {
  constructor(
    message: string,
    readonly code: "vault_root_exists" | "vault_provision_failed",
  ) {
    super(message);
    this.name = "TestVaultError";
  }
}

export interface ProvisionedTestVault {
  readonly vaultPath: string;
  readonly profileDirectory: string;
  /** Paths and content of the seeded notes, kept private to the run. */
  readonly seedNotes: readonly { path: string; content: string }[];
  /** Canonical digest over the sorted seed paths and their content hashes. */
  readonly seedManifestSha256: string;
}

export interface VaultInventoryEntry {
  /** Vault-relative POSIX path. */
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface CleanupReport {
  readonly attempted: boolean;
  readonly residualPaths: readonly string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Creates one dedicated generated test Vault plus a sibling dedicated Obsidian
 * profile directory under `workingDirectory`. Both roots must be absent; the
 * harness never overwrites an existing root (spec §12.2/§12.6).
 */
export async function provisionTestVault(options: {
  workingDirectory: string;
  runId?: string;
  configDirectoryName?: string;
}): Promise<ProvisionedTestVault> {
  const runId = options.runId ?? randomUUID();
  if (!/^[A-Za-z0-9_-]+$/u.test(runId)) {
    throw new TestVaultError("Run identity contains unsupported characters", "vault_provision_failed");
  }
  const configDirectoryName = options.configDirectoryName ?? ".obsidian";
  const vaultPath = join(options.workingDirectory, `${TEST_VAULT_DIRECTORY_PREFIX}${runId}`);
  const profileDirectory = join(
    options.workingDirectory,
    `${TEST_PROFILE_DIRECTORY_PREFIX}${runId}`,
  );
  for (const root of [vaultPath, profileDirectory]) {
    if (await pathExists(root)) {
      throw new TestVaultError(
        `Refusing to overwrite existing root: ${root}`,
        "vault_root_exists",
      );
    }
  }
  try {
    await mkdir(join(vaultPath, configDirectoryName), { recursive: true });
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(join(vaultPath, configDirectoryName, "app.json"), "{}\n", "utf8");
    for (const [path, content] of SEED_NOTES) {
      const destination = join(vaultPath, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
    }
  } catch (error) {
    throw new TestVaultError(
      `Test Vault provisioning failed: ${error instanceof Error ? error.message : String(error)}`,
      "vault_provision_failed",
    );
  }
  const seedManifest = SEED_NOTES.map(
    ([path, content]) => `${sha256Hex(new TextEncoder().encode(content))}  ${path}`,
  )
    .sort()
    .join("\n");
  return {
    vaultPath,
    profileDirectory,
    seedNotes: SEED_NOTES.map(([path, content]) => ({ path, content })),
    seedManifestSha256: sha256Hex(new TextEncoder().encode(`${seedManifest}\n`)),
  };
}

/**
 * Snapshots one Vault inventory as sorted path/size/hash entries. Note bodies
 * are never recorded — only their digests.
 */
export async function snapshotInventory(root: string): Promise<VaultInventoryEntry[]> {
  const entries: VaultInventoryEntry[] = [];
  const walk = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = join(directory, child.name);
      if (child.isDirectory()) {
        await walk(absolute);
      } else if (child.isFile()) {
        const bytes = new Uint8Array(await readFile(absolute));
        const relativePath = relative(root, absolute).split(sep).join("/");
        entries.push({ path: relativePath, sha256: sha256Hex(bytes), sizeBytes: bytes.length });
      }
      // Symlinks and junctions are never followed (spec invariant 12).
    }
  };
  await walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function digestEntries(entries: readonly VaultInventoryEntry[]): string {
  const canonical = entries
    .map((entry) => `${entry.sha256}  ${entry.sizeBytes}  ${entry.path}`)
    .join("\n");
  return createHash("sha256").update(`${canonical}\n`, "utf8").digest("hex");
}

export interface InventoryComparison {
  readonly beforeDigest: string;
  readonly afterDigest: string;
  /** Paths only ever added or removed by the run itself, per closure. */
  readonly addedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly changedPaths: readonly string[];
}

export function compareInventories(
  before: readonly VaultInventoryEntry[],
  after: readonly VaultInventoryEntry[],
): InventoryComparison {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const added = [...afterByPath.keys()].filter((path) => !beforeByPath.has(path));
  const removed = [...beforeByPath.keys()].filter((path) => !afterByPath.has(path));
  const changed = [...beforeByPath.keys()].filter(
    (path) => afterByPath.get(path)?.sha256 !== beforeByPath.get(path)?.sha256,
  );
  return {
    beforeDigest: digestEntries(before),
    afterDigest: digestEntries(after),
    addedPaths: added.sort(),
    removedPaths: removed.sort(),
    changedPaths: changed.sort(),
  };
}

/**
 * Removes the generated roots and re-scans for residuals. Cleanup failure or
 * surviving content is reported, never hidden (spec §12.6).
 */
export async function cleanupTestVault(
  vault: Pick<ProvisionedTestVault, "vaultPath" | "profileDirectory">,
): Promise<CleanupReport> {
  const residualPaths: string[] = [];
  let firstError: unknown;
  for (const root of [vault.vaultPath, vault.profileDirectory]) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      firstError ??= error;
    }
    if (await pathExists(root)) {
      try {
        const remaining = await snapshotInventory(root);
        residualPaths.push(...remaining.map((entry) => entry.path));
        if (remaining.length === 0) residualPaths.push("/");
      } catch {
        residualPaths.push("/");
      }
    }
  }
  if (firstError !== undefined && residualPaths.length === 0) {
    residualPaths.push("/");
  }
  return { attempted: true, residualPaths };
}
