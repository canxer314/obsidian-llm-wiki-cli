import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createChildEnvironments } from "../.sandcastle/automation-environment.js";
import { createProcessBranchUpdater } from "../.sandcastle/branch-update-process-runner.js";
import { createTargetCheckout } from "../.sandcastle/target-checkout.js";

const executeFile = promisify(execFile);

const PACKAGE_JSON = JSON.stringify({
  name: "publication-fixture",
  version: "1.0.0",
  private: true,
});
const PACKAGE_LOCK = JSON.stringify({
  name: "publication-fixture",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "publication-fixture", version: "1.0.0" },
  },
});

const git = async (arguments_: readonly string[]): Promise<string> =>
  (await executeFile("git", [...arguments_])).stdout.trim();

const commitAll = async (repositoryPath: string, message: string): Promise<string> => {
  await git(["-C", repositoryPath, "add", "-A"]);
  await git(["-C", repositoryPath, "commit", "-m", message]);
  return git(["-C", repositoryPath, "rev-parse", "HEAD"]);
};

interface PublicationFixture {
  readonly root: string;
  readonly remotePath: string;
  readonly contributorPath: string;
  readonly trustedPath: string;
  readonly masterRevision: string;
  readonly pullRequestHead: string;
}

// Builds the production topology with plain local repositories: a bare remote
// standing in for GitHub, a contributor clone holding the Pull Request branch,
// and the trusted operator repository whose origin points at the remote. The
// Pull Request head is pushed only to the remote, after the trusted clone, so
// the trusted repository never holds the Pull Request objects.
async function createFixture(): Promise<PublicationFixture> {
  const root = await mkdtemp(join(tmpdir(), "publication-path-"));
  const remotePath = join(root, "remote.git");
  const contributorPath = join(root, "contributor");
  const trustedPath = join(root, "trusted");
  await git(["init", "--bare", "-b", "master", remotePath]);
  // GitHub serves unadvertised objects; the local stand-in must opt in.
  await git(["-C", remotePath, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  await git(["init", "-b", "master", contributorPath]);
  await git(["-C", contributorPath, "config", "user.name", "Fixture Contributor"]);
  await git(["-C", contributorPath, "config", "user.email", "contributor@fixture.example"]);
  await writeFile(join(contributorPath, "package.json"), PACKAGE_JSON);
  await writeFile(join(contributorPath, "package-lock.json"), PACKAGE_LOCK);
  const masterRevision = await commitAll(contributorPath, "initial commit");
  await git(["-C", contributorPath, "remote", "add", "origin", remotePath]);
  await git(["-C", contributorPath, "push", "origin", "master"]);
  await git(["clone", remotePath, trustedPath]);
  await git(["-C", contributorPath, "switch", "-c", "pr-branch"]);
  await writeFile(join(contributorPath, "pr-change.txt"), "pull request head\n");
  const pullRequestHead = await commitAll(contributorPath, "pull request change");
  await git(["-C", contributorPath, "push", "origin", "pr-branch"]);
  return { root, remotePath, contributorPath, trustedPath, masterRevision, pullRequestHead };
}

// Wires the checkout exactly as main.ts does: the narrow child environments
// carry git/npm resolution, with no mock anywhere in the git layer.
function createFixtureCheckout(trustedPath: string): {
  readonly environments: ReturnType<typeof createChildEnvironments>;
  readonly checkout: ReturnType<typeof createTargetCheckout>;
} {
  const environments = createChildEnvironments(process.env as Record<string, string>);
  return {
    environments,
    checkout: createTargetCheckout({
      sourceRepositoryPath: trustedPath,
      gitEnvironment: environments.git,
      dependencyEnvironment: environments.dependencies,
    }),
  };
}

describe("publication path (real git repositories)", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  const fixture = async (): Promise<PublicationFixture> => {
    const created = await createFixture();
    roots.push(created.root);
    return created;
  };

  it("checks out a Pull Request head that exists only on the remote", { timeout: 60_000 }, async () => {
    const { trustedPath, pullRequestHead } = await fixture();
    const { checkout } = createFixtureCheckout(trustedPath);

    const head = await checkout.withCheckout(
      { pullRequestNumber: 1, revision: pullRequestHead },
      (checkoutPath) => git(["-C", checkoutPath, "rev-parse", "HEAD"]),
    );

    expect(head).toBe(pullRequestHead);
    await expect(git(["-C", trustedPath, "cat-file", "-e", pullRequestHead])).rejects.toThrow();
    await expect(git(["-C", trustedPath, "for-each-ref"])).resolves.not.toContain("pr-branch");
  });

  it("publishes the merged branch update to the remote, never the trusted repository", { timeout: 60_000 }, async () => {
    const { remotePath, contributorPath, trustedPath, pullRequestHead } = await fixture();
    await git(["-C", contributorPath, "switch", "master"]);
    await writeFile(join(contributorPath, "master-change.txt"), "master moved\n");
    await commitAll(contributorPath, "master advances");
    await git(["-C", contributorPath, "push", "origin", "master"]);
    const { checkout } = createFixtureCheckout(trustedPath);
    const updater = createProcessBranchUpdater({});

    const result = await checkout.withCheckout(
      { pullRequestNumber: 1, revision: pullRequestHead },
      async (checkoutPath) => {
        await git(["-C", checkoutPath, "config", "user.name", "Fixture Updater"]);
        await git(["-C", checkoutPath, "config", "user.email", "updater@fixture.example"]);
        return updater.update({
          pullRequestNumber: 1,
          branch: "pr-branch",
          baseBranch: "master",
          revision: pullRequestHead,
          checkoutPath,
        });
      },
    );

    expect(result.revision).not.toBe(pullRequestHead);
    await expect(git(["-C", remotePath, "rev-parse", "refs/heads/pr-branch"]))
      .resolves.toBe(result.revision);
    await expect(git(["-C", trustedPath, "show-ref", "--verify", "refs/heads/pr-branch"]))
      .rejects.toThrow();
    await expect(git(["-C", trustedPath, "cat-file", "-e", result.revision])).rejects.toThrow();
  });

  it("installs dependencies in the checkout with the narrow child environment", { timeout: 60_000 }, async () => {
    const { trustedPath, masterRevision } = await fixture();
    const { environments, checkout } = createFixtureCheckout(trustedPath);
    expect(environments.dependencies).toMatchObject({
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    });
    // npm resolves through the narrow PATH; without it this is ENOENT on
    // hosts where npm lives outside the default executable search path.
    await expect(executeFile("npm", ["--version"], { env: environments.dependencies }))
      .resolves.toBeDefined();

    // withCheckout runs `npm ci --ignore-scripts` before the action, so a
    // resolved HEAD proves the install step succeeded in the child environment.
    const installed = await checkout.withCheckout(
      { revision: masterRevision },
      (checkoutPath) => git(["-C", checkoutPath, "rev-parse", "HEAD"]),
    );

    expect(installed).toBe(masterRevision);
  });
});
