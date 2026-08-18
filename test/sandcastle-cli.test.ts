import { describe, expect, it, vi } from "vitest";

import {
  SandcastleCliError,
  runSandcastleCli,
  type SandcastleGithubPort,
} from "../.sandcastle/cli.js";

function githubPort(): SandcastleGithubPort {
  return {
    ensureLabel: vi.fn(),
    getIssue: vi.fn(),
  };
}

describe("Sandcastle CLI", () => {
  it("requires an explicit Issue in the default mode without scanning the backlog", async () => {
    const github = githubPort();
    const startPlanner = vi.fn();

    await expect(
      runSandcastleCli([], { github, startPlanner }),
    ).rejects.toMatchObject<SandcastleCliError>({
      message: "Missing required --issue <number>; use --watch to scan the backlog",
      exitCode: 2,
    });

    expect(github.getIssue).not.toHaveBeenCalled();
    expect(startPlanner).not.toHaveBeenCalled();
  });

  it("rejects --issue and --watch together with a non-zero exit result", async () => {
    const github = githubPort();
    const startPlanner = vi.fn();

    await expect(
      runSandcastleCli(["--issue", "100", "--watch"], {
        github,
        startPlanner,
      }),
    ).rejects.toMatchObject<SandcastleCliError>({
      message: "--issue and --watch cannot be used together",
      exitCode: 2,
    });

    expect(github.getIssue).not.toHaveBeenCalled();
    expect(startPlanner).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects invalid Issue number %s before startup",
    async (value) => {
      const github = githubPort();

      await expect(
        runSandcastleCli(["--issue", value], {
          github,
          startPlanner: vi.fn(),
        }),
      ).rejects.toMatchObject<SandcastleCliError>({
        message: "--issue requires a positive integer",
        exitCode: 2,
      });

      expect(github.ensureLabel).not.toHaveBeenCalled();
    },
  );

  it("prepares the failure label when watch mode starts", async () => {
    const github = githubPort();

    await runSandcastleCli(["--watch"], {
      github,
      startPlanner: vi.fn(),
    });

    expect(github.ensureLabel).toHaveBeenCalledWith("sandcastle:failed");
    expect(github.getIssue).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "does not exist",
      issue: null,
      message: "Issue #100 does not exist",
    },
    {
      name: "is closed",
      issue: { number: 100, state: "CLOSED", labels: ["Sandcastle"] },
      message: "Issue #100 must be open",
    },
    {
      name: "does not have the Sandcastle label",
      issue: { number: 100, state: "OPEN", labels: ["ready-for-agent"] },
      message: "Issue #100 must have the Sandcastle label",
    },
  ])("stops before Planner when the target $name", async ({ issue, message }) => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue(issue);
    const startPlanner = vi.fn();

    await expect(
      runSandcastleCli(["--issue", "100"], { github, startPlanner }),
    ).rejects.toMatchObject<SandcastleCliError>({ message, exitCode: 2 });

    expect(github.ensureLabel).toHaveBeenCalledWith("sandcastle:failed");
    expect(startPlanner).not.toHaveBeenCalled();
  });

  it("idempotently prepares the failure label and starts Planner for an eligible target", async () => {
    const github = githubPort();
    vi.mocked(github.getIssue).mockResolvedValue({
      number: 100,
      state: "OPEN",
      labels: ["documentation", "Sandcastle"],
    });
    const startPlanner = vi.fn();

    await runSandcastleCli(["--issue", "100"], { github, startPlanner });

    expect(github.ensureLabel).toHaveBeenCalledWith("sandcastle:failed");
    expect(startPlanner).toHaveBeenCalledWith(100);
  });
});
