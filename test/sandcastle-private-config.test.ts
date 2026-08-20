import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SandcastleConfigError,
  loadSandcastleConfig,
} from "../.sandcastle/private-config.js";

const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  settingsPath: string;
  envPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-config-"));
  roots.push(root);
  return {
    root,
    settingsPath: join(root, "settings.json"),
    envPath: join(root, ".env"),
  };
}

async function writePrivateEnv(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Sandcastle private configuration adapter", () => {
  it("reads only the Claude Code settings environment whitelist", async () => {
    const { settingsPath, envPath } = await fixture();
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "upstream-opus",
          HTTPS_PROXY: "http://127.0.0.1:7890",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          AWS_SECRET_ACCESS_KEY: "must-not-leak",
        },
        permissions: { allow: ["Bash(*)"] },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");

    const config = await loadSandcastleConfig({ settingsPath, envPath });

    expect(config.environment).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
      ANTHROPIC_AUTH_TOKEN: "settings-secret",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "upstream-opus",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      GH_TOKEN: "github-secret",
    });
    expect(config.proxyEnvironment).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:7890",
    });
    expect(config.environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(config.environment).not.toHaveProperty(
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    );
  });

  it("uses non-empty private env values as overrides", async () => {
    const { settingsPath, envPath } = await fixture();
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTPS_PROXY: "http://settings-proxy:7890",
        },
      }),
    );
    await writePrivateEnv(
      envPath,
      [
        "GH_TOKEN=github-secret",
        "ANTHROPIC_AUTH_TOKEN=override-secret",
        "HTTPS_PROXY=http://private-proxy:7890",
        "UNRELATED_SECRET=ignored",
        "",
      ].join("\n"),
    );

    const config = await loadSandcastleConfig({ settingsPath, envPath });

    expect(config.environment.ANTHROPIC_AUTH_TOKEN).toBe("override-secret");
    expect(config.environment.HTTPS_PROXY).toBe("http://private-proxy:7890");
    expect(config.proxyEnvironment).toEqual({
      HTTPS_PROXY: "http://private-proxy:7890",
    });
    expect(config.environment).not.toHaveProperty("UNRELATED_SECRET");
  });

  it("uses a private default model and supports the three role overrides", async () => {
    const { settingsPath, envPath } = await fixture();
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
        },
      }),
    );
    await writePrivateEnv(
      envPath,
      [
        "GH_TOKEN=github-secret",
        "SANDCASTLE_MODEL=team-default",
        "SANDCASTLE_PLANNER_MODEL=planner-local",
        "SANDCASTLE_REVIEWER_MODEL=reviewer-local",
        "",
      ].join("\n"),
    );

    const config = await loadSandcastleConfig({ settingsPath, envPath });

    expect(config.models).toEqual({
      default: "team-default",
      planner: "planner-local",
      implementer: "team-default",
      reviewer: "reviewer-local",
    });
  });

  it("fails before startup when a required value is missing without exposing secrets", async () => {
    const { settingsPath, envPath } = await fixture();
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456/token-in-url",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=\n");

    const error = await loadSandcastleConfig({ settingsPath, envPath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SandcastleConfigError);
    expect(String(error)).toContain("GH_TOKEN");
    expect(String(error)).not.toContain("settings-secret");
    expect(String(error)).not.toContain("token-in-url");
  });

  it("rejects a private env file whose mode is broader than 0600", async () => {
    const { settingsPath, envPath } = await fixture();
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");
    await chmod(envPath, 0o640);

    await expect(
      loadSandcastleConfig({ settingsPath, envPath }),
    ).rejects.toThrow(/0600/);
  });

  it("redacts configured values from startup logs", async () => {
    const { settingsPath, envPath } = await fixture();
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");
    const messages: string[] = [];

    await loadSandcastleConfig({
      settingsPath,
      envPath,
      log: (message) => messages.push(message),
    });

    expect(messages).toEqual([
      "Loaded Sandcastle private configuration (3 environment variables; 0 role model overrides)",
    ]);
    expect(messages.join(" ")).not.toContain("settings-secret");
    expect(messages.join(" ")).not.toContain("github-secret");
    expect(messages.join(" ")).not.toContain("127.0.0.1");
  });
});
