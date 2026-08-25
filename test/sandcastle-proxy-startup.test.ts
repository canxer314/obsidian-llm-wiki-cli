import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const dockerCalls = vi.hoisted(() => [] as Array<{
  readonly imageName: string;
  readonly network: string;
  readonly env: Readonly<Record<string, string>>;
}>);

vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: vi.fn((options: (typeof dockerCalls)[number]) => {
    dockerCalls.push(options);
    return { kind: "docker-fixture", options };
  }),
}));

import { loadSandboxStartup } from "../.sandcastle/sandbox.js";
import { inspectGithubAgentReadiness } from "../.sandcastle/github-readiness.js";

const roots: string[] = [];
const originalHttpsProxy = process.env.HTTPS_PROXY;
const gitIdentityStub = vi.fn().mockResolvedValue({
  name: "canxer",
  email: "canxer314@live.com",
});

afterEach(async () => {
  dockerCalls.splice(0);
  if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = originalHttpsProxy;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Sandcastle proxy startup", () => {
  it("loads a mode-0600 provider configuration without GH_TOKEN and reports missing without probing", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-proxy-startup-"));
    roots.push(root);
    const settingsPath = join(root, "settings.json");
    const envPath = join(root, ".env");
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://claude.example",
          ANTHROPIC_AUTH_TOKEN: "claude-secret",
        },
      }),
    );
    await writeFile(envPath, "", { mode: 0o600 });
    await chmod(envPath, 0o600);
    const probe = vi.fn();

    const startup = await loadSandboxStartup({ settingsPath, envPath }, { readGitIdentity: gitIdentityStub });
    const inspection = await inspectGithubAgentReadiness({
      image: startup.imageName,
      uid: startup.uid,
      gid: startup.gid,
      environment: startup.childEnvironments.githubAgent,
      process: { run: probe },
    });

    expect(inspection).toEqual({ githubAgentReadiness: "missing" });
    expect(probe).not.toHaveBeenCalled();
    expect(startup.childEnvironments.githubAgent.GH_TOKEN).toBeUndefined();
  });

  it("passes one resolved value to every sandbox and every child environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-proxy-startup-"));
    roots.push(root);
    const settingsPath = join(root, "settings.json");
    const envPath = join(root, ".env");
    const resolved = "  http://current-host-proxy.example/$opaque  ";
    process.env.HTTPS_PROXY = resolved;
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://claude.example",
          ANTHROPIC_AUTH_TOKEN: "claude-secret",
          HTTPS_PROXY: "${HTTPS_PROXY}",
        },
      }),
    );
    await writeFile(envPath, "GH_TOKEN=github-secret\n", { mode: 0o600 });
    await chmod(envPath, 0o600);

    const startup = await loadSandboxStartup({ settingsPath, envPath }, { readGitIdentity: gitIdentityStub });

    expect(startup.environment.HTTPS_PROXY).toBe(resolved);
    expect(startup.proxyEnvironment.HTTPS_PROXY).toBe(resolved);
    expect(startup.childEnvironments.dependencies.HTTPS_PROXY).toBe(resolved);
    expect(startup.childEnvironments.git.HTTPS_PROXY).toBe(resolved);
    expect(startup.childEnvironments.github.HTTPS_PROXY).toBe(resolved);
    expect(startup.childEnvironments.claude.HTTPS_PROXY).toBe(resolved);
    expect(startup.childEnvironments.githubAgent.HTTPS_PROXY).toBe(resolved);
    expect(dockerCalls).toHaveLength(3);
    expect(dockerCalls[0]).toMatchObject({
      network: "host",
      env: { HTTPS_PROXY: resolved },
    });
    expect(dockerCalls[1]).toMatchObject({
      network: "host",
      env: { HTTPS_PROXY: resolved },
    });
    expect(dockerCalls[2]).toMatchObject({
      network: "host",
      env: { HTTPS_PROXY: resolved },
    });
  });

  it("keeps GH_TOKEN out of the Claude-only sandbox and inside the GitHub-capable sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-proxy-startup-"));
    roots.push(root);
    const settingsPath = join(root, "settings.json");
    const envPath = join(root, ".env");
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://claude.example",
          ANTHROPIC_AUTH_TOKEN: "claude-secret",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
          HTTP_PROXY: "http://proxy.example",
          SANDCASTLE_DEFAULT_MODEL: "claude-routed-default",
          SANDCASTLE_REVIEWER_MODEL: "claude-routed-reviewer",
        },
      }),
    );
    await writeFile(envPath, "GH_TOKEN=github-secret\n", { mode: 0o600 });
    await chmod(envPath, 0o600);

    const startup = await loadSandboxStartup({ settingsPath, envPath }, { readGitIdentity: gitIdentityStub });

    expect(dockerCalls).toHaveLength(3);
    const automationSandbox = dockerCalls[1]?.env ?? {};
    const githubAgentSandbox = dockerCalls[2]?.env ?? {};
    expect(automationSandbox.GH_TOKEN).toBeUndefined();
    expect(githubAgentSandbox.GH_TOKEN).toBe("github-secret");
    expect(githubAgentSandbox).toEqual({
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      ANTHROPIC_BASE_URL: "https://claude.example",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      GH_TOKEN: "github-secret",
      GIT_AUTHOR_NAME: "canxer",
      GIT_AUTHOR_EMAIL: "canxer314@live.com",
      GIT_COMMITTER_NAME: "canxer",
      GIT_COMMITTER_EMAIL: "canxer314@live.com",
      HTTP_PROXY: "http://proxy.example",
    });
    expect(Object.keys(githubAgentSandbox)).not.toContain("PATH");
    expect(Object.keys(githubAgentSandbox)).not.toContain("HOME");
    expect(githubAgentSandbox).not.toHaveProperty("SANDCASTLE_DEFAULT_MODEL");
    expect(githubAgentSandbox).not.toHaveProperty("SANDCASTLE_REVIEWER_MODEL");
  });

  it("fails before creating either sandbox when a winning proxy reference is unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-proxy-startup-"));
    roots.push(root);
    const settingsPath = join(root, "settings.json");
    const envPath = join(root, ".env");
    process.env.HTTPS_PROXY =
      "http://fictional-host-user:fictional-host-pass@fictional-host.example/secret-host-fragment";
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://claude.example",
          ANTHROPIC_AUTH_TOKEN: "claude-secret",
          HTTPS_PROXY:
            "http://fictional-config.example/secret-config-fragment/${HTTPS_PROXY}",
        },
      }),
    );
    await writeFile(envPath, "GH_TOKEN=github-secret\n", { mode: 0o600 });
    await chmod(envPath, 0o600);

    const error = await loadSandboxStartup({ settingsPath, envPath }, { readGitIdentity: gitIdentityStub }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(dockerCalls).toHaveLength(0);
    const diagnostic = String(error);
    expect(diagnostic).toContain("HTTPS_PROXY");
    for (const sentinel of [
      "fictional-config.example",
      "secret-config-fragment",
      "fictional-host-user",
      "fictional-host-pass",
      "fictional-host.example",
      "secret-host-fragment",
      "claude-secret",
      "github-secret",
    ]) {
      expect(diagnostic).not.toContain(sentinel);
    }
  });

  it("fails before creating either sandbox when the checkout has no git identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-proxy-startup-"));
    roots.push(root);
    const settingsPath = join(root, "settings.json");
    const envPath = join(root, ".env");
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://claude.example",
          ANTHROPIC_AUTH_TOKEN: "claude-secret",
        },
      }),
    );
    await writeFile(envPath, "GH_TOKEN=github-secret\n", { mode: 0o600 });
    await chmod(envPath, 0o600);
    const missingIdentity = vi.fn().mockResolvedValue({ name: "", email: "" });

    const error = await loadSandboxStartup({ settingsPath, envPath }, { readGitIdentity: missingIdentity }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("git identity");
    expect(dockerCalls).toHaveLength(0);
  });
});
