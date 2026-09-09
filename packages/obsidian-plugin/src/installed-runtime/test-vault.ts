import { Buffer } from "node:buffer";
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

/**
 * Deterministic seed notes so health/discovery observations are reproducible
 * (issue #174). The byte-exact corpus fixtures are generated deterministically
 * at provision time and never recorded in evidence — only their paths, Content
 * Versions, and byte sizes are. They exercise the byte spellings the acceptance
 * corpus must prove: UTF-8 BOM, LF/CRLF mixtures, CJK, astral Unicode (ZWJ and
 * combining sequences), and exact UTF-8 — plus one note over 1 MiB and two
 * accepted notes whose logical Exact Read total exceeds 1 MiB.
 */
const WELCOME_NOTE =
  "---\ntags: [harness]\n---\n# Installed Runtime Harness\n\nThis generated note seeds the dedicated test Vault.\n";
const LINKED_NOTE = "# Linked\n\nReferences [[Welcome]] for discovery warm-up.\n";
const BOM_NOTE = "﻿# 位元組\r\nBOM 前綴與 CRLF 保留。\n第二行 LF 中文正文 😀。\r\n";
const CJK_ASTRAL_NOTE =
  "# 中文與星體\n\n線界 é 組合字元與 😀 星體字元。\r\n末行 LF 結尾。\n";

const TRANSPORT_PREFIX = "﻿# 傳輸\r\n";
const GROUP_PREFIX = "﻿# 分組\r\n";
const OVER_LIMIT_PREFIX = "﻿# 超限\r\n";
const TRANSPORT_LINE = "線界é😀abcdefghij\r\n";
const GROUP_LINE = "組線😀🧑‍💻abcdefghij\r\n";
const OVER_LIMIT_LINE = "超限正文😀éabcdefghij\r\n";

function repeatedByteContent(prefix: string, line: string, minimumBytes: number): string {
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes === 0) {
    throw new Error("A deterministic fixture line must carry at least one byte");
  }
  const repeat = Math.max(0, Math.ceil((minimumBytes - prefixBytes) / lineBytes));
  return prefix + new Array(repeat).fill(line).join("");
}

/**
 * Deterministic seed manifest for the installed-runtime read-side corpus
 * (issue #174): the transport-framing note is under 1 MiB but large enough
 * that its compact response exceeds the 256 KiB transport bound; the grouping
 * note is also under 1 MiB; together their logical Exact Read total exceeds
 * 1 MiB so a combined request returns deterministic contiguous groups. The
 * over-limit note alone exceeds 1 MiB and must refuse Exact Read.
 */
const SEED_NOTES: ReadonlyArray<readonly [string, string]> = [
  ["Notes/Welcome.md", WELCOME_NOTE],
  ["Notes/Linked.md", LINKED_NOTE],
  ["Notes/Bom.md", BOM_NOTE],
  ["Notes/CjkAstral.md", CJK_ASTRAL_NOTE],
  ["Notes/Transport.md", repeatedByteContent(TRANSPORT_PREFIX, TRANSPORT_LINE, 420_000)],
  ["Notes/GroupLarge.md", repeatedByteContent(GROUP_PREFIX, GROUP_LINE, 700_000)],
  ["Notes/OverLimit.md", repeatedByteContent(OVER_LIMIT_PREFIX, OVER_LIMIT_LINE, 1_100_000)],
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
    // Both roots were verified absent before this block, so any path that now
    // exists was created by this provision attempt; remove it so a failed run
    // never leaves generated roots behind without a residual report.
    let cleanupNote = "";
    try {
      await rm(vaultPath, { recursive: true, force: true });
      await rm(profileDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      cleanupNote = `; partial cleanup also failed: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`;
    }
    throw new TestVaultError(
      `Test Vault provisioning failed: ${error instanceof Error ? error.message : String(error)}${cleanupNote}`,
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
  // A path is changed only when it exists in both inventories with a different
  // digest; a removal is reported by `removedPaths`, never double-counted here.
  const changed = [...beforeByPath.keys()].filter(
    (path) =>
      afterByPath.has(path) &&
      afterByPath.get(path)!.sha256 !== beforeByPath.get(path)!.sha256,
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
