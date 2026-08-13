import { access, cp, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { RELEASE_MANAGED_FILES } from "./release-lifecycle.js";

export interface AtomicReleaseDirectoryReplacement {
  pluginDirectory: string;
  stagedDirectory: string;
}

export interface ReleaseFileOperations {
  access(path: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<readonly { name: string; isFile(): boolean }[]>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const nodeReleaseFileOperations: ReleaseFileOperations = {
  access,
  copy: (source, destination) => cp(source, destination, { recursive: true }),
  readdir,
  rename,
  remove: (path) => rm(path, { recursive: true, force: true }),
};

async function exists(path: string, operations: ReleaseFileOperations): Promise<boolean> {
  try {
    await operations.access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertCompleteStagedBundle(
  stagedDirectory: string,
  operations: ReleaseFileOperations,
): Promise<void> {
  const entries = await operations.readdir(stagedDirectory, { withFileTypes: true });
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

export async function removeReleaseManagedFiles(
  pluginDirectory: string,
  operations: Pick<ReleaseFileOperations, "remove"> = nodeReleaseFileOperations,
): Promise<void> {
  for (const file of RELEASE_MANAGED_FILES) {
    await operations.remove(join(pluginDirectory, file));
  }
}

export async function atomicReplaceReleaseDirectory(
  { pluginDirectory, stagedDirectory }: AtomicReleaseDirectoryReplacement,
  operations: ReleaseFileOperations = nodeReleaseFileOperations,
): Promise<void> {
  await assertCompleteStagedBundle(stagedDirectory, operations);
  const nextDirectory = `${pluginDirectory}.release-next`;
  const backupDirectory = `${pluginDirectory}.release-backup`;
  if (await exists(nextDirectory, operations) || await exists(backupDirectory, operations)) {
    throw new Error("Release transaction destination already exists");
  }

  const hadInstalledRelease = await exists(pluginDirectory, operations);
  await operations.rename(stagedDirectory, nextDirectory);
  try {
    if (hadInstalledRelease) {
      const installedEntries = await operations.readdir(pluginDirectory, { withFileTypes: true });
      for (const { name } of installedEntries) {
        if (!RELEASE_MANAGED_FILES.includes(name as (typeof RELEASE_MANAGED_FILES)[number])) {
          await operations.copy(join(pluginDirectory, name), join(nextDirectory, name));
        }
      }
      await operations.rename(pluginDirectory, backupDirectory);
    }
    try {
      await operations.rename(nextDirectory, pluginDirectory);
    } catch (replacementError) {
      if (hadInstalledRelease) {
        try {
          await operations.rename(backupDirectory, pluginDirectory);
        } catch (restoreError) {
          throw new AggregateError(
            [replacementError, restoreError],
            "Release replacement and restoration both failed",
          );
        }
      }
      throw replacementError;
    }
    if (hadInstalledRelease) await operations.remove(backupDirectory);
  } catch (error) {
    if (await exists(nextDirectory, operations)) {
      await operations.rename(nextDirectory, stagedDirectory).catch(() => undefined);
    }
    throw error;
  }
}
