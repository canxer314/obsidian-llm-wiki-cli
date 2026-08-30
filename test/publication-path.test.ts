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

const FIXTURE_HTTPS_REMOTE = "https://github.com/example/publication-fixture.git";

async function executeFixtureCommand(
  remotePath: string,
  file: string,
  arguments_: readonly string[],
  environment?: Readonly<Record<string, string>>,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const actualArguments = arguments_.map((argument) =>
    argument === FIXTURE_HTTPS_REMOTE ? remotePath : argument,
  );
  const result = await executeFile(file, [...actualArguments], { env: environment });
  return { stdout: result.stdout, stderr: result.stderr };
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
  await git(["-C", trustedPath, "config", "user.name", "Trusted Publication Source"]);
  await git(["-C", trustedPath, "config", "user.email", "trusted-publication@example.test"]);
  await git(["-C", trustedPath, "remote", "set-url", "origin", FIXTURE_HTTPS_REMOTE]);
  await git(["-C", contributorPath, "switch", "-c", "pr-branch"]);
  await writeFile(join(contributorPath, "pr-change.txt"), "pull request head\n");
  const pullRequestHead = await commitAll(contributorPath, "pull request change");
  await git(["-C", contributorPath, "push", "origin", "pr-branch"]);
  return { root, remotePath, contributorPath, trustedPath, masterRevision, pullRequestHead };
}

// Wires Target Checkout with the production HTTPS remote shape while mapping
// only fixture-network traffic to the local bare repository.
function createFixtureCheckout(trustedPath: string, remotePath: string): {
  readonly environments: ReturnType<typeof createChildEnvironments>;
  readonly checkout: ReturnType<typeof createTargetCheckout>;
} {
  const environments = createChildEnvironments(process.env as Record<string, string>);
  return {
    environments,
    checkout: createTargetCheckout({
      sourceRepositoryPath: trustedPath,
      execute: (file, arguments_, environment) => executeFixtureCommand(remotePath, file, arguments_, environment),
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
    const fixture = await createFixture();
    const { trustedPath, pullRequestHead, remotePath } = fixture;
    const { checkout } = createFixtureCheckout(trustedPath, remotePath);

    const head = await checkout.withCheckout(
      { pullRequestNumber: 1, revision: pullRequestHead },
      async (checkoutPath) => ({
        value: await git(["-C", checkoutPath, "rev-parse", "HEAD"]),
        disposition: "cleanup" as const,
      }),
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
    const { checkout, environments } = createFixtureCheckout(trustedPath, remotePath);
    const updater = createProcessBranchUpdater({ environment: environments.git });

    const result = await checkout.withCheckout(
      { pullRequestNumber: 1, revision: pullRequestHead },
      async (checkoutPath) => {
        expect(await git(["-C", checkoutPath, "config", "--local", "--get", "user.name"]))
          .toBe("Trusted Publication Source");
        expect(await git(["-C", checkoutPath, "config", "--local", "--get", "user.email"]))
          .toBe("trusted-publication@example.test");
        const value = await updater.update({
          pullRequestNumber: 1,
          branch: "pr-branch",
          baseBranch: "master",
          revision: pullRequestHead,
          checkoutPath,
        });
        return { value, disposition: "cleanup" as const };
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
    const { trustedPath, masterRevision, remotePath } = await fixture();
    const { environments, checkout } = createFixtureCheckout(trustedPath, remotePath);
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
      async (checkoutPath) => ({
        value: await git(["-C", checkoutPath, "rev-parse", "HEAD"]),
        disposition: "cleanup" as const,
      }),
    );

    expect(installed).toBe(masterRevision);
  });
});
