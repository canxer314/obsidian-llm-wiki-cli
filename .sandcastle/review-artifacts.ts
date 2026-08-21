import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export async function createReviewArtifactDirectory(options: {
  readonly root: string;
  readonly jobId: string;
}): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/u.test(options.jobId)) {
    throw new Error("Review artifact job ID is invalid");
  }
  const directory = join(options.root, options.jobId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
export async function removeExpiredReviewArtifacts(options: {
  readonly root: string;
  readonly now?: number;
}): Promise<void> {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const expiredBefore = (options.now ?? Date.now()) - RETENTION_MILLISECONDS;
  const entries = await readdir(options.root, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = join(options.root, entry.name);
    if ((await stat(path)).mtimeMs < expiredBefore) {
      await rm(path, { recursive: true, force: true });
    }
  }));
}
