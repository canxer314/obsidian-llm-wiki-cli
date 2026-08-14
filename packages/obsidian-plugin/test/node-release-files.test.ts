import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  atomicReplaceReleaseDirectory,
  removeReleaseManagedFiles,
  type ReleaseFileOperations,
} from "../src/node-release-files.js";

const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  pluginDirectory: string;
  stagedDirectory: string;
}> {
  const root = await mkdtemp(join(process.env.CLAUDE_JOB_DIR ?? tmpdir(), "release-files-"));
  roots.push(root);
  const pluginDirectory = join(root, "vault", ".obsidian", "plugins", "bridge");
  const stagedDirectory = join(root, "vault", ".obsidian", "plugins", ".bridge-stage");
  await mkdir(pluginDirectory, { recursive: true });
  await mkdir(stagedDirectory, { recursive: true });
  await mkdir(join(root, "vault", ".llm-wiki"), { recursive: true });
  await writeFile(join(pluginDirectory, "manifest.json"), "old manifest");
  await writeFile(join(pluginDirectory, "main.js"), "old main");
  await writeFile(join(pluginDirectory, "operator-notes.txt"), "preserve me");
  await writeFile(join(pluginDirectory, "data.json"), "persisted settings");
  await writeFile(join(root, "vault", ".llm-wiki", "bridge-state.json"), "durable state");
  await writeFile(join(stagedDirectory, "manifest.json"), "new manifest");
  await writeFile(join(stagedDirectory, "main.js"), "new main");
  return { root, pluginDirectory, stagedDirectory };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomic release file replacement", () => {
  it("replaces the complete plugin directory and preserves Bridge operational state", async () => {
    const { root, pluginDirectory, stagedDirectory } = await fixture();

    await atomicReplaceReleaseDirectory({ pluginDirectory, stagedDirectory });

    await expect(readFile(join(pluginDirectory, "manifest.json"), "utf8"))
      .resolves.toBe("new manifest");
    await expect(readFile(join(pluginDirectory, "main.js"), "utf8"))
      .resolves.toBe("new main");
    await expect(readFile(join(pluginDirectory, "operator-notes.txt"), "utf8"))
      .resolves.toBe("preserve me");
    await expect(readFile(join(pluginDirectory, "data.json"), "utf8"))
      .resolves.toBe("persisted settings");
    await expect(readFile(join(root, "vault", ".llm-wiki", "bridge-state.json"), "utf8"))
      .resolves.toBe("durable state");
    await expect(readdir(join(root, "vault", ".obsidian", "plugins")))
      .resolves.toEqual(["bridge"]);
  });

  it("ordinary uninstall removes only release-managed files", async () => {
    const { root, pluginDirectory } = await fixture();
    await writeFile(join(pluginDirectory, "data.json"), "persisted settings");
    await writeFile(join(pluginDirectory, "styles.css"), "release styles");

    await removeReleaseManagedFiles(pluginDirectory);

    await expect(readdir(pluginDirectory)).resolves.toEqual([
      "data.json",
      "operator-notes.txt",
    ]);
    await expect(readFile(join(pluginDirectory, "data.json"), "utf8"))
      .resolves.toBe("persisted settings");
    await expect(readFile(join(root, "vault", ".llm-wiki", "bridge-state.json"), "utf8"))
      .resolves.toBe("durable state");
  });

  it("reports both replacement and restoration failures", async () => {
    const replacementFailure = new Error("replacement failed");
    const restorationFailure = new Error("restoration failed");
    const operations: ReleaseFileOperations = {
      access: vi.fn(async (path) => {
        if (path === "/plugin") return;
        throw new Error("ENOENT");
      }),
      copy: vi.fn(async () => undefined),
      readdir: vi.fn(async (path) => path.endsWith("stage")
        ? [
            { name: "manifest.json", isFile: () => true },
            { name: "main.js", isFile: () => true },
          ]
        : []),
      rename: vi.fn(async (source, destination) => {
        if (source.endsWith("release-next") && destination.endsWith("plugin")) {
          throw replacementFailure;
        }
        if (source.endsWith("release-backup") && destination.endsWith("plugin")) {
          throw restorationFailure;
        }
      }),
      remove: vi.fn(async () => undefined),
    };

    const result = atomicReplaceReleaseDirectory(
      { pluginDirectory: "/plugin", stagedDirectory: "/stage" },
      operations,
    );

    await expect(result).rejects.toMatchObject({
      message: "Release replacement and restoration both failed",
      errors: [replacementFailure, restorationFailure],
    });
  });

  it("rejects staged bundles with missing or unmanaged files before touching the installed release", async () => {
    const missing = await fixture();
    await rm(join(missing.stagedDirectory, "main.js"));
    await expect(atomicReplaceReleaseDirectory(missing)).rejects.toThrow("main.js");
    await expect(readFile(join(missing.pluginDirectory, "main.js"), "utf8"))
      .resolves.toBe("old main");

    const unmanaged = await fixture();
    await writeFile(join(unmanaged.stagedDirectory, "unexpected.js"), "nope");
    await expect(atomicReplaceReleaseDirectory(unmanaged)).rejects.toThrow("unmanaged");
    await expect(readFile(join(unmanaged.pluginDirectory, "main.js"), "utf8"))
      .resolves.toBe("old main");
  });
});
