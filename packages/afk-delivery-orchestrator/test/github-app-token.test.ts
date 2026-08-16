import { generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueGitHubAppToken,
  loadGitHubAppTokenConfig,
  verifyGitHubInstallationToken,
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

async function rejectionMessage(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject");
}

const appResponse = () => new Response(JSON.stringify({
  id: 12345,
  slug: "afk-delivery-canary",
}), { status: 200, headers: { "content-type": "application/json" } });

const installationResponse = (selection = "selected") => new Response(JSON.stringify({
  id: 67890,
  repository_selection: selection,
}), { status: 200, headers: { "content-type": "application/json" } });

const tokenResponse = (token: string) => new Response(JSON.stringify({
  token,
  expires_at: "2026-08-16T15:00:00Z",
}), { status: 201, headers: { "content-type": "application/json" } });

describe("GitHub App installation token", () => {
  it("signs a fresh App JWT and verifies every full installation token against the configured repository", async () => {
    const keys = signingMaterial();
    const viewerResponse = () => new Response(JSON.stringify({
      data: { viewer: { login: "afk-delivery-canary[bot]" } },
    }), { status: 200 });
    const repositoriesResponse = () => new Response(JSON.stringify({
      repository_selection: "selected",
      repositories: [{ full_name: "canxer314/obsidian-llm-wiki-cli" }],
    }), { status: 200 });
    const request = vi.fn()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(tokenResponse("installation-token-one"))
      .mockResolvedValueOnce(viewerResponse())
      .mockResolvedValueOnce(repositoriesResponse())
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(tokenResponse("installation-token-two"))
      .mockResolvedValueOnce(viewerResponse())
      .mockResolvedValueOnce(repositoriesResponse());
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
    expect(request).toHaveBeenCalledTimes(10);
    const tokenCalls = request.mock.calls.filter(([url]) => String(url).includes("/access_tokens")) as Array<[string, RequestInit]>;
    expect(tokenCalls).toHaveLength(2);
    for (const [url, init] of tokenCalls) {
      expect(url).toBe("https://api.github.com/app/installations/67890/access_tokens");
      expect(init.method).toBe("POST");
      expect(init.body).toBeUndefined();
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

  it("rejects a token issued from an App installation that includes another repository", async () => {
    const keys = signingMaterial();
    const request = vi.fn()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(installationResponse())
      .mockResolvedValueOnce(tokenResponse("installation-token"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { viewer: { login: "afk-delivery-canary[bot]" } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        repository_selection: "selected",
        repositories: [
          { full_name: "canxer314/obsidian-llm-wiki-cli" },
          { full_name: "canxer314/other" },
        ],
      }), { status: 200 }));

    await expect(issueGitHubAppToken({
      appId: "12345",
      installationId: 67890,
      repository: "canxer314/obsidian-llm-wiki-cli",
      privateKey: keys.privateKey,
    }, {
      now: () => new Date("2026-08-16T14:00:00Z"),
      request,
    })).rejects.toThrow("GitHub App installation is not limited to the configured repository");
  });

  it("fails closed without disclosing signing material or token-shaped response fields", async () => {
    const keys = signingMaterial();
    const leakedToken = "ghs_should-never-appear";
    const request = vi.fn()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(installationResponse())
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

  it("verifies the installation token actor, selected scope, and single configured repository", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { viewer: { login: "afk-delivery-canary[bot]" } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        repository_selection: "selected",
        repositories: [{ full_name: "canxer314/obsidian-llm-wiki-cli" }],
      }), { status: 200 }));

    await expect(verifyGitHubInstallationToken({
      token: "installation-token",
      repository: "canxer314/obsidian-llm-wiki-cli",
      actorLogin: "afk-delivery-canary[bot]",
    }, request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/graphql",
      expect.objectContaining({ method: "POST" }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/installation/repositories?per_page=100",
      expect.any(Object),
    );
  });

  it("rejects an installation token whose viewer is not the configured App actor", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { viewer: { login: "another-app[bot]" } },
      }), { status: 200 }));

    await expect(verifyGitHubInstallationToken({
      token: "installation-token",
      repository: "canxer314/obsidian-llm-wiki-cli",
      actorLogin: "afk-delivery-canary[bot]",
    }, request)).rejects.toThrow("GitHub credential is not the configured repository App identity");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects an installation token that can access more than the configured repository", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { viewer: { login: "afk-delivery-canary[bot]" } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        repository_selection: "selected",
        repositories: [
          { full_name: "canxer314/obsidian-llm-wiki-cli" },
          { full_name: "canxer314/other" },
        ],
      }), { status: 200 }));

    await expect(verifyGitHubInstallationToken({
      token: "installation-token",
      repository: "canxer314/obsidian-llm-wiki-cli",
      actorLogin: "afk-delivery-canary[bot]",
    }, request)).rejects.toThrow("GitHub App installation is not limited to the configured repository");
  });

  it("rejects a token whose installation is not limited to selected repositories", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { viewer: { login: "afk-delivery-canary[bot]" } },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        repository_selection: "all",
        repositories: [{ full_name: "canxer314/obsidian-llm-wiki-cli" }],
      }), { status: 200 }));

    await expect(verifyGitHubInstallationToken({
      token: "installation-token",
      repository: "canxer314/obsidian-llm-wiki-cli",
      actorLogin: "afk-delivery-canary[bot]",
    }, request)).rejects.toThrow("GitHub App installation is not limited to selected repositories");
  });

  it("rejects an App installation that is not repository-scoped", async () => {
    const keys = signingMaterial();
    const request = vi.fn()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(installationResponse("all"));

    await expect(issueGitHubAppToken({
      appId: "12345",
      installationId: 67890,
      repository: "canxer314/obsidian-llm-wiki-cli",
      privateKey: keys.privateKey,
    }, {
      now: () => new Date("2026-08-16T14:00:00Z"),
      request,
    })).rejects.toThrow("GitHub App installation must be limited to selected repositories");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects absolute, parent, and symlink private key paths outside the config directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "afk-app-token-path-"));
    temporaryDirectories.push(parent);
    const directory = join(parent, "config");
    await mkdir(directory);
    const outsideKey = join(parent, "private-key.pem");
    const configFile = join(directory, "github-app.json");
    await writeFile(outsideKey, signingMaterial().privateKey, { mode: 0o600 });

    const base = { appId: "12345", installationId: 67890, repository: "canxer314/obsidian-llm-wiki-cli" };
    await writeFile(configFile, JSON.stringify({ ...base, privateKeyFile: outsideKey }), { mode: 0o600 });
    await expect(loadGitHubAppTokenConfig(configFile)).rejects.toThrow(
      "GitHub App private key must use a path relative to the configuration file",
    );

    await writeFile(configFile, JSON.stringify({ ...base, privateKeyFile: "../private-key.pem" }), { mode: 0o600 });
    await expect(loadGitHubAppTokenConfig(configFile)).rejects.toThrow(
      "GitHub App private key must remain inside the configuration directory",
    );

    await symlink(outsideKey, join(directory, "linked-key.pem"));
    await writeFile(configFile, JSON.stringify({ ...base, privateKeyFile: "linked-key.pem" }), { mode: 0o600 });
    await expect(loadGitHubAppTokenConfig(configFile)).rejects.toThrow(
      "GitHub App private key must remain inside the configuration directory",
    );
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
    await chmod(configFile, 0o644);

    expect(await rejectionMessage(() => loadGitHubAppTokenConfig(configFile))).toBe(
      "GitHub App credential files must not be accessible by group or other users",
    );

    await chmod(configFile, 0o600);
    await chmod(privateKeyFile, 0o640);
    expect(await rejectionMessage(() => loadGitHubAppTokenConfig(configFile))).toBe(
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
