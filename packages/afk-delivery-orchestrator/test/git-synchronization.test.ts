import { describe, expect, it } from "vitest";
import {
  createGitSynchronizationPorts,
  type GitSynchronizationCommand,
} from "../src/git-synchronization.js";

const HEAD = "a".repeat(40);
const TARGET = "b".repeat(40);
const OUTPUT = "c".repeat(40);

function request() {
  return {
    prNumber: 73,
    headBranch: "afk/ticket-66",
    expectedHeadRevision: HEAD,
    targetRevision: TARGET,
  };
}

describe("Git synchronization adapter", () => {
  it("creates a deterministic merge Revision and pushes it with an exact-head lease", async () => {
    const calls: Array<{ file: string; args: string[]; environment?: Record<string, string> }> = [];
    const command: GitSynchronizationCommand = async (file, args, options) => {
      calls.push({ file, args, ...(options?.environment === undefined ? {} : { environment: options.environment }) });
      if (file === "git" && args.includes("ls-remote")) return `${HEAD}\trefs/heads/afk/ticket-66`;
      if (file === "git" && args.includes("rev-parse")) return OUTPUT;
      return "";
    };
    const ports = createGitSynchronizationPorts({ repositoryUrl: "git@github.com:owner/repo.git", command });

    await expect(ports.synchronize(request())).resolves.toEqual({
      status: "succeeded",
      outputRevision: OUTPUT,
      narrative: `Merged target Revision ${TARGET} into ${HEAD}.`,
    });
    const merge = calls.find((call) => call.args.includes("merge"));
    expect(merge?.environment).toMatchObject({
      GIT_AUTHOR_NAME: "AFK Delivery",
      GIT_AUTHOR_EMAIL: "afk-delivery@invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
    expect(calls.some((call) => call.args.includes(`--force-with-lease=refs/heads/afk/ticket-66:${HEAD}`))).toBe(true);
  });

  it("returns both conflict sides without pushing when deterministic merge conflicts", async () => {
    const calls: string[][] = [];
    const command: GitSynchronizationCommand = async (_file, args) => {
      calls.push(args);
      if (args.includes("ls-remote")) return `${HEAD}\trefs/heads/afk/ticket-66`;
      if (args.includes("merge")) throw new Error("merge conflict");
      if (args.includes("diff") && args.includes("--name-only")) return "src/index.ts\n";
      if (args.includes("show") && args.at(-1) === ":2:src/index.ts") return "feature side";
      if (args.includes("show") && args.at(-1) === ":3:src/index.ts") return "master side";
      return "";
    };
    const ports = createGitSynchronizationPorts({ repositoryUrl: "git@github.com:owner/repo.git", command });

    await expect(ports.synchronize(request())).resolves.toEqual({
      status: "conflicted",
      narrative: "Deterministic synchronization found 1 conflicting path.",
      conflicts: [{ path: "src/index.ts", ours: "feature side", theirs: "master side" }],
    });
    expect(calls.some((args) => args.includes("push"))).toBe(false);
  });

  it("recovers an already-pushed synchronization Revision without another push", async () => {
    const pushed = "d".repeat(40);
    const calls: string[][] = [];
    const command: GitSynchronizationCommand = async (_file, args) => {
      calls.push(args);
      if (args.includes("ls-remote")) return `${pushed}\trefs/heads/afk/ticket-66`;
      if (args.includes("rev-list")) return `${pushed} ${HEAD} ${TARGET}`;
      return "";
    };
    const ports = createGitSynchronizationPorts({ repositoryUrl: "git@github.com:owner/repo.git", command });

    await expect(ports.synchronize(request())).resolves.toEqual({
      status: "succeeded",
      outputRevision: pushed,
      narrative: `Recovered synchronization Revision ${pushed}.`,
    });
    expect(calls.some((args) => args.includes("push"))).toBe(false);
    expect(calls.some((args) => args.includes("merge"))).toBe(false);
  });

  it("rejects a stale expected head before cloning or pushing", async () => {
    const calls: string[][] = [];
    const command: GitSynchronizationCommand = async (_file, args) => {
      calls.push(args);
      if (args.includes("ls-remote")) return `${"d".repeat(40)}\trefs/heads/afk/ticket-66`;
      return "";
    };
    const ports = createGitSynchronizationPorts({ repositoryUrl: "git@github.com:owner/repo.git", command });

    await expect(ports.synchronize(request())).rejects.toThrow("head changed before synchronization");
    expect(calls.some((args) => args.includes("push"))).toBe(false);
  });
});
