import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  buildSandcastleImage,
  dockerResourceSuffix,
  requireSandcastleImage,
  sandcastleImageName,
  sandcastleImageReadiness,
  type DockerImageInspectionProcess,
  type DockerImageProcess,
} from "../.sandcastle/docker-image.js";
import { loadSandboxStartup } from "../.sandcastle/sandbox.js";

async function imageFixture(lock = "lock-a"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-image-"));
  await mkdir(join(root, ".sandcastle"));
  await mkdir(join(root, "packages/contracts"), { recursive: true });
  await mkdir(join(root, "packages/obsidian-plugin"), { recursive: true });
  const files = {
    ".dockerignore": "*\n",
    ".sandcastle/Dockerfile": "FROM node:24.14.0-bookworm\n",
    "package.json": "{}\n",
    "package-lock.json": `${lock}\n`,
    "packages/contracts/package.json": "{}\n",
    "packages/obsidian-plugin/package.json": "{}\n",
  };
  await Promise.all(
    Object.entries(files).map(([path, content]) => writeFile(join(root, path), content)),
  );
  return root;
}

describe("Sandcastle Docker image builder", () => {
  it("builds a content-addressed image from the repository context", async () => {
    const repositoryPath = await imageFixture();
    const image = await sandcastleImageName({ repositoryPath, uid: 1000, gid: 1000 });
    const run = vi.fn<DockerImageProcess["run"]>(async () => undefined);

    await expect(buildSandcastleImage({
      repositoryPath,
      uid: 1000,
      gid: 1000,
      environment: {
        HTTPS_PROXY: "http://proxy.invalid:7890",
        GH_TOKEN: "must-not-pass",
      },
      process: { run },
    })).resolves.toBe(image);

    expect(run).toHaveBeenCalledWith(
      "docker",
      [
        "build",
        "--build-arg",
        "AGENT_UID=1000",
        "--build-arg",
        "AGENT_GID=1000",
        "--build-arg",
        "HTTPS_PROXY",
        "--file",
        ".sandcastle/Dockerfile",
        "--tag",
        image,
        ".",
      ],
      {
        cwd: repositoryPath,
        environment: { HTTPS_PROXY: "http://proxy.invalid:7890" },
      },
    );
    expect(run.mock.calls[0]?.[1].join(" ")).not.toContain("proxy.invalid");
    expect(run.mock.calls[0]?.[1].join(" ")).not.toContain("must-not-pass");
  });

  it("builds the exact content-addressed image selected for runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-startup-"));
    const settingsPath = join(root, "settings.json");
    const envPath = join(root, "env");
    await writeFile(settingsPath, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://provider.invalid",
        ANTHROPIC_AUTH_TOKEN: "settings-secret",
      },
    }));
    await writeFile(
      envPath,
      "GH_TOKEN=github-secret\nHTTPS_PROXY=http://proxy.invalid:7890\n",
      { mode: 0o600 },
    );
    await chmod(envPath, 0o600);
    const repositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const expectedImage = await sandcastleImageName({
      repositoryPath,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    });
    const run = vi.fn<DockerImageProcess["run"]>(async () => undefined);

    try {
      const startup = await loadSandboxStartup({ settingsPath, envPath });

      expect(startup.imageName).toBe(expectedImage);
      await expect(buildSandcastleImage({
        repositoryPath: startup.repositoryPath,
        uid: startup.uid,
        gid: startup.gid,
        environment: startup.proxyEnvironment,
        image: startup.imageName,
        process: { run },
      })).resolves.toBe(expectedImage);
      expect(run.mock.calls[0]?.[1]).toContain(expectedImage);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks image readiness without exposing the selected image or Docker output", async () => {
    const inspect = vi.fn<DockerImageInspectionProcess["inspect"]>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const process = { inspect };
    const image = "sandcastle:private-content-addressed-name";

    await expect(sandcastleImageReadiness({ image, process })).resolves.toBe("ready");
    await expect(sandcastleImageReadiness({ image, process })).resolves.toBe("missing");
    await expect(requireSandcastleImage({ image, process })).rejects.toThrow(
      "Sandcastle Docker image is not ready; run `npm run sandcastle -- build-image`",
    );

    expect(inspect).toHaveBeenCalledWith(image);
    const error = await requireSandcastleImage({
      image,
      process: { inspect: async () => false },
    }).catch((caught: unknown) => String(caught));
    expect(error).not.toContain(image);
  });

  it("isolates image tags when dependency inputs differ", async () => {
    const first = await imageFixture("lock-a");
    const second = await imageFixture("lock-b");

    const firstImage = await sandcastleImageName({ repositoryPath: first, uid: 1000, gid: 1000 });
    const secondImage = await sandcastleImageName({ repositoryPath: second, uid: 1000, gid: 1000 });

    expect(firstImage).not.toBe(secondImage);
    expect(firstImage.length).toBeLessThanOrEqual(128);
    expect(secondImage.length).toBeLessThanOrEqual(128);
  });

  it("derives fixed-length Docker resource suffixes", () => {
    expect(dockerResourceSuffix("x".repeat(128))).toMatch(/^[0-9a-f]{16}$/u);
  });
});
