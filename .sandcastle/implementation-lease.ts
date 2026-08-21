import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface ImplementationLease {
  release(): Promise<void>;
}

export async function acquirePullRequestLease(options: {
  readonly root: string;
  readonly pullRequestNumber: number;
}): Promise<ImplementationLease | undefined> {
  if (!Number.isSafeInteger(options.pullRequestNumber) || options.pullRequestNumber < 1) {
    throw new Error("Pull Request lease number is invalid");
  }
  return acquireLease({
    root: options.root,
    lockName: `pull-request-${options.pullRequestNumber}.lock`,
  });
}

export async function acquireImplementationLease(options: {
  readonly root: string;
  readonly issueNumber: number;
}): Promise<ImplementationLease | undefined> {
  if (!Number.isSafeInteger(options.issueNumber) || options.issueNumber < 1) {
    throw new Error("Implementation lease Issue number is invalid");
  }
  return acquireLease({ root: options.root, lockName: `issue-${options.issueNumber}.lock` });
}

async function acquireLease(options: {
  readonly root: string;
  readonly lockName: string;
}): Promise<ImplementationLease | undefined> {
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const path = join(options.root, options.lockName);
  const process = spawn("sh", [
    "-c",
    "exec 9>\"$1\"; flock --exclusive --nonblock 9 || exit 75; printf acquired; cat",
    "sh",
    path,
  ], {
    stdio: ["pipe", "pipe", "ignore", "pipe"],
  });
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (stdin === null || stdout === null) throw new Error("Implementation lease streams are unavailable");
  const acquired = await new Promise<boolean>((resolve, reject) => {
    let output = "";
    process.once("error", reject);
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output === "acquired") resolve(true);
    });
    process.once("exit", (code) => {
      if (output !== "acquired") resolve(code === 75 ? false : false);
    });
  });
  if (!acquired) return undefined;
  return {
    release: async () => new Promise((resolve) => {
      process.once("exit", () => resolve());
      stdin.end();
    }),
  };
}
