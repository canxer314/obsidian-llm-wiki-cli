import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SandcastleConfigError,
  loadSandcastleConfig,
} from "../.sandcastle/private-config.js";

const roots: string[] = [];
const originalEnvironment = new Map<string, string | undefined>();

function setProcessEnvironment(name: string, value: string | undefined): void {
  if (!originalEnvironment.has(name)) originalEnvironment.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnvironment.clear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function assertNoSentinels(
  diagnostic: string,
  messages: readonly string[],
  sentinels: readonly string[],
): void {
  for (const sentinel of sentinels) {
    expect(diagnostic).not.toContain(sentinel);
    expect(messages.join(" ")).not.toContain(sentinel);
  }
}

describe("Sandcastle private configuration adapter", () => {
  it.each([
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ])("resolves an exact %s settings reference from the current process environment", async (name) => {
    const { settingsPath, envPath } = await fixture();
    const resolved = `  value-for-${name}-with-$OTHER-and-\${OTHER}  `;
    setProcessEnvironment(name, resolved);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          [name]: `\${${name}}`,
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");

    const config = await loadSandcastleConfig({ settingsPath, envPath });

    expect(config.environment[name]).toBe(resolved);
    expect(config.proxyEnvironment[name]).toBe(resolved);
  });

  it("resolves uppercase and lowercase private references independently on every load", async () => {
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
        "HTTPS_PROXY=\"${HTTPS_PROXY}\"",
        "https_proxy=\"${https_proxy}\"",
        "",
      ].join("\n"),
    );
    setProcessEnvironment("HTTPS_PROXY", "http://uppercase-first.example");
    setProcessEnvironment("https_proxy", "http://lowercase.example");

    const first = await loadSandcastleConfig({ settingsPath, envPath });
    setProcessEnvironment("HTTPS_PROXY", "http://uppercase-second.example");
    const second = await loadSandcastleConfig({ settingsPath, envPath });

    expect(first.proxyEnvironment).toMatchObject({
      HTTPS_PROXY: "http://uppercase-first.example",
      https_proxy: "http://lowercase.example",
    });
    expect(second.proxyEnvironment).toMatchObject({
      HTTPS_PROXY: "http://uppercase-second.example",
      https_proxy: "http://lowercase.example",
    });
  });

  it("fails a winning private reference when its host variable is missing without falling back", async () => {
    const { settingsPath, envPath } = await fixture();
    setProcessEnvironment("HTTPS_PROXY", undefined);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTPS_PROXY: "http://usable-lower-priority.example/secret-fragment",
        },
      }),
    );
    await writePrivateEnv(
      envPath,
      "GH_TOKEN=github-secret\nHTTPS_PROXY=\"${HTTPS_PROXY}\"\n",
    );

    const error = await loadSandcastleConfig({ settingsPath, envPath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SandcastleConfigError);
    expect(String(error)).toContain("HTTPS_PROXY");
    expect(String(error)).toContain("Sandcastle private environment");
    expect(String(error)).toMatch(/missing/i);
    expect(String(error)).not.toContain("usable-lower-priority");
    expect(String(error)).not.toContain("secret-fragment");
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \t  "],
  ])("rejects an %s host value for a settings reference without exposing it", async (reason, hostValue) => {
    const { settingsPath, envPath } = await fixture();
    setProcessEnvironment("HTTP_PROXY", hostValue);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTP_PROXY: "${HTTP_PROXY}",
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");

    const error = await loadSandcastleConfig({ settingsPath, envPath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SandcastleConfigError);
    expect(String(error)).toContain("HTTP_PROXY");
    expect(String(error)).toContain("Claude Code user settings");
    expect(String(error)).toContain(reason);
    expect(String(error)).not.toContain("settings-secret");
  });

  it.each([
    ["cross-key", "${HTTP_PROXY}"],
    ["arbitrary-name", "${OTHER}"],
    ["concatenated", "http://${HTTPS_PROXY}"],
    ["defaulted", "${HTTPS_PROXY:-http://fallback.example}"],
    ["nested", "${${HTTPS_PROXY}}"],
    ["reference-like", "prefix${not-closed"],
  ])("rejects a %s malformed settings proxy reference without echoing it", async (_kind, configured) => {
    const { settingsPath, envPath } = await fixture();
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTPS_PROXY: configured,
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");

    const error = await loadSandcastleConfig({ settingsPath, envPath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SandcastleConfigError);
    expect(String(error)).toContain("HTTPS_PROXY");
    expect(String(error)).toContain("Claude Code user settings");
    expect(String(error)).toMatch(/malformed/i);
    expect(String(error)).not.toContain(configured);
    expect(String(error)).not.toContain("fallback.example");
  });

  it("rejects an unbraced private proxy reference with safe braced-syntax guidance", async () => {
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
      "GH_TOKEN=github-secret\nHTTPS_PROXY=$HTTPS_PROXY\n",
    );

    const error = await loadSandcastleConfig({ settingsPath, envPath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SandcastleConfigError);
    expect(String(error)).toContain("HTTPS_PROXY");
    expect(String(error)).toContain("Sandcastle private environment");
    expect(String(error)).toContain("${HTTPS_PROXY}");
    expect(String(error)).not.toContain("$HTTPS_PROXY\n");
  });

  it("keeps concrete proxy values containing ordinary dollar signs unchanged", async () => {
    const { settingsPath, envPath } = await fixture();
    const concrete = "socks5://fictional$user@proxy.example/$path";
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTPS_PROXY: concrete,
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");

    const config = await loadSandcastleConfig({ settingsPath, envPath });

    expect(config.environment.HTTPS_PROXY).toBe(concrete);
    expect(config.proxyEnvironment.HTTPS_PROXY).toBe(concrete);
  });

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
          NODE_EXTRA_CA_CERTS: "/etc/ssl/corporate-ca.pem",
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
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corporate-ca.pem",
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

  it("does not interpret a losing settings reference when a private concrete value wins", async () => {
    const { settingsPath, envPath } = await fixture();
    setProcessEnvironment("HTTPS_PROXY", undefined);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTPS_PROXY: "${HTTPS_PROXY}",
        },
      }),
    );
    await writePrivateEnv(
      envPath,
      "GH_TOKEN=github-secret\nHTTPS_PROXY=http://private-concrete.example\n",
    );

    const config = await loadSandcastleConfig({ settingsPath, envPath });

    expect(config.proxyEnvironment.HTTPS_PROXY).toBe(
      "http://private-concrete.example",
    );
  });

  it("interprets a winning private reference after it overrides settings concrete value", async () => {
    const { settingsPath, envPath } = await fixture();
    setProcessEnvironment("HTTPS_PROXY", "http://current-host.example");
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTPS_PROXY: "http://settings-concrete.example",
        },
      }),
    );
    await writePrivateEnv(
      envPath,
      "GH_TOKEN=github-secret\nHTTPS_PROXY=\"${HTTPS_PROXY}\"\n",
    );

    const config = await loadSandcastleConfig({ settingsPath, envPath });

    expect(config.proxyEnvironment.HTTPS_PROXY).toBe(
      "http://current-host.example",
    );
  });

  it("keeps non-proxy references literal", async () => {
    const { settingsPath, envPath } = await fixture();
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "${ANTHROPIC_BASE_URL}",
          ANTHROPIC_AUTH_TOKEN: "${ANTHROPIC_AUTH_TOKEN}",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "${ANTHROPIC_DEFAULT_OPUS_MODEL}",
        },
      }),
    );
    await writePrivateEnv(
      envPath,
      [
        "GH_TOKEN=\"${GH_TOKEN}\"",
        "SANDCASTLE_MODEL=\"${SANDCASTLE_MODEL}\"",
        "",
      ].join("\n"),
    );

    const config = await loadSandcastleConfig({ settingsPath, envPath });

    expect(config.environment).toMatchObject({
      ANTHROPIC_BASE_URL: "${ANTHROPIC_BASE_URL}",
      ANTHROPIC_AUTH_TOKEN: "${ANTHROPIC_AUTH_TOKEN}",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "${ANTHROPIC_DEFAULT_OPUS_MODEL}",
      GH_TOKEN: "${GH_TOKEN}",
    });
    expect(config.models.default).toBe("${SANDCASTLE_MODEL}");
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

  it("fails before startup when provider authentication is missing without exposing secrets", async () => {
    const { settingsPath, envPath } = await fixture();
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456/token-in-url",
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");

    const error = await loadSandcastleConfig({ settingsPath, envPath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SandcastleConfigError);
    expect(String(error)).toContain("ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY");
    expect(String(error)).not.toContain("github-secret");
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

  it("fails a settings reference when its host variable is missing", async () => {
    const { settingsPath, envPath } = await fixture();
    setProcessEnvironment("HTTPS_PROXY", undefined);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTPS_PROXY: "${HTTPS_PROXY}",
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");

    const error = await loadSandcastleConfig({ settingsPath, envPath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SandcastleConfigError);
    expect(String(error)).toContain("HTTPS_PROXY");
    expect(String(error)).toContain("Claude Code user settings");
    expect(String(error)).toMatch(/missing/i);
    expect(String(error)).not.toContain("settings-secret");
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \t  "],
  ])("fails a winning private %s reference without falling back to settings", async (reason, hostValue) => {
    const { settingsPath, envPath } = await fixture();
    setProcessEnvironment("HTTP_PROXY", hostValue);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTP_PROXY: "http://settings-fallback.example/fallback-fragment",
        },
      }),
    );
    await writePrivateEnv(
      envPath,
      ["GH_TOKEN=github-secret", 'HTTP_PROXY="${HTTP_PROXY}"', ""].join("\n"),
    );

    const error = await loadSandcastleConfig({ settingsPath, envPath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SandcastleConfigError);
    expect(String(error)).toContain("HTTP_PROXY");
    expect(String(error)).toContain("Sandcastle private environment");
    expect(String(error)).toContain(reason);
    expect(String(error)).not.toContain("settings-fallback.example");
    expect(String(error)).not.toContain("fallback-fragment");
  });

  it.each([
    ["cross-key", "${HTTP_PROXY}"],
    ["arbitrary-name", "${OTHER}"],
    ["concatenated", "http://fictional.example/${HTTPS_PROXY}"],
    ["defaulted", "${HTTPS_PROXY:-http://fallback.example}"],
    ["nested", "${${HTTPS_PROXY}}"],
    ["reference-like", "prefix${not-closed"],
  ])("rejects a %s malformed private proxy reference without echoing it", async (_kind, configured) => {
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
      ["GH_TOKEN=github-secret", `HTTPS_PROXY="${configured}"`, ""].join("\n"),
    );

    const error = await loadSandcastleConfig({ settingsPath, envPath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SandcastleConfigError);
    expect(String(error)).toContain("HTTPS_PROXY");
    expect(String(error)).toContain("Sandcastle private environment");
    expect(String(error)).toMatch(/malformed/i);
    expect(String(error)).not.toContain(configured);
    expect(String(error)).not.toContain("fictional.example");
    expect(String(error)).not.toContain("fallback.example");
  });

  it("rejects an unbraced cross-key settings reference with safe braced guidance", async () => {
    const { settingsPath, envPath } = await fixture();
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTPS_PROXY: "$HTTP_PROXY",
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");

    const error = await loadSandcastleConfig({ settingsPath, envPath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SandcastleConfigError);
    expect(String(error)).toContain("HTTPS_PROXY");
    expect(String(error)).toContain("Claude Code user settings");
    expect(String(error)).toContain("${HTTPS_PROXY}");
    expect(String(error)).not.toContain("$HTTP_PROXY");
  });

  it("never falls back to a different-cased host variable", async () => {
    const { settingsPath, envPath } = await fixture();
    setProcessEnvironment("HTTPS_PROXY", "http://uppercase-only.example");
    setProcessEnvironment("https_proxy", undefined);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          https_proxy: "${https_proxy}",
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");

    const error = await loadSandcastleConfig({ settingsPath, envPath }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SandcastleConfigError);
    expect(String(error)).toContain("https_proxy");
    expect(String(error)).toMatch(/missing/i);
    expect(String(error)).not.toContain("uppercase-only.example");
  });

  it("rejects a malformed settings reference without leaking configured or host sentinels", async () => {
    const { settingsPath, envPath } = await fixture();
    setProcessEnvironment(
      "HTTPS_PROXY",
      "http://fictional-host-user:fictional-host-pass@fictional-host.example/secret-host-fragment",
    );
    setProcessEnvironment(
      "HTTP_PROXY",
      "http://fictional-other-user@fictional-other.example/other-fragment",
    );
    const messages: string[] = [];
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTPS_PROXY: "http://fictional-config-user:fictional-config-pass@fictional-proxy.example/secret-config-fragment/${HTTPS_PROXY}",
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");

    const error = await loadSandcastleConfig({
      settingsPath,
      envPath,
      log: (message) => messages.push(message),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandcastleConfigError);
    const diagnostic = String(error);
    expect(diagnostic).toContain("HTTPS_PROXY");
    expect(diagnostic).toContain("Claude Code user settings");
    assertNoSentinels(diagnostic, messages, [
      "fictional-config-user",
      "fictional-config-pass",
      "fictional-proxy.example",
      "secret-config-fragment",
      "fictional-host-user",
      "fictional-host-pass",
      "fictional-host.example",
      "secret-host-fragment",
      "fictional-other-user",
      "fictional-other.example",
      "other-fragment",
      "settings-secret",
      "github-secret",
    ]);
  });

  it("rejects a malformed private reference without leaking configured or host sentinels", async () => {
    const { settingsPath, envPath } = await fixture();
    setProcessEnvironment(
      "HTTPS_PROXY",
      "http://fictional-host-user:fictional-host-pass@fictional-host.example/secret-host-fragment",
    );
    const messages: string[] = [];
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
        'HTTPS_PROXY="http://fictional-config-user:fictional-config-pass@fictional-proxy.example/secret-config-fragment/${HTTPS_PROXY}"',
        "",
      ].join("\n"),
    );

    const error = await loadSandcastleConfig({
      settingsPath,
      envPath,
      log: (message) => messages.push(message),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandcastleConfigError);
    const diagnostic = String(error);
    expect(diagnostic).toContain("HTTPS_PROXY");
    expect(diagnostic).toContain("Sandcastle private environment");
    assertNoSentinels(diagnostic, messages, [
      "fictional-config-user",
      "fictional-config-pass",
      "fictional-proxy.example",
      "secret-config-fragment",
      "fictional-host-user",
      "fictional-host-pass",
      "fictional-host.example",
      "secret-host-fragment",
      "settings-secret",
      "github-secret",
    ]);
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

  it("keeps success logs count-only when proxy references are resolved", async () => {
    const { settingsPath, envPath } = await fixture();
    const resolved =
      "http://fictional-host-user:fictional-host-pass@fictional-host.example/secret-host-fragment";
    setProcessEnvironment("HTTPS_PROXY", resolved);
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "settings-secret",
          HTTPS_PROXY: "${HTTPS_PROXY}",
        },
      }),
    );
    await writePrivateEnv(envPath, "GH_TOKEN=github-secret\n");
    const messages: string[] = [];

    const config = await loadSandcastleConfig({
      settingsPath,
      envPath,
      log: (message) => messages.push(message),
    });

    expect(config.environment.HTTPS_PROXY).toBe(resolved);
    expect(messages).toEqual([
      "Loaded Sandcastle private configuration (4 environment variables; 0 role model overrides)",
    ]);
    expect(messages.join(" ")).not.toContain(resolved);
    expect(messages.join(" ")).not.toContain("fictional-host-user");
    expect(messages.join(" ")).not.toContain("fictional-host-pass");
    expect(messages.join(" ")).not.toContain("secret-host-fragment");
    expect(messages.join(" ")).not.toContain("settings-secret");
  });
});
