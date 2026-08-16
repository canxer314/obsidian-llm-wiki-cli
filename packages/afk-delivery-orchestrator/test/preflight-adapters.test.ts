import { describe, expect, it, vi } from "vitest";
import {
  readPinnedSkillsManifestFromImage,
  viewRepositoryWithCredential,
} from "../src/preflight-adapters.js";

describe("pinned skills image adapter", () => {
  it("overrides the delivery image entrypoint to read the pinned manifest", async () => {
    const command = vi.fn(async () => "implement.sha256=abc123");

    await expect(readPinnedSkillsManifestFromImage(
      "sandcastle:obsidian-llm-wiki-cli",
      command,
    )).resolves.toBe("implement.sha256=abc123");

    expect(command).toHaveBeenCalledWith("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "cat",
      "sandcastle:obsidian-llm-wiki-cli",
      "/opt/afk-delivery/skills.lock",
    ]);
  });

  it("gives the installation token only to the repository-access process", async () => {
    const command = vi.fn(async () => "");

    await viewRepositoryWithCredential(
      "canxer314/obsidian-llm-wiki-cli",
      "short-lived-token",
      command,
    );

    expect(command).toHaveBeenCalledWith("gh", [
      "repo",
      "view",
      "canxer314/obsidian-llm-wiki-cli",
      "--json",
      "nameWithOwner",
    ], {
      GITHUB_TOKEN: "short-lived-token",
      GH_TOKEN: "short-lived-token",
    });
  });
});
