import { describe, expect, it } from "vitest";

import { createChildEnvironments } from "../.sandcastle/automation-environment.js";

describe("automation child environments", () => {
  it("gives every subprocess only the configuration required for its purpose", () => {
    const environments = createChildEnvironments({
      ANTHROPIC_BASE_URL: "https://cc-switch.example",
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      GH_TOKEN: "github-secret",
      GIT_AUTHOR_NAME: "canxer",
      GIT_AUTHOR_EMAIL: "canxer314@live.com",
      GIT_COMMITTER_NAME: "canxer",
      GIT_COMMITTER_EMAIL: "canxer314@live.com",
      HTTP_PROXY: "http://uppercase-http.example",
      HTTPS_PROXY: "http://uppercase-https.example",
      NO_PROXY: "uppercase-no-proxy.example",
      http_proxy: "http://lowercase-http.example",
      https_proxy: "http://lowercase-https.example",
      no_proxy: "lowercase-no-proxy.example",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/custom-ca.pem",
      PATH: "/host/bin",
      HOME: "/host/home",
    });

    expect(environments.dependencies).toEqual({
      HOME: "/host/home",
      HTTP_PROXY: "http://uppercase-http.example",
      HTTPS_PROXY: "http://uppercase-https.example",
      NO_PROXY: "uppercase-no-proxy.example",
      http_proxy: "http://lowercase-http.example",
      https_proxy: "http://lowercase-https.example",
      no_proxy: "lowercase-no-proxy.example",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/custom-ca.pem",
      PATH: "/host/bin",
    });
    expect(environments.git).toEqual({
      HOME: "/host/home",
      HTTP_PROXY: "http://uppercase-http.example",
      HTTPS_PROXY: "http://uppercase-https.example",
      NO_PROXY: "uppercase-no-proxy.example",
      http_proxy: "http://lowercase-http.example",
      https_proxy: "http://lowercase-https.example",
      no_proxy: "lowercase-no-proxy.example",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/custom-ca.pem",
      PATH: "/host/bin",
    });
    expect(environments.github).toEqual({
      GH_TOKEN: "github-secret",
      HTTP_PROXY: "http://uppercase-http.example",
      HTTPS_PROXY: "http://uppercase-https.example",
      NO_PROXY: "uppercase-no-proxy.example",
      http_proxy: "http://lowercase-http.example",
      https_proxy: "http://lowercase-https.example",
      no_proxy: "lowercase-no-proxy.example",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/custom-ca.pem",
      PATH: "/host/bin",
    });
    expect(environments.claude).toEqual({
      ANTHROPIC_BASE_URL: "https://cc-switch.example",
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      HTTP_PROXY: "http://uppercase-http.example",
      HTTPS_PROXY: "http://uppercase-https.example",
      NO_PROXY: "uppercase-no-proxy.example",
      http_proxy: "http://lowercase-http.example",
      https_proxy: "http://lowercase-https.example",
      no_proxy: "lowercase-no-proxy.example",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/custom-ca.pem",
    });
    expect(environments.githubAgent).toEqual({
      ANTHROPIC_BASE_URL: "https://cc-switch.example",
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      GH_TOKEN: "github-secret",
      GIT_AUTHOR_NAME: "canxer",
      GIT_AUTHOR_EMAIL: "canxer314@live.com",
      GIT_COMMITTER_NAME: "canxer",
      GIT_COMMITTER_EMAIL: "canxer314@live.com",
      HTTP_PROXY: "http://uppercase-http.example",
      HTTPS_PROXY: "http://uppercase-https.example",
      NO_PROXY: "uppercase-no-proxy.example",
      http_proxy: "http://lowercase-http.example",
      https_proxy: "http://lowercase-https.example",
      no_proxy: "lowercase-no-proxy.example",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/custom-ca.pem",
    });
    expect(Object.keys(environments.claude)).not.toContain("PATH");
    expect(Object.keys(environments.claude)).not.toContain("HOME");
    expect(Object.keys(environments.githubAgent)).not.toContain("PATH");
    expect(Object.keys(environments.githubAgent)).not.toContain("HOME");
    // The git identity reaches only the container Agent environment; the host
    // git processes already read user.name/user.email from the host HOME.
    expect(environments.github).not.toHaveProperty("GIT_AUTHOR_NAME");
    expect(environments.github).not.toHaveProperty("GIT_COMMITTER_EMAIL");
  });

  it("injects the operator git identity into the GitHub-capable Agent environment", () => {
    const environments = createChildEnvironments({
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      GH_TOKEN: "github-secret",
      GIT_AUTHOR_NAME: "operator",
      GIT_AUTHOR_EMAIL: "operator@example.test",
      GIT_COMMITTER_NAME: "operator",
      GIT_COMMITTER_EMAIL: "operator@example.test",
      PRIVATE_OPERATOR_TOKEN: "private-operator",
    });

    expect(environments.githubAgent).toEqual({
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      GH_TOKEN: "github-secret",
      GIT_AUTHOR_NAME: "operator",
      GIT_AUTHOR_EMAIL: "operator@example.test",
      GIT_COMMITTER_NAME: "operator",
      GIT_COMMITTER_EMAIL: "operator@example.test",
    });
  });

  it("excludes unknown, private, and Dispatcher model-routing variables from the GitHub-capable Agent environment", () => {
    const environments = createChildEnvironments({
      ANTHROPIC_BASE_URL: "https://cc-switch.example",
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      GH_TOKEN: "github-secret",
      SANDCASTLE_DEFAULT_MODEL: "claude-routed-default",
      SANDCASTLE_PLANNER_MODEL: "claude-routed-planner",
      SANDCASTLE_IMPLEMENTER_MODEL: "claude-routed-implementer",
      SANDCASTLE_REVIEWER_MODEL: "claude-routed-reviewer",
      PRIVATE_OPERATOR_TOKEN: "private-operator",
      UNKNOWN_CONFIG_VALUE: "unknown",
      GITHUB_PRIVATE_PAT: "private-pat",
      PATH: "/host/bin",
      HOME: "/host/home",
    });

    expect(environments.githubAgent).toEqual({
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      ANTHROPIC_BASE_URL: "https://cc-switch.example",
      GH_TOKEN: "github-secret",
    });
  });
});
