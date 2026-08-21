import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

type Execute = (file: string, arguments_: readonly string[]) => Promise<{ readonly stdout: string }>;

async function acquireFileLock(path: string): Promise<{ release(): Promise<void> } | undefined> {
  try {
    const handle = await open(path, "wx");
    return { release: async () => { await handle.close(); await import("node:fs/promises").then(({ unlink }) => unlink(path)); } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function jobFileName(processId: number, sequence: number): string {
  return `local-dispatch-${processId}-${sequence}`;
}

function parseJobFileName(name: string): { readonly processId: number } | undefined {
  const match = /^local-dispatch-(\d+)-\d+$/u.exec(name);
  return match === null ? undefined : { processId: Number(match[1]) };
}

export function createAutomationScheduler(options: {
  readonly repositoryPath?: string;
  readonly execute?: Execute;
  readonly acquireLock?: () => Promise<{ release(): Promise<void> } | undefined>;
}) {
  const execute = options.execute ?? (async (file, arguments_) => {
    const result = await executeFile(file, [...arguments_], { cwd: options.repositoryPath });
    return { stdout: result.stdout };
  });
  const repositoryPath = options.repositoryPath ?? process.cwd();
  const jobsDirectory = resolve(repositoryPath, ".sandcastle", "dispatcher-jobs");
  let nextJob = 0;
  return {
    acquire: options.acquireLock ?? (() => acquireFileLock(resolve(repositoryPath, ".sandcastle", "dispatcher.lock"))),
    async prepare() {
      const branch = (await execute("git", ["branch", "--show-current"])).stdout.trim();
      if (branch !== "master") throw new Error("Dispatcher must run on master");
      const status = (await execute("git", ["status", "--porcelain", "--untracked-files=normal"])).stdout;
      if (status.length > 0) throw new Error("Dispatcher repository must be clean");
      await execute("git", ["fetch", "origin", "master"]);
      const divergence = (await execute("git", ["rev-list", "--left-right", "--count", "master...origin/master"])).stdout.trim();
      const [ahead, behind] = divergence.split(/\s+/u).map(Number);
      if (ahead !== 0 && behind !== 0) throw new Error("Dispatcher repository has diverged from origin/master");
      if (ahead !== 0) throw new Error("Dispatcher repository is ahead of origin/master");
      await execute("git", ["merge", "--ff-only", "origin/master"]);
    },
    async track(identity: string, action: () => Promise<void>) {
      const jobId = jobFileName(process.pid, ++nextJob);
      await mkdir(jobsDirectory, { recursive: true });
      // Publish atomically so a concurrent inspection never reads a partial file.
      await writeFile(join(jobsDirectory, `${jobId}.writing`), identity);
      await rename(join(jobsDirectory, `${jobId}.writing`), join(jobsDirectory, jobId));
      try {
        await action();
      } finally {
        await rm(join(jobsDirectory, jobId), { force: true });
      }
    },
    async activeJobs() {
      let jobIds: string[];
      try {
        jobIds = await readdir(jobsDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const jobs = await Promise.all(jobIds.sort().map(async (jobId) => {
        const parsed = parseJobFileName(jobId);
        if (parsed === undefined || !isProcessAlive(parsed.processId)) return undefined;
        try {
          return { jobId, identity: await readFile(join(jobsDirectory, jobId), "utf8") };
        } catch (error) {
          // The job may finish and remove its file between readdir and readFile.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      }));
      return jobs.filter((job) => job !== undefined);
    },
  };
}
