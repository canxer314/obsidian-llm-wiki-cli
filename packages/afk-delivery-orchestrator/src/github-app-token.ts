import { createSign } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface GitHubAppTokenConfig {
  appId: string;
  installationId: number;
  repository: string;
  privateKey: string;
}

export interface GitHubAppTokenResult {
  token: string;
  expiresAt: string;
  actorLogin: string;
  actorType: "Bot";
}

interface GitHubAppTokenDependencies {
  expectedRepository?: string;
  now?: () => Date;
  request?: typeof fetch;
}

interface GitHubAppFileConfig {
  appId: string;
  installationId: number;
  repository: string;
  privateKeyFile: string;
}

async function restrictedFile(path: string): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error("GitHub App credential files must not be accessible by group or other users");
  }
}

export async function loadGitHubAppTokenConfig(
  path = process.env.AFK_GITHUB_APP_CONFIG ?? join(homedir(), ".config/afk-delivery/github-app.json"),
): Promise<GitHubAppTokenConfig> {
  const configPath = resolve(path);
  await restrictedFile(configPath);
  const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const value = parsed as Partial<GitHubAppFileConfig>;
  if (typeof value.appId !== "string" || typeof value.installationId !== "number" ||
      typeof value.repository !== "string" || typeof value.privateKeyFile !== "string") {
    throw new Error("GitHub App configuration is incomplete");
  }
  if (isAbsolute(value.privateKeyFile)) {
    throw new Error("GitHub App private key must use a path relative to the configuration file");
  }
  const configDirectory = await realpath(dirname(configPath));
  const privateKeyPath = await realpath(resolve(configDirectory, value.privateKeyFile));
  const privateKeyRelative = relative(configDirectory, privateKeyPath);
  if (privateKeyRelative === "" || privateKeyRelative.startsWith("..") || isAbsolute(privateKeyRelative)) {
    throw new Error("GitHub App private key must remain inside the configuration directory");
  }
  await restrictedFile(privateKeyPath);
  return {
    appId: value.appId,
    installationId: value.installationId,
    repository: value.repository,
    privateKey: await readFile(privateKeyPath, "utf8"),
  };
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function appJwt(config: GitHubAppTokenConfig, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: config.appId,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(config.privateKey).toString("base64url")}`;
}

function repositoryName(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))) {
    throw new Error("GitHub App repository must be configured as owner/repository");
  }
  return parts[1] as string;
}

export async function verifyGitHubInstallationToken(input: {
  token: string;
  repository: string;
  actorLogin: string;
}, request: typeof fetch = fetch): Promise<void> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${input.token}`,
    "x-github-api-version": "2026-03-10",
    "user-agent": "afk-delivery-worker",
  };
  const viewerResponse = await request("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ query: "query { viewer { login } }" }),
  });
  if (!viewerResponse.ok) {
    throw new Error(`GitHub credential identity request failed with status ${viewerResponse.status}`);
  }
  const viewer: unknown = await viewerResponse.json();
  if ((viewer as { data?: { viewer?: { login?: unknown } } }).data?.viewer?.login !== input.actorLogin) {
    throw new Error("GitHub credential is not the configured repository App identity");
  }

  const repositoriesResponse = await request("https://api.github.com/installation/repositories?per_page=100", { headers });
  if (!repositoriesResponse.ok) {
    throw new Error(`GitHub installation repositories request failed with status ${repositoriesResponse.status}`);
  }
  const value: unknown = await repositoriesResponse.json();
  if ((value as { repository_selection?: unknown }).repository_selection !== "selected") {
    throw new Error("GitHub App installation is not limited to selected repositories");
  }
  const repositories = (value as { repositories?: unknown }).repositories;
  if (!Array.isArray(repositories) || repositories.length !== 1 ||
      (repositories[0] as { full_name?: unknown }).full_name !== input.repository) {
    throw new Error("GitHub App installation is not limited to the configured repository");
  }
}

export async function issueGitHubAppToken(
  config: GitHubAppTokenConfig,
  dependencies: GitHubAppTokenDependencies = {},
): Promise<GitHubAppTokenResult> {
  if (!/^\d+$/u.test(config.appId) || !Number.isSafeInteger(config.installationId) || config.installationId <= 0) {
    throw new Error("GitHub App id and installation id must be positive integers");
  }
  if (dependencies.expectedRepository !== undefined && config.repository !== dependencies.expectedRepository) {
    throw new Error("GitHub App installation is not configured for this repository");
  }
  repositoryName(config.repository);
  const request = dependencies.request ?? fetch;
  const jwt = appJwt(config, (dependencies.now ?? (() => new Date()))());
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${jwt}`,
    "x-github-api-version": "2026-03-10",
    "user-agent": "afk-delivery-worker",
  };
  const appResponse = await request("https://api.github.com/app", { headers });
  if (!appResponse.ok) {
    throw new Error(`GitHub App identity request failed with status ${appResponse.status}`);
  }
  const app: unknown = await appResponse.json();
  const id = (app as { id?: unknown }).id;
  const slug = (app as { slug?: unknown }).slug;
  if (String(id) !== config.appId || typeof slug !== "string" || !/^[A-Za-z0-9-]+$/u.test(slug)) {
    throw new Error("GitHub App identity does not match the configured App id");
  }
  const installationResponse = await request(
    `https://api.github.com/app/installations/${config.installationId}`,
    { headers },
  );
  if (!installationResponse.ok) {
    throw new Error(`GitHub App installation request failed with status ${installationResponse.status}`);
  }
  const installation: unknown = await installationResponse.json();
  if ((installation as { repository_selection?: unknown }).repository_selection !== "selected") {
    throw new Error("GitHub App installation must be limited to selected repositories");
  }
  const response = await request(
    `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub App token request failed with status ${response.status}`);
  }
  const value: unknown = await response.json();
  const token = (value as { token?: unknown }).token;
  const expiresAt = (value as { expires_at?: unknown }).expires_at;
  if (typeof token !== "string" || token.length === 0 || typeof expiresAt !== "string" || expiresAt.length === 0) {
    throw new Error("GitHub App token response was incomplete");
  }
  const actorLogin = `${slug}[bot]`;
  await verifyGitHubInstallationToken({
    token,
    repository: config.repository,
    actorLogin,
  }, request);
  return { token, expiresAt, actorLogin, actorType: "Bot" };
}
