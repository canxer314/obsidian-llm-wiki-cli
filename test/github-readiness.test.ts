import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import {
  githubAgentReadiness,
  githubAgentReadinessProcess,
  githubAgentReadinessRequiredFor,
  GithubAgentReadinessError,
  requireGithubAgentReadiness,
  type GithubAgentReadinessProcess,
} from "../.sandcastle/github-readiness.js";

const image = "sandcastle:content-addressed";
const environment: Readonly<Record<string, string>> = {
  HTTP_PROXY: "http://proxy.invalid:7890",
  ANTHROPIC_BASE_URL: "http://provider.invalid",
  ANTHROPIC_AUTH_TOKEN: "settings-secret",
  GH_TOKEN: "github_pat_must-not-leak",
};

function dockerChild(): ChildProcess & EventEmitter {
  const process = new EventEmitter() as ChildProcess & EventEmitter;
  Object.defineProperties(process, {
    stdout: { value: new EventEmitter() },
    stderr: { value: new EventEmitter() },
  });
  return process;
}

const mockSpawn = vi.mocked(spawn);

function result(overrides: Partial<{ stdout: string; stderr: string; exitCode: number }>) {
  return { stdout: "", stderr: "", exitCode: 0, ...overrides };
}

function processReturning(value: { stdout?: string; stderr?: string; exitCode: number }) {
  return { run: vi.fn<GithubAgentReadinessProcess["run"]>().mockResolvedValue(result(value)) };
}

const probeEnvironment = { ...environment, HOME: "/home/agent" };
const probeArguments = [
  "run",
  "--rm",
  "--network",
  "host",
  "--user",
  "1000:1000",
  ...Object.keys(probeEnvironment).flatMap((name) => ["-e", name]),
  "--entrypoint",
  "sh",
  image,
  "-c",
  "timeout 30s gh auth status --show-token=false",
];

describe("GitHub-capable Agent container readiness", () => {
  it("passes the exact GitHub-capable Agent environment through Docker without placing values in argv", async () => {
    const child = dockerChild();
    mockSpawn.mockReturnValue(child);
    const probe = githubAgentReadinessProcess.run(probeArguments, probeEnvironment);
    child.emit("close", 0);

    await expect(probe).resolves.toEqual(result({}));
    expect(mockSpawn).toHaveBeenCalledWith("docker", probeArguments, {
      env: probeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const arguments_ = mockSpawn.mock.calls[0]?.[1] ?? [];
    for (const value of Object.values(environment)) {
      expect(arguments_).not.toContain(value);
      expect(arguments_.join("\0")).not.toContain(value);
    }
  });

  it("runs a read-only gh authentication probe against the exact image and environment", async () => {
    const process = processReturning({ exitCode: 0 });

    await expect(githubAgentReadiness({
      image,
      uid: 1000,
      gid: 1000,
      environment,
      process,
    })).resolves.toBe("ready");

    expect(process.run).toHaveBeenCalledOnce();
    expect(process.run).toHaveBeenCalledWith(probeArguments, probeEnvironment);
  });

  it("classifies a missing GH_TOKEN without starting a container", async () => {
    const process = processReturning({ exitCode: 0 });

    await expect(githubAgentReadiness({
      image,
      uid: 1000,
      gid: 1000,
      environment: { HTTP_PROXY: "http://proxy.invalid:7890" },
      process,
    })).resolves.toBe("missing");

    expect(process.run).not.toHaveBeenCalled();
  });

  it.each([
    { name: "authentication failure exit", stderr: "error: authentication failed", exitCode: 4 },
    { name: "401 response", stderr: "HTTP 401: Bad credentials", exitCode: 1 },
    { name: "bad credentials wording", stderr: "could not fetch scopes for token: HTTP 401: Bad credentials", exitCode: 1 },
    { name: "unauthorized wording", stderr: "GET /user: 401 Unauthorized", exitCode: 1 },
  ])("classifies invalid container authentication from $name", async ({ stderr, exitCode }) => {
    const process = processReturning({ stderr, exitCode });

    await expect(githubAgentReadiness({
      image,
      uid: 1000,
      gid: 1000,
      environment,
      process,
    })).resolves.toBe("invalid");
  });

  it("classifies a gh that reports no login as missing even with a configured token", async () => {
    const process = processReturning({ stderr: "error: not logged in to any hosts", exitCode: 4 });

    await expect(githubAgentReadiness({
      image,
      uid: 1000,
      gid: 1000,
      environment,
      process,
    })).resolves.toBe("missing");
  });

  it.each([
    { name: "missing GitHub CLI", stderr: "timeout: failed to run command 'gh': No such file or directory", exitCode: 127 },
    { name: "container network failure", stderr: "Get \"https://api.github.com/user\": dial tcp 140.82.112.5:443: connection refused", exitCode: 1 },
    { name: "missing image", stderr: "docker: Error response from daemon: unable to find image", exitCode: 125 },
  ])("classifies a probe that cannot run as unavailable from $name", async ({ stderr, exitCode }) => {
    const process = processReturning({ stderr, exitCode });

    await expect(githubAgentReadiness({
      image,
      uid: 1000,
      gid: 1000,
      environment,
      process,
    })).resolves.toBe("unavailable");
  });

  it("classifies a Docker failure as unavailable", async () => {
    const process = { run: vi.fn<GithubAgentReadinessProcess["run"]>().mockRejectedValue(new Error("docker spawn failed")) };

    await expect(githubAgentReadiness({
      image,
      uid: 1000,
      gid: 1000,
      environment,
      process,
    })).resolves.toBe("unavailable");
  });

  it("exposes only a stable classified, redacted error for missing authentication", async () => {
    const process = processReturning({ exitCode: 0 });

    await expect(requireGithubAgentReadiness({
      image,
      uid: 1000,
      gid: 1000,
      environment: { HTTP_PROXY: "http://proxy.invalid:7890" },
      process,
    })).rejects.toEqual(new GithubAgentReadinessError("missing"));
    await expect(requireGithubAgentReadiness({
      image,
      uid: 1000,
      gid: 1000,
      environment: { HTTP_PROXY: "http://proxy.invalid:7890" },
      process,
    })).rejects.toThrow(
      "GitHub-capable Agent container authentication is not ready; GH_TOKEN is missing from the private environment file",
    );
  });

  it("never exposes raw probe output, the token, or the image name in errors", async () => {
    const process = processReturning({
      stdout: `Logged in to github.com as ${image} using token ${environment.GH_TOKEN}`,
      stderr: "authentication failed: HTTP 401: Bad credentials",
      exitCode: 4,
    });

    await expect(requireGithubAgentReadiness({
      image,
      uid: 1000,
      gid: 1000,
      environment,
      process,
    })).rejects.toBeInstanceOf(GithubAgentReadinessError);

    const error = await requireGithubAgentReadiness({
      image,
      uid: 1000,
      gid: 1000,
      environment,
      process,
    }).catch((caught: unknown) => caught instanceof Error ? caught.message : String(caught));
    expect(error).toBe(
      "GitHub-capable Agent container authentication is not ready; GH_TOKEN in the private environment file does not authenticate",
    );
    expect(error).not.toContain(environment.GH_TOKEN);
    expect(error).not.toContain(image);
    expect(error).not.toContain("401");
    expect(error).not.toContain("Bad credentials");
  });

  it("exposes a stable classified error for an unavailable probe", async () => {
    const process = { run: vi.fn<GithubAgentReadinessProcess["run"]>().mockRejectedValue(new Error("docker spawn failed")) };

    await expect(requireGithubAgentReadiness({
      image,
      uid: 1000,
      gid: 1000,
      environment,
      process,
    })).rejects.toThrow(
      "GitHub-capable Agent container authentication readiness is unavailable; run `npm run sandcastle -- inspect`",
    );
  });

  it("requires the probe only for operations that start GitHub-capable Agent Sessions", () => {
    for (const operation of ["review", "implement", "implement-spec", "feedback", "split"]) {
      expect(githubAgentReadinessRequiredFor(operation)).toBe(true);
    }
    for (const operation of ["update-branch", "architecture-review", "dispatch", "inspect", "setup-labels", "build-image", "anything"]) {
      expect(githubAgentReadinessRequiredFor(operation)).toBe(false);
    }
  });
});
