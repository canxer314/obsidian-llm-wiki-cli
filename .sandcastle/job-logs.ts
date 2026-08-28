import { appendFileSync } from "node:fs";
import { chmod, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { INHERITED_JOB_PROCESS_GROUP } from "./worker-process.ts";

const JOB_LOG_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export interface JobLog {
  readonly directory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly metadataPath: string;
  readonly metadata: {
    readonly jobId: string;
    readonly operation: string;
    readonly number: number;
    readonly revision: string;
    readonly startedAt: number;
  };
}

export const JOB_STDOUT_LOG = "SANDCASTLE_JOB_STDOUT_LOG";
export const JOB_STDERR_LOG = "SANDCASTLE_JOB_STDERR_LOG";

export function inheritedJobLogEnvironment(log: JobLog): Readonly<Record<string, string>> {
  return {
    [INHERITED_JOB_PROCESS_GROUP]: "1",
    [JOB_STDOUT_LOG]: log.stdoutPath,
    [JOB_STDERR_LOG]: log.stderrPath,
  };
}

export function appendInheritedJobOutput(
  stream: "stdout" | "stderr",
  output: string | Buffer,
): void {
  appendJobOutputFromEnvironment(process.env, stream, output);
}

export function appendJobOutputFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  stream: "stdout" | "stderr",
  output: string | Buffer,
): void {
  const path = environment[stream === "stdout" ? JOB_STDOUT_LOG : JOB_STDERR_LOG];
  if (path !== undefined) appendFileSync(path, output);
}

export async function createJobLog(options: {
  readonly root: string;
  readonly jobId: string;
  readonly operation: string;
  readonly number: number;
  readonly revision: string;
  readonly now?: number;
}): Promise<JobLog> {
  if (!/^[A-Za-z0-9_-]+$/u.test(options.jobId)) {
    throw new Error("Job log ID is invalid");
  }
  const directory = join(options.root, options.jobId);
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  await chmod(options.root, 0o700);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const stdoutPath = join(directory, "stdout.log");
  const stderrPath = join(directory, "stderr.log");
  const metadataPath = join(directory, "metadata.json");
  await Promise.all([
    createPrivateFile(stdoutPath),
    createPrivateFile(stderrPath),
  ]);
  const metadata = {
    jobId: options.jobId,
    operation: options.operation,
    number: options.number,
    revision: options.revision,
    startedAt: options.now ?? Date.now(),
  };
  await writeFile(metadataPath, JSON.stringify({ ...metadata, status: "running" }), {
    mode: 0o600,
    flag: "wx",
  });
  return { directory, stdoutPath, stderrPath, metadataPath, metadata };
}

export function appendJobOutput(
  log: JobLog,
  stream: "stdout" | "stderr",
  output: string | Buffer,
): void {
  appendFileSync(stream === "stdout" ? log.stdoutPath : log.stderrPath, output);
}

export async function completeJobLog(
  log: JobLog,
  result: { readonly status: "completed" | "failed" | "timed-out"; readonly now?: number },
): Promise<void> {
  await writeFile(log.metadataPath, JSON.stringify({
    ...log.metadata,
    status: result.status,
    completedAt: result.now ?? Date.now(),
  }), { mode: 0o600 });
}

export async function removeExpiredJobLogs(options: {
  readonly root: string;
  readonly preserve?: readonly string[];
  readonly now?: number;
}): Promise<void> {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  await chmod(options.root, 0o700);
  const preserve = new Set(options.preserve ?? []);
  const expiredBefore = (options.now ?? Date.now()) - JOB_LOG_RETENTION_MILLISECONDS;
  const entries = await readdir(options.root, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !preserve.has(entry.name))
    .map(async (entry) => {
      const path = join(options.root, entry.name);
      if ((await stat(path)).mtimeMs < expiredBefore) {
        await rm(path, { recursive: true, force: true });
      }
    }));
}

async function createPrivateFile(path: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  await file.close();
}
