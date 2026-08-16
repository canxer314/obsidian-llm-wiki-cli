import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import type { RepairRequest } from "@llm-wiki/afk-delivery-core";
import { createLocalRepairPorts } from "../src/local-stage.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function git(...args: string[]): Promise<string> {
  return (await execFileAsync("git", args)).stdout.trim();
}

async function fixture(): Promise<{
  root: string;
  remote: string;
  repository: string;
  rejectedRevision: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "afk-repair-adapter-"));
  directories.push(root);
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");
  await git("init", "--bare", remote);
  await git("clone", remote, repository);
  await git("-C", repository, "config", "user.name", "AFK Test");
  await git("-C", repository, "config", "user.email", "afk-test@example.invalid");
  await writeFile(join(repository, "value.txt"), "rejected\n");
  await git("-C", repository, "add", "value.txt");
  await git("-C", repository, "commit", "-m", "rejected revision");
  const rejectedRevision = await git("-C", repository, "rev-parse", "HEAD");
  await git("-C", repository, "push", "origin", `HEAD:refs/heads/afk/ticket-68`);
  return { root, remote, repository, rejectedRevision };
}

function request(rejectedRevision: string): RepairRequest {
  return {
    ticket: {
      number: 68,
      open: true,
      labels: ["ready-for-agent"],
      openBlockerNumbers: [],
      dependencyDataComplete: true,
      body: "Repair the rejected Revision.",
    },
    prNumber: 73,
    headBranch: "afk/ticket-68",
    round: 1,
    rejectedRevision,
    reviewHandoff: [
      "## Verdict", "changes-required", "", "## Standards", "### F-1", "Fix retry identity.",
      "", "## Spec", "No additional finding.", "", "## Interactions", "Preserve behavior.",
      "", "## Constraints", "Keep validation intact.",
    ].join("\n"),
    repositoryPolicy: {
      schemaVersion: 1,
      targetBranch: "master",
      readyLabel: "ready-for-agent",
      prohibitedLabel: "afk:prohibited",
      needsHumanLabel: "afk:needs-human",
      trustedActors: [{ login: "delivery-bot", type: "Bot" }],
      maximumRepairRounds: 2,
      requiredValidationCommands: ["npm test"],
      reviewSkill: { path: "/skills/code-review/SKILL.md", revision: "sha256:review" },
      mergeStrategy: "squash",
    },
    repositoryInstructions: "Repository instructions",
    domainDocuments: [{ path: "CONTEXT.md", content: "AFK Delivery" }],
    architectureDecisions: [{ path: "docs/adr/0001.md", content: "GitHub is durable state" }],
    capabilities: {
      sourceReadOnly: false,
      canEdit: true,
      canCommit: true,
      canPush: false,
      canComment: false,
      canApprove: false,
      githubCredentials: false,
    },
  };
}

function ports(repositoryPath: string) {
  return createLocalRepairPorts({
    repositoryPath,
    image: "afk-delivery:test",
    claudeSettingsPath: "/unused/settings.json",
    modelGatewayUrl: "http://127.0.0.1:9999",
    modelGatewayToken: "unused",
  });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("local repair adapter", () => {
  it("checks out the exact rejected Revision and publishes only over its leased head", async () => {
    const value = await fixture();
    const adapter = ports(value.repository);
    const worktree = await adapter.createWorktree(request(value.rejectedRevision));
    directories.push(worktree.path);

    expect(worktree).toMatchObject({
      branch: "afk/ticket-68",
      baseRevision: value.rejectedRevision,
    });
    await expect(git("-C", worktree.path, "rev-parse", "HEAD"))
      .resolves.toBe(value.rejectedRevision);
    await expect(git("-C", worktree.path, "remote")).resolves.toBe("");

    await git("-C", worktree.path, "config", "user.name", "AFK Repair");
    await git("-C", worktree.path, "config", "user.email", "afk-repair@example.invalid");
    await writeFile(join(worktree.path, "value.txt"), "repaired\n");
    await git("-C", worktree.path, "add", "value.txt");
    await git("-C", worktree.path, "commit", "-m", "repair revision");
    const outputRevision = await adapter.resolveHeadRevision(worktree.path);

    await adapter.publishRevision({
      worktreePath: worktree.path,
      headBranch: "afk/ticket-68",
      expectedHeadRevision: value.rejectedRevision,
      outputRevision,
    });

    await expect(git("--git-dir", value.remote, "rev-parse", "refs/heads/afk/ticket-68"))
      .resolves.toBe(outputRevision);
  });

  it("rejects publication when the remote head changed after the repair checkout", async () => {
    const value = await fixture();
    const adapter = ports(value.repository);
    const worktree = await adapter.createWorktree(request(value.rejectedRevision));
    directories.push(worktree.path);

    await git("-C", worktree.path, "config", "user.name", "AFK Repair");
    await git("-C", worktree.path, "config", "user.email", "afk-repair@example.invalid");
    await writeFile(join(worktree.path, "value.txt"), "stale repair\n");
    await git("-C", worktree.path, "add", "value.txt");
    await git("-C", worktree.path, "commit", "-m", "stale repair");
    const outputRevision = await adapter.resolveHeadRevision(worktree.path);

    await writeFile(join(value.repository, "value.txt"), "concurrent change\n");
    await git("-C", value.repository, "add", "value.txt");
    await git("-C", value.repository, "commit", "-m", "concurrent revision");
    const concurrentRevision = await git("-C", value.repository, "rev-parse", "HEAD");
    await git("-C", value.repository, "push", "origin", `HEAD:refs/heads/afk/ticket-68`);

    await expect(adapter.publishRevision({
      worktreePath: worktree.path,
      headBranch: "afk/ticket-68",
      expectedHeadRevision: value.rejectedRevision,
      outputRevision,
    })).rejects.toThrow();
    await expect(git("--git-dir", value.remote, "rev-parse", "refs/heads/afk/ticket-68"))
      .resolves.toBe(concurrentRevision);
  });
});
