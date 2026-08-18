import { describe, expect, it, vi } from "vitest";

import { GithubCliPort } from "../.sandcastle/github-cli.js";

describe("Sandcastle GitHub CLI adapter", () => {
  it("atomically creates the deterministic remote branch from the default branch", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "[]\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const github = new GithubCliPort(execute);

    await expect(github.claimIssue(102)).resolves.toBe(true);

    expect(execute.mock.calls).toEqual([
      [
        "gh",
        [
          "pr",
          "list",
          "--head",
          "sandcastle/issue-102",
          "--state",
          "all",
          "--json",
          "number",
          "--limit",
          "1",
        ],
      ],
      [
        "gh",
        ["api", "repos/{owner}/{repo}/commits/HEAD", "--jq", ".sha"],
      ],
      [
        "gh",
        [
          "api",
          "repos/{owner}/{repo}/git/refs",
          "--method",
          "POST",
          "-f",
          "ref=refs/heads/sandcastle/issue-102",
          "-f",
          "sha=abc123",
        ],
      ],
    ]);
  });

  it("skips a target with an associated Pull Request", async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: '[{"number":321}]\n',
      stderr: "",
    });
    const github = new GithubCliPort(execute);

    await expect(github.claimIssue(102)).resolves.toBe(false);

    expect(execute).toHaveBeenCalledOnce();
  });

  it("skips a target whose deterministic remote branch already exists", async () => {
    const conflict = Object.assign(new Error("gh api failed"), {
      stderr: "gh: Reference already exists (HTTP 422)\n",
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "[]\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockRejectedValueOnce(conflict);
    const github = new GithubCliPort(execute);

    await expect(github.claimIssue(102)).resolves.toBe(false);
  });

  it("allows only one concurrent runner to claim the same target", async () => {
    let created = false;
    const execute = vi.fn(async (_file: string, arguments_: readonly string[]) => {
      if (arguments_[0] === "pr") return { stdout: "[]\n", stderr: "" };
      if (arguments_[0] === "api" && arguments_[1]?.endsWith("/commits/HEAD")) {
        return { stdout: "abc123\n", stderr: "" };
      }
      await Promise.resolve();
      if (created) {
        throw Object.assign(new Error("gh api failed"), {
          stderr: "gh: Reference already exists (HTTP 422)\n",
        });
      }
      created = true;
      return { stdout: "", stderr: "" };
    });
    const first = new GithubCliPort(execute);
    const second = new GithubCliPort(execute);

    await expect(
      Promise.all([first.claimIssue(102), second.claimIssue(102)]),
    ).resolves.toEqual([true, false]);
  });

  it("does not hide unrelated remote branch creation failures", async () => {
    const failure = Object.assign(new Error("gh api failed"), {
      stderr: "gh: API rate limit exceeded (HTTP 403)\n",
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "[]\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" })
      .mockRejectedValueOnce(failure);
    const github = new GithubCliPort(execute);

    await expect(github.claimIssue(102)).rejects.toBe(failure);
  });

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
