import { generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueGitHubAppToken,
  loadGitHubAppTokenConfig,
} from "../src/github-app-token.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function signingMaterial() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

const appResponse = () => new Response(JSON.stringify({
  id: 12345,
  slug: "afk-delivery-canary",
}), { status: 200, headers: { "content-type": "application/json" } });

const tokenResponse = (token: string) => new Response(JSON.stringify({
  token,
  expires_at: "2026-08-16T15:00:00Z",
}), { status: 201, headers: { "content-type": "application/json" } });

describe("GitHub App installation token", () => {
  it("signs a fresh App JWT and limits every token request to the configured repository", async () => {
    const keys = signingMaterial();
    const request = vi.fn()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(tokenResponse("installation-token-one"))
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(tokenResponse("installation-token-two"));
    const config = {
      appId: "12345",
      installationId: 67890,
      repository: "canxer314/obsidian-llm-wiki-cli",
      privateKey: keys.privateKey,
    };

    const first = await issueGitHubAppToken(config, {
      now: () => new Date("2026-08-16T14:00:00Z"),
      request,
    });
    const second = await issueGitHubAppToken(config, {
      now: () => new Date("2026-08-16T14:01:00Z"),
      request,
    });

    expect(first).toEqual({
      token: "installation-token-one",
      expiresAt: "2026-08-16T15:00:00Z",
      actorLogin: "afk-delivery-canary[bot]",
      actorType: "Bot",
    });
    expect(second).toEqual({
      token: "installation-token-two",
      expiresAt: "2026-08-16T15:00:00Z",
      actorLogin: "afk-delivery-canary[bot]",
      actorType: "Bot",
    });
    expect(request).toHaveBeenCalledTimes(4);
    const tokenCalls = request.mock.calls.filter(([url]) => String(url).includes("/access_tokens")) as Array<[string, RequestInit]>;
    expect(tokenCalls).toHaveLength(2);
    for (const [url, init] of tokenCalls) {
      expect(url).toBe("https://api.github.com/app/installations/67890/access_tokens");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ repositories: ["obsidian-llm-wiki-cli"] });
      const authorization = new Headers(init.headers).get("authorization");
      const jwt = authorization?.replace("Bearer ", "") ?? "";
      const [header, payload, signature] = jwt.split(".");
      expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"))).toMatchObject({
        iss: "12345",
      });
      expect(verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        keys.publicKey,
        Buffer.from(signature ?? "", "base64url"),
      )).toBe(true);
    }
    expect(new Headers(tokenCalls[0]?.[1].headers).get("authorization"))
      .not.toBe(new Headers(tokenCalls[1]?.[1].headers).get("authorization"));
  });

  it("fails closed without disclosing signing material or token-shaped response fields", async () => {
    const keys = signingMaterial();
    const leakedToken = "ghs_should-never-appear";
    const request = vi.fn()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValue(new Response(JSON.stringify({
      message: `invalid key ${keys.privateKey}`,
      token: leakedToken,
    }), { status: 403, headers: { "content-type": "application/json" } }));

    await expect(issueGitHubAppToken({
      appId: "12345",
      installationId: 67890,
      repository: "canxer314/obsidian-llm-wiki-cli",
      privateKey: keys.privateKey,
    }, {
      now: () => new Date("2026-08-16T14:00:00Z"),
      request,
    })).rejects.toThrow("GitHub App token request failed with status 403");

    try {
      await issueGitHubAppToken({
        appId: "12345",
        installationId: 67890,
        repository: "canxer314/obsidian-llm-wiki-cli",
        privateKey: keys.privateKey,
      }, {
        now: () => new Date("2026-08-16T14:00:00Z"),
        request,
      });
    } catch (error) {
      const diagnostic = String(error);
      expect(diagnostic).not.toContain(keys.privateKey);
      expect(diagnostic).not.toContain(leakedToken);
    }
  });

  it("rejects credential files readable by group or other users", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-app-token-"));
    temporaryDirectories.push(directory);
    const privateKeyFile = join(directory, "private-key.pem");
    const configFile = join(directory, "github-app.json");
    await writeFile(privateKeyFile, signingMaterial().privateKey, { mode: 0o600 });
    await writeFile(configFile, JSON.stringify({
      appId: "12345",
      installationId: 67890,
      repository: "canxer314/obsidian-llm-wiki-cli",
      privateKeyFile: "private-key.pem",
    }), { mode: 0o644 });

    await expect(loadGitHubAppTokenConfig(configFile)).rejects.toThrow(
      "GitHub App credential files must not be accessible by group or other users",
    );

    await chmod(configFile, 0o600);
    await chmod(privateKeyFile, 0o640);
    await expect(loadGitHubAppTokenConfig(configFile)).rejects.toThrow(
      "GitHub App credential files must not be accessible by group or other users",
    );
  });

  it("rejects malformed or mismatched repository configuration before requesting a token", async () => {
    const keys = signingMaterial();
    const request = vi.fn();

    await expect(issueGitHubAppToken({
      appId: "12345",
      installationId: 67890,
      repository: "other-owner/other-repository",
      privateKey: keys.privateKey,
    }, {
      expectedRepository: "canxer314/obsidian-llm-wiki-cli",
      now: () => new Date("2026-08-16T14:00:00Z"),
      request,
    })).rejects.toThrow("GitHub App installation is not configured for this repository");
    expect(request).not.toHaveBeenCalled();
  });
});
