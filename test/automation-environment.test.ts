import { describe, expect, it } from "vitest";

import { createChildEnvironments } from "../.sandcastle/automation-environment.js";

describe("automation child environments", () => {
  it("gives every subprocess only the configuration required for its purpose", () => {
    const environments = createChildEnvironments({
      ANTHROPIC_BASE_URL: "https://cc-switch.example",
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      GH_TOKEN: "github-secret",
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
    expect(Object.keys(environments.claude)).not.toContain("PATH");
    expect(Object.keys(environments.claude)).not.toContain("HOME");
  });
});
