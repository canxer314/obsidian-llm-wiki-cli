import { describe, expect, it, vi } from "vitest";

import {
  createDockerLocalQualityHost,
  runDockerLocalQuality,
  type LocalQualityProcess,
} from "../.sandcastle/docker-local-quality-host.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

function processPort() {
  const run = vi.fn<LocalQualityProcess["run"]>(async (_command, args) => ({
    exitCode: 0,
    output: args[0] === "exec" ? "\n__SANDCASTLE_LOCAL_QUALITY_EXIT__=0\n" : "",
  }));
  return { run };
}

describe("Docker local quality host", () => {
  it("checks out the exact revision and starts the repository Node.js 24 container", async () => {
    const process = processPort();
    const host = createDockerLocalQualityHost({
      repositoryPath: "/repo",
      worktreeRoot: "/repo/.sandcastle/worktrees",
      runId: "quality-104",
      uid: 1000,
      gid: 1000,
      process,
    });

    await host.setup(revision);

    expect(process.run.mock.calls).toEqual([
      ["git", ["worktree", "add", "--detach", "/repo/.sandcastle/worktrees/quality-104", revision], { cwd: "/repo" }],
      ["docker", ["build", "--build-arg", "AGENT_UID=1000", "--build-arg", "AGENT_GID=1000", "--file", "/repo/.sandcastle/Dockerfile", "--tag", "sandcastle:local-quality", "/repo"], { cwd: "/repo" }],
      ["docker", ["run", "--detach", "--name", "quality-104", "--network", "host", "--user", "1000:1000", "--volume", "/repo/.sandcastle/worktrees/quality-104:/home/agent/workspace", "--workdir", "/home/agent/workspace", "sandcastle:local-quality"], { cwd: "/repo" }],
    ]);
  });

  it("separates container command failures from Docker failures", async () => {
    const process = processPort();
    const host = createDockerLocalQualityHost({
      repositoryPath: "/repo",
      worktreeRoot: "/worktrees",
      runId: "quality-104",
      uid: 1000,
      gid: 1000,
      process,
    });
    await host.setup(revision);
    process.run.mockResolvedValueOnce({
      exitCode: 0,
      output: "test failed\n__SANDCASTLE_LOCAL_QUALITY_EXIT__=1\n",
    });

    await expect(host.run(["npm", "test"])).resolves.toEqual({
      exitCode: 1,
      output: "test failed",
    });
    process.run.mockRejectedValueOnce(new Error("Docker daemon disconnected"));
    await expect(host.run(["npm", "test"])).rejects.toThrow("Docker daemon disconnected");
  });

  it("provides a production entry point for one exact revision", async () => {
    const process = processPort();

    await expect(runDockerLocalQuality(revision, {
      repositoryPath: "/repo",
      worktreeRoot: "/worktrees",
      runId: "quality-104",
      uid: 1000,
      gid: 1000,
      process,
    })).resolves.toEqual({ status: "success" });

    expect(process.run.mock.calls.filter(([command, args]) =>
      command === "docker" && args[0] === "exec"
    )).toHaveLength(4);
  });

  it("reports real cleanup command failures after attempting all cleanup", async () => {
    const process = processPort();
    const host = createDockerLocalQualityHost({
      repositoryPath: "/repo",
      worktreeRoot: "/worktrees",
      runId: "quality-104",
      uid: 1000,
      gid: 1000,
      process,
    });
    await host.setup(revision);
    process.run.mockResolvedValueOnce({ exitCode: 1, output: "container busy" });

    await expect(host.dispose()).rejects.toThrow("container busy");
    expect(process.run).toHaveBeenLastCalledWith(
      "git",
      ["worktree", "remove", "--force", "/worktrees/quality-104"],
      { cwd: "/repo", allowFailure: true },
    );
  });

  it("runs commands only inside the prepared container and disposes both resources", async () => {
    const process = processPort();
    const host = createDockerLocalQualityHost({
      repositoryPath: "/repo",
      worktreeRoot: "/worktrees",
      runId: "quality-104",
      uid: 1000,
      gid: 1000,
      process,
    });

    await expect(host.run(["npm", "test"])).rejects.toThrow("not prepared");
    await host.setup(revision);
    await host.run(["npm", "test"]);
    await host.dispose();

    expect(process.run).toHaveBeenCalledWith(
      "docker",
      [
        "exec",
        "quality-104",
        "sh",
        "-c",
        "\"$@\"; status=$?; printf '\\n__SANDCASTLE_LOCAL_QUALITY_EXIT__=%s\\n' \"$status\"",
        "local-quality",
        "npm",
        "test",
      ],
      { cwd: "/repo" },
    );
    expect(process.run.mock.calls.slice(-2)).toEqual([
      ["docker", ["rm", "--force", "quality-104"], { cwd: "/repo", allowFailure: true }],
      ["git", ["worktree", "remove", "--force", "/worktrees/quality-104"], { cwd: "/repo", allowFailure: true }],
    ]);
  });
});
