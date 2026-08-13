import { access, readdir, rename, rm } from "node:fs/promises";

import { RELEASE_MANAGED_FILES } from "./release-lifecycle.js";

export interface AtomicReleaseDirectoryReplacement {
  pluginDirectory: string;
  stagedDirectory: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertCompleteStagedBundle(stagedDirectory: string): Promise<void> {
  const entries = await readdir(stagedDirectory, { withFileTypes: true });
  const names = new Set(entries.map(({ name }) => name));
  for (const required of ["manifest.json", "main.js"]) {
    if (!names.has(required)) throw new Error(`Staged release is missing ${required}`);
  }
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !RELEASE_MANAGED_FILES.includes(entry.name as (typeof RELEASE_MANAGED_FILES)[number])
    ) {
      throw new Error(`Staged release contains unmanaged entry: ${entry.name}`);
    }
  }
}

export async function atomicReplaceReleaseDirectory({
  pluginDirectory,
  stagedDirectory,
}: AtomicReleaseDirectoryReplacement): Promise<void> {
  await assertCompleteStagedBundle(stagedDirectory);
  const backupDirectory = `${pluginDirectory}.release-backup`;
  if (await exists(backupDirectory)) {
    throw new Error("Release backup destination already exists");
  }

  const hadInstalledRelease = await exists(pluginDirectory);
  if (hadInstalledRelease) await rename(pluginDirectory, backupDirectory);
  try {
    await rename(stagedDirectory, pluginDirectory);
  } catch (error) {
    if (hadInstalledRelease) await rename(backupDirectory, pluginDirectory);
    throw error;
  }
  if (hadInstalledRelease) await rm(backupDirectory, { recursive: true });
}
