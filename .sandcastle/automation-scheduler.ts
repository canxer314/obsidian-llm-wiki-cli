import { open } from "node:fs/promises";
import { resolve } from "node:path";
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

export function createAutomationScheduler(options: {
  readonly repositoryPath?: string;
  readonly execute?: Execute;
  readonly acquireLock?: () => Promise<{ release(): Promise<void> } | undefined>;
}) {
  const execute = options.execute ?? (async (file, arguments_) => {
    const result = await executeFile(file, [...arguments_], { cwd: options.repositoryPath });
    return { stdout: result.stdout };
  });
  const activeJobs = new Map<string, string>();
  let nextJob = 0;
  return {
    acquire: options.acquireLock ?? (() => acquireFileLock(resolve(options.repositoryPath ?? process.cwd(), ".sandcastle", "dispatcher.lock"))),
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
      const jobId = `local-dispatch-${++nextJob}`;
      activeJobs.set(identity, jobId);
      try {
        await action();
      } finally {
        activeJobs.delete(identity);
      }
    },
    activeJobs: async () => [...activeJobs].map(([identity, jobId]) => ({ identity, jobId })),
  };
}
