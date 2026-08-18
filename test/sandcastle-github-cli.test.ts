import { describe, expect, it, vi } from "vitest";

import { GithubCliPort } from "../.sandcastle/github-cli.js";

describe("Sandcastle GitHub CLI adapter", () => {
  it("idempotently creates or updates the failure label", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const github = new GithubCliPort(execute);

    await github.ensureLabel("sandcastle:failed");

    expect(execute).toHaveBeenCalledWith("gh", [
      "label",
      "create",
      "sandcastle:failed",
      "--color",
      "B60205",
      "--description",
      "Sandcastle automation could not complete this Issue",
      "--force",
    ]);
  });
});
